import express from 'express';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import SensorData from '../models/SensorData.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastVehicleUpdate } from '../socket/index.js';

const router = express.Router();

// Get all vehicles (Admin: all, Others: by company)
router.get('/', authenticate, async (req, res) => {
  try {
    let filter = {};
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }

    const now = new Date();
    const vehicles = await Vehicle.find(filter)
      .populate('driver', 'name email phone')
      .populate('company', 'name')
      .sort({ lastUpdate: -1 });

    // Dynamic status update for offline vehicles (5 min threshold)
    const processedVehicles = vehicles.map(v => {
      const obj = v.toObject();
      const lastUpdate = v.lastUpdate || v.location?.timestamp;
      if (lastUpdate && (now - new Date(lastUpdate)) > 5 * 60 * 1000) {
        obj.status = 'offline';
      }
      return obj;
    });

    res.json(processedVehicles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get vehicle by ID (Admin: bypass company check)
router.get('/:id', authenticate, async (req, res) => {
  try {
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }

    const vehicle = await Vehicle.findOne(filter)
      .populate('driver', 'name email phone')
      .populate('company', 'name')
      .populate('geofences');

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or unauthorized' });
    }

    // Get latest sensor data
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

// Create vehicle (Admin: allowed company assignment)
router.post('/', authenticate, async (req, res) => {
  try {
    const { companyId, ...vehicleData } = req.body;
    const vehicle = new Vehicle({
      ...vehicleData,
      company: req.user.role === 'admin' ? companyId : req.user.company,
    });

    await vehicle.save();
    res.status(201).json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update vehicle (Admin: allowed company assignment)
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { companyId, ...updateData } = req.body;
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }

    if (req.user.role === 'admin' && companyId) {
      updateData.company = companyId;
    }

    const vehicle = await Vehicle.findOneAndUpdate(filter, updateData, { new: true });

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or unauthorized' });
    }

    res.json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vincular / actualizar dispositivo (IMEI, SIM, Modelo) al vehículo
router.post('/:id/link-device', authenticate, async (req, res) => {
  try {
    const { deviceIMEI, simCardNumber, deviceModel, driverId } = req.body;

    if (!deviceIMEI) {
      return res.status(400).json({ error: 'deviceIMEI es requerido' });
    }

    // Asegurar que el vehículo existe y pertenece a la empresa (o es Admin) antes de seguir
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }

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

    // Check ownership first (skip if Admin)
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }
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
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }
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
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }
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

    const data = await SensorData.aggregate([
      {
        $match: {
          vehicle: mongoose.Types.ObjectId(req.params.id),
          timestamp: { $gte: startTime },
        },
      },
      {
        $group: {
          _id: null,
          avgSpeed: { $avg: '$gps.speed' },
          maxSpeed: { $max: '$gps.speed' },
          totalDistance: { $sum: '$gps.speed' },
          hardBrakings: {
            $sum: { $cond: [{ $gt: ['$accelerometer.x', 0.8] }, 1, 0] },
          },
          hardAccelerations: {
            $sum: { $cond: [{ $gt: ['$accelerometer.x', 0.8] }, 1, 0] },
          },
          avgFuelLevel: { $avg: '$fuel.level' },
          avgEngineTemp: { $avg: '$temperature.ambient' },
        },
      },
    ]);

    res.json(data[0] || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
