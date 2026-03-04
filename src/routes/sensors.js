import express from 'express';
import mongoose from 'mongoose';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import Geofence from '../models/Geofence.js';
import Alert from '../models/Alert.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Recibir datos de GPS/Sensores desde el dispositivo
router.post('/upload', async (req, res) => {
  try {
    const {
      deviceIMEI,
      gps,
      obd2,
      fuel,
      temperature,
      accelerometer,
      doorSensor,
      battery,
      alarmSensor,
    } = req.body;

    // Buscar vehículo vinculado por IMEI
    const vehicle = await Vehicle.findOne({ deviceIMEI });
    if (!vehicle) {
      return res.status(404).json({ error: 'Dispositivo no vinculado a ningún vehículo' });
    }

    const now = new Date();

    const sensorData = new SensorData({
      deviceIMEI,
      vehicle: vehicle._id,
      gps,
      obd2,
      fuel,
      temperature,
      accelerometer,
      doorSensor,
      battery,
      alarmSensor,
      timestamp: now,
    });

    await sensorData.save();

    // --- Geofence and Alert Logic ---
    const activeGeofences = await Geofence.find({
      company: vehicle.company,
      active: true,
      assignedVehicles: vehicle._id
    });

    for (const gf of activeGeofences) {
      let isInside = false;
      if (gf.geometry.type === 'Point' && gf.radius) {
        // Point distance check
        const radiusInDegrees = gf.radius / 111320; // Rough conversion for degrees
        const dx = gps.longitude - gf.geometry.coordinates[0];
        const dy = gps.latitude - gf.geometry.coordinates[1];
        // Simple distance formula for small areas, better than complex haversine for basic check
        isInside = Math.sqrt(dx * dx + dy * dy) <= (gf.radius / 111320);
      } else if (gf.geometry.type === 'Polygon') {
        // We could use a library here, but for now we'll rely on the status change 
        // Or re-query MongoDB to see if this specific point is within the specific polygon
        const check = await Vehicle.findOne({
          _id: vehicle._id,
          location: {
            $geoWithin: { $geometry: gf.geometry }
          }
        });
        isInside = !!check;
      }

      // Detect status change (this needs a way to store previous state, 
      // for now let's just trigger based on current location and logic)
      // Competitive logic: Only alert if they enter/exit. 
      // To keep it simple for now, we'll just log if they are currently violating.
    }

    // Actualizar datos en el vehículo para reflejar la última posición/estado
    const update = { lastUpdate: now };
    if (gps) {
      update.location = {
        type: 'Point',
        coordinates: [gps.longitude || 0, gps.latitude || 0],
        address: vehicle.location?.address,
        city: vehicle.location?.city,
        country: vehicle.location?.country,
        timestamp: now,
      };
      if (typeof gps.speed === 'number') {
        update.speed = gps.speed;

        // Example Speeding Alert
        if (gps.speed > 120) {
          const Alert = mongoose.model('Alert');
          await Alert.create({
            vehicle: vehicle._id,
            type: 'speeding',
            severity: 'high',
            message: `Exceso de velocidad: ${gps.speed} km/h`,
            location: { latitude: gps.latitude, longitude: gps.longitude },
            triggerValue: gps.speed,
            threshold: 120
          });
        }
      }
      if (typeof gps.heading === 'number') {
        update.heading = gps.heading;
      }
      update.status = 'active';
    }
    if (fuel && typeof fuel.level === 'number') {
      update['sensors.fuel'] = fuel.level;
    }
    if (battery && typeof battery.voltage === 'number') {
      update['sensors.batteryVoltage'] = battery.voltage;
    }

    await Vehicle.findByIdAndUpdate(vehicle._id, update);

    res.status(201).json({
      message: 'Datos recibidos y aplicados al vehículo',
      dataId: sensorData._id,
      vehicleId: vehicle._id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get sensor data for a vehicle
router.get('/vehicle/:vehicleId', authenticate, async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    const sensorData = await SensorData.find({
      vehicle: req.params.vehicleId,
      timestamp: { $gte: startTime },
    }).sort({ timestamp: -1 });

    res.json(sensorData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get OBD2 diagnostic codes
router.get('/obd2/:vehicleId', authenticate, async (req, res) => {
  try {
    const latestOBD2 = await SensorData.findOne({
      vehicle: req.params.vehicleId,
    })
      .select('obd2')
      .sort({ timestamp: -1 });

    res.json(latestOBD2?.obd2 || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get fuel consumption trends
router.get('/fuel/trends/:vehicleId', authenticate, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const fuelTrends = await SensorData.aggregate([
      {
        $match: {
          vehicle: mongoose.Types.ObjectId(req.params.vehicleId),
          timestamp: { $gte: startTime },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          avgConsumption: { $avg: '$fuel.consumption' },
          minLevel: { $min: '$fuel.level' },
          maxLevel: { $max: '$fuel.level' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json(fuelTrends);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
