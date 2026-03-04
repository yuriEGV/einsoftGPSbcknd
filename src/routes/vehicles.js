import express from 'express';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import SensorData from '../models/SensorData.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastVehicleUpdate } from '../socket/index.js';

const router = express.Router();

// Get all vehicles for a company
router.get('/', authenticate, async (req, res) => {
  try {
    const vehicles = await Vehicle.find({ company: req.user.company })
      .populate('driver', 'name email phone')
      .sort({ lastUpdate: -1 });

    res.json(vehicles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get vehicle by ID with real-time data
router.get('/:id', authenticate, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .populate('driver', 'name email phone')
      .populate('geofences');

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    // Get latest sensor data
    const latestSensorData = await SensorData.findOne({ vehicle: vehicle._id })
      .sort({ timestamp: -1 });

    res.json({
      ...vehicle.toObject(),
      latestSensorData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create vehicle
router.post('/', authenticate, async (req, res) => {
  try {
    const vehicle = new Vehicle({
      ...req.body,
      company: req.user.company,
    });

    await vehicle.save();
    res.status(201).json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update vehicle
router.put('/:id', authenticate, async (req, res) => {
  try {
    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    res.json(vehicle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vincular / actualizar dispositivo (IMEI) al vehículo
router.post('/:id/link-device', authenticate, async (req, res) => {
  try {
    const { deviceIMEI } = req.body;

    if (!deviceIMEI) {
      return res.status(400).json({ error: 'deviceIMEI es requerido' });
    }

    // Asegurar que un IMEI no quede en dos vehículos
    await Vehicle.updateMany(
      { deviceIMEI },
      { $unset: { deviceIMEI: 1 } },
    );

    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      { deviceIMEI },
      { new: true },
    );

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehículo no encontrado' });
    }

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

    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      {
        motorCutStatus: activate,
        motorCutRules: rules || [],
      },
      { new: true }
    );

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
