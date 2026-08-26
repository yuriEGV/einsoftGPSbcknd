import express from 'express';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import PersonTracker from '../models/PersonTracker.js';
import User from '../models/User.js';
import Company from '../models/Company.js';
import Geofence from '../models/Geofence.js';
import SensorData from '../models/SensorData.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getVehicleScope } from '../middleware/scope.js';
import { broadcastVehicleUpdate } from '../socket/index.js';
import { resolveCity } from './sensors.js';

const router = express.Router();

// Re-export for use in other routes (reports, etc.)
export { getVehicleScope as buildVehicleFilter };

// ─── GET /vehicles — Listar vehículos según scope del rol ─────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const filter = getVehicleScope(req.user);
    const now = new Date();

    const vehicles = await Vehicle.find(filter)
      .populate('driver', 'name email phone')
      .populate('assignedPerson', 'name phone trackerCode deviceId')
      .populate('company', 'name')
      .sort({ lastUpdate: -1 });

    const processed = vehicles.map(v => {
      const obj = v.toObject();
      const lastUpdate = v.lastUpdate || v.location?.timestamp;
      if (lastUpdate && (now - new Date(lastUpdate)) > 15 * 60 * 1000) {
        obj.status = 'offline';
      }
      return obj;
    });

    res.json(processed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /vehicles/:id — Detalle de un vehículo ───────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter)
      .populate('driver', 'name email phone')
      .populate('assignedPerson', 'name phone trackerCode deviceId')
      .populate('company', 'name')
      .populate('geofences');

    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    const latestSensorData = await SensorData.findOne({ vehicle: vehicle._id }).sort({ timestamp: -1 });
    res.json({ ...vehicle.toObject(), latestSensorData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /vehicles — Crear vehículo (admin, fleet_manager, independent) ─────
router.post('/', authenticate, requirePermission('vehicles.create'), async (req, res) => {
  try {
    const { companyId, ...vehicleData } = req.body;
    const vehicle = new Vehicle({
      ...vehicleData,
      company: req.user.company || (req.user.role === 'admin' ? companyId : undefined) || undefined,
      owner: req.user.id,
    });
    await vehicle.save();
    res.status(201).json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /vehicles/:id — Editar vehículo (admin, fleet_manager, independent) ─
router.put('/:id', authenticate, requirePermission('vehicles.create'), async (req, res) => {
  try {
    const { companyId, ...updateData } = req.body;
    const filter = getVehicleScope(req.user, req.params.id);

    if (req.user.role === 'admin' && companyId) {
      updateData.company = companyId;
    }

    const vehicle = await Vehicle.findOneAndUpdate(filter, updateData, { new: true })
      .populate('driver', 'name email phone')
      .populate('assignedPerson', 'name phone trackerCode deviceId');
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });
    res.json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /vehicles/:id — Eliminar vehículo (admin, fleet_manager, independent) ─
router.delete('/:id', authenticate, requirePermission('vehicles.create'), async (req, res) => {
  try {
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOneAndDelete(filter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    await SensorData.deleteMany({ vehicle: req.params.id });
    res.json({ message: 'Vehículo eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /vehicles/:id/link-device — Vincular IMEI/SIM y Conductor/Persona ─
router.post('/:id/link-device', authenticate, requirePermission('vehicles.create'), async (req, res) => {
  try {
    const { deviceIMEI, simCardNumber, deviceModel, driverId, personTrackerId } = req.body;
    if (!deviceIMEI) return res.status(400).json({ error: 'deviceIMEI es requerido' });

    const filter = getVehicleScope(req.user, req.params.id);
    const checkVehicle = await Vehicle.findOne(filter);
    if (!checkVehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    // Desasignar IMEI de cualquier otro vehículo
    await Vehicle.updateMany({ deviceIMEI, _id: { $ne: req.params.id } }, { $unset: { deviceIMEI: 1 } });

    const updateData = { deviceIMEI, simCardNumber, deviceModel };
    if (driverId !== undefined) updateData.driver = driverId || null;
    if (personTrackerId !== undefined) updateData.assignedPerson = personTrackerId || null;

    const vehicle = await Vehicle.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .populate('driver', 'name email phone')
      .populate('assignedPerson', 'name phone trackerCode deviceId');

    // Also link back on PersonTracker if personTrackerId was assigned
    if (personTrackerId) {
      const PersonTracker = (await import('../models/PersonTracker.js')).default;
      await PersonTracker.findByIdAndUpdate(personTrackerId, { assignedVehicle: vehicle._id });
    }

    res.json({ message: 'Dispositivo y asignación vinculados correctamente', vehicle });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /vehicles/:id/history — Historial de ruta ───────────────────────────
router.get('/:id/history', authenticate, async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const history = await SensorData.find({
      vehicle: req.params.id,
      timestamp: { $gte: startTime },
    }).select('gps timestamp speed').sort({ timestamp: 1 });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /vehicles/:id/stats — Estadísticas del vehículo ─────────────────────
router.get('/:id/stats', authenticate, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    let vehicleObjectId;
    try {
      vehicleObjectId = new mongoose.Types.ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'ID de vehículo inválido' });
    }

    const data = await SensorData.aggregate([
      { $match: { vehicle: vehicleObjectId, timestamp: { $gte: startTime } } },
      {
        $group: {
          _id: null,
          avgSpeed: { $avg: '$gps.speed' },
          maxSpeed: { $max: '$gps.speed' },
          dataPoints: { $sum: 1 },
          hardBrakings: { $sum: { $cond: [{ $gt: ['$accelerometer.x', 0.8] }, 1, 0] } },
          hardAccelerations: { $sum: { $cond: [{ $lt: ['$accelerometer.x', -0.8] }, 1, 0] } },
          avgFuelLevel: { $avg: '$fuel.level' },
          avgEngineTemp: { $avg: '$temperature.ambient' },
          drivingDurationMinutes: { $sum: { $cond: [{ $gt: ['$gps.speed', 0] }, 1, 0] } },
        },
      },
    ]);

    const stats = data[0] || {};
    if (stats.avgSpeed && stats.dataPoints) {
      stats.estimatedDistanceKm = Math.round(stats.avgSpeed * stats.dataPoints * 10 / 3600);
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /vehicles/:id/motor-cut — Cortacorriente (admin, fleet_manager) ────
router.post('/:id/motor-cut', authenticate, requirePermission('vehicles.update'), async (req, res) => {
  try {
    const { activate, rules } = req.body;
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    vehicle.motorCutStatus = activate;
    if (rules) vehicle.motorCutRules = rules;
    await vehicle.save();

    const Alert = mongoose.model('Alert');
    await Alert.create({
      vehicle: vehicle._id,
      company: vehicle.company,
      type: 'security',
      severity: 'high',
      message: `Cortacorriente ${activate ? 'ACTIVADO' : 'DESACTIVADO'} por el gestor`,
      location: vehicle.location,
    });

    broadcastVehicleUpdate(req.io, req.params.id, { motorCutStatus: activate, action: 'motor_cut_command' });
    res.json({ message: activate ? 'Motor bloqueado' : 'Motor restablecido', vehicle });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /vehicles/:id/microphone — Micrófono espía (admin, fleet_manager) ──
router.post('/:id/microphone', authenticate, requirePermission('vehicles.update'), async (req, res) => {
  try {
    const { activate } = req.body;
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    broadcastVehicleUpdate(req.io, req.params.id, { microphoneStatus: activate, action: 'mic_command' });
    res.json({ message: `Micrófono ${activate ? 'activado' : 'desactivado'}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /vehicles/:id/reset-location — Limpiar ubicación obsoleta ──────────
// Permite limpiar coordenadas viejas de la DB cuando un vehículo muestra
// una ubicación incorrecta heredada de otro dispositivo o de datos de prueba.
router.post('/:id/reset-location', authenticate, requirePermission('vehicles.create'), async (req, res) => {
  try {
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOneAndUpdate(
      filter,
      {
        $set: {
          location: {
            type: 'Point',
            coordinates: [0, 0],
            address: 'Esperando primer reporte GPS',
            city: 'Valparaíso',
            country: 'Chile',
            timestamp: null,
          },
          speed: 0,
          'sensors.fuel': null,
          status: 'offline',
        },
      },
      { new: true }
    );
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    // Clear old sensor history so previous position data is purged
    await SensorData.deleteMany({ vehicle: req.params.id });

    res.json({ message: 'Ubicación y datos de sensores reiniciados correctamente', vehicle });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /vehicles/:id/set-location — Actualizar ubicación manualmente ──────
router.post('/:id/set-location', authenticate, requirePermission('vehicles.create'), async (req, res) => {
  try {
    const { latitude, longitude, address: customAddress, city: customCity } = req.body;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Latitud y longitud son requeridas' });
    }

    const resolved = resolveCity(latitude, longitude);
    const filter = getVehicleScope(req.user, req.params.id);
    const vehicle = await Vehicle.findOneAndUpdate(
      filter,
      {
        $set: {
          location: {
            type: 'Point',
            coordinates: [longitude, latitude],
            address: customAddress || resolved.address,
            city: customCity || resolved.city,
            country: 'Chile',
            timestamp: new Date(),
          },
          status: 'active',
          lastUpdate: new Date(),
        },
      },
      { new: true }
    );
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    // Record in SensorData history
    await SensorData.create({
      deviceIMEI: vehicle.deviceIMEI || 'MANUAL',
      vehicle: vehicle._id,
      gps: { latitude, longitude, speed: 0, heading: 0 },
      timestamp: new Date(),
    });

    res.json({ message: 'Ubicación actualizada correctamente', vehicle });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;


