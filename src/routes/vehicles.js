import express from 'express';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import SensorData from '../models/SensorData.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { broadcastVehicleUpdate } from '../socket/index.js';

const router = express.Router();

// Helper: Build query filter based on user role and company/owner
export function buildVehicleFilter(user, vehicleId = null) {
  let filter = vehicleId ? { _id: vehicleId } : {};
  if (user.role === 'admin') {
    return filter; // Admin sees all
  }
  if (user.role === 'independent' || !user.company) {
    // Independent / Personal user: can ONLY see vehicles where owner == user.id OR driver == user.id
    return {
      ...filter,
      $or: [
        { owner: user.id },
        { driver: user.id },
      ],
    };
  }
  // Corporate Company users
  filter.company = user.company;
  if (user.role === 'driver') {
    filter.driver = user.id;
  }
  return filter;
}

// Get all vehicles (Admin: all, Company users: by company, Independent: by owner/driver)
router.get('/', authenticate, async (req, res) => {
  try {
    const filter = buildVehicleFilter(req.user);
    const now = new Date();
    const vehicles = await Vehicle.find(filter)
      .populate('driver', 'name email phone')
      .populate('company', 'name')
      .sort({ lastUpdate: -1 });

    // Dynamic status update for offline vehicles (15 min threshold for Smart Tags & GPS)
    const processedVehicles = vehicles.map(v => {
      const obj = v.toObject();
      const lastUpdate = v.lastUpdate || v.location?.timestamp;
      if (lastUpdate && (now - new Date(lastUpdate)) > 15 * 60 * 1000) {
        obj.status = 'offline';
      }
      return obj;
    });

    res.json(processedVehicles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get vehicle by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const filter = buildVehicleFilter(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter)
      .populate('driver', 'name email phone')
      .populate('company', 'name')
      .populate('geofences');

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehículo no encontrado o no autorizado' });
    }

    const latestSensorData = await SensorData.findOne({
      vehicle: vehicle._id,
    }).sort({ timestamp: -1 });

    res.json({
      ...vehicle.toObject(),
      latestSensorData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create vehicle (Admin, FleetManager, Independent, Driver)
router.post('/', authenticate, authorize('admin', 'fleet_manager', 'independent', 'driver'), async (req, res) => {
  try {
    const { companyId, ...vehicleData } = req.body;
    const vehicle = new Vehicle({
      ...vehicleData,
      company: req.user.company || companyId || undefined,
      owner: req.user.id,
    });

    await vehicle.save();
    res.status(201).json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update vehicle (Admin, FleetManager, Independent, Driver)
router.put('/:id', authenticate, authorize('admin', 'fleet_manager', 'independent', 'driver'), async (req, res) => {
  try {
    const { companyId, ...updateData } = req.body;
    const filter = buildVehicleFilter(req.user, req.params.id);

    if (req.user.role === 'admin' && companyId) {
      updateData.company = companyId;
    }

    const vehicle = await Vehicle.findOneAndUpdate(filter, updateData, { new: true });

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehículo no encontrado o no autorizado' });
    }

    res.json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vincular / actualizar dispositivo (IMEI, SIM, Modelo) al vehículo
router.post('/:id/link-device', authenticate, authorize('admin', 'fleet_manager', 'independent', 'driver'), async (req, res) => {
  try {
    const { deviceIMEI, simCardNumber, deviceModel, driverId } = req.body;

    if (!deviceIMEI) {
      return res.status(400).json({ error: 'deviceIMEI es requerido' });
    }

    const filter = buildVehicleFilter(req.user, req.params.id);
    const checkVehicle = await Vehicle.findOne(filter);
    if (!checkVehicle) {
      return res.status(404).json({ error: 'Vehículo no encontrado o no autorizado' });
    }

    // Asegurar que un IMEI no quede en dos vehículos
    await Vehicle.updateMany(
      { deviceIMEI, _id: { $ne: req.params.id } },
      { $unset: { deviceIMEI: 1 } },
    );

    const updateData = { deviceIMEI, simCardNumber, deviceModel };
    if (driverId) {
      updateData.driver = driverId;
    }

    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true },
    ).populate('driver', 'name email');

    res.json({
      message: 'Dispositivo vinculado correctamente',
      vehicle,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get vehicle location history
router.get('/:id/history', authenticate, async (req, res) => {
  try {
    const { hours = 24 } = req.query;

    // Check ownership using role-aware filter
    const filter = buildVehicleFilter(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or unauthorized' });
    }

    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    const history = await SensorData.find({
      vehicle: req.params.id,
      timestamp: { $gte: startTime },
    })
      .select('gps timestamp speed')
      .sort({ timestamp: 1 });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Motor Cut / Engine Stop
router.post('/:id/motor-cut', authenticate, async (req, res) => {
  try {
    const { activate, rules } = req.body;
    const filter = buildVehicleFilter(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    vehicle.motorCutStatus = activate;
    if (rules) vehicle.motorCutRules = rules;
    await vehicle.save();

    // Create a High severity alert
    const Alert = mongoose.model('Alert');
    await Alert.create({
      vehicle: vehicle._id,
      company: vehicle.company,
      type: 'security',
      severity: 'high',
      message: `Remote motor cut ${activate ? 'ACTIVATED' : 'DEACTIVATED'} by manager`,
      location: vehicle.location
    });

    // Broadcast to vehicle subscribers
    broadcastVehicleUpdate(req.io, req.params.id, {
      motorCutStatus: activate,
      action: 'motor_cut_command',
    });

    res.json({
      message: activate ? 'Motor cut activated' : 'Motor cut deactivated',
      vehicle,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Spy Microphone - (Listen-in command)
router.post('/:id/microphone', authenticate, async (req, res) => {
  try {
    const { activate } = req.body;
    const filter = buildVehicleFilter(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(filter);

    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    // In a real scenario, this would send a command to the hardware
    // For now we log it and broadcast the state
    broadcastVehicleUpdate(req.io, req.params.id, {
      microphoneStatus: activate,
      action: 'mic_command',
    });

    res.json({ message: `Microphone ${activate ? 'ON' : 'OFF'}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get vehicle stats/analytics
router.get('/:id/stats', authenticate, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Validate ownership
    const ownerFilter = buildVehicleFilter(req.user, req.params.id);
    const vehicle = await Vehicle.findOne(ownerFilter);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found or unauthorized' });

    let vehicleObjectId;
    try {
      vehicleObjectId = new mongoose.Types.ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    const data = await SensorData.aggregate([
      {
        $match: {
          vehicle: vehicleObjectId,
          timestamp: { $gte: startTime },
        },
      },
      {
        $group: {
          _id: null,
          avgSpeed: { $avg: '$gps.speed' },
          maxSpeed: { $max: '$gps.speed' },
          dataPoints: { $sum: 1 },
          hardBrakings: {
            $sum: { $cond: [{ $gt: ['$accelerometer.x', 0.8] }, 1, 0] },
          },
          hardAccelerations: {
            $sum: { $cond: [{ $gt: ['$accelerometer.x', 0.8] }, 1, 0] },
          },
          avgFuelLevel: { $avg: '$fuel.level' },
          avgEngineTemp: { $avg: '$temperature.ambient' },
          drivingDurationMinutes: {
            $sum: { $cond: [{ $gt: ['$gps.speed', 0] }, 1, 0] }
          }
        },
      },
    ]);

    // Estimate distance: average speed * data points * 10s interval / 3600
    const stats = data[0] || {};
    if (stats.avgSpeed && stats.dataPoints) {
      stats.estimatedDistanceKm = Math.round(stats.avgSpeed * stats.dataPoints * 10 / 3600);
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Delete vehicle (Admin / Fleet Manager / Independent)
router.delete('/:id', authenticate, authorize('admin', 'fleet_manager', 'independent', 'driver'), async (req, res) => {
  try {
    const filter = buildVehicleFilter(req.user, req.params.id);

    const vehicle = await Vehicle.findOneAndDelete(filter);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehículo no encontrado o no autorizado' });
    }

    // Clean up associated sensor data
    await SensorData.deleteMany({ vehicle: req.params.id });

    res.json({ message: 'Vehículo eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
