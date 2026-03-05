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
    if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
      const activeGeofences = await Geofence.find({
        company: vehicle.company,
        active: true,
        assignedVehicles: vehicle._id
      });

      for (const gf of activeGeofences) {
        let isInside = false;
        const point = [gps.longitude, gps.latitude];

        if (gf.geometry.type === 'Point' && gf.radius) {
          // Point distance check (1 degree ~ 111.32km)
          const dx = (gps.longitude - gf.geometry.coordinates[0]) * Math.cos(gps.latitude * Math.PI / 180);
          const dy = gps.latitude - gf.geometry.coordinates[1];
          const distanceKm = Math.sqrt(dx * dx + dy * dy) * 111.32;
          isInside = (distanceKm * 1000) <= gf.radius;
        }
      }
    }

    // Actualizar datos en el vehículo para reflejar la última posición/estado
    const update = { lastUpdate: now };
    let alertLocation = null;

    if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
      update.location = {
        type: 'Point',
        coordinates: [gps.longitude, gps.latitude],
        address: vehicle.location?.address,
        city: vehicle.location?.city,
        country: vehicle.location?.country,
        timestamp: now,
      };

      alertLocation = {
        latitude: gps.latitude,
        longitude: gps.longitude,
        address: vehicle.location?.address
      };

      if (typeof gps.speed === 'number') {
        update.speed = gps.speed;
        if (gps.speed > 120) {
          await Alert.create({
            vehicle: vehicle._id,
            company: vehicle.company,
            type: 'speeding',
            severity: 'high',
            message: `Exceso de velocidad: ${gps.speed} km/h`,
            location: alertLocation,
            triggerValue: gps.speed,
            threshold: 120
          });
        }
      }
      if (typeof gps.heading === 'number') {
        update.heading = gps.heading;
      }
      update.status = 'active';
    } else {
      // Si no hay GPS, al menos usamos la última ubicación conocida para alertas críticas
      alertLocation = {
        latitude: vehicle.location?.coordinates?.[1] || 0,
        longitude: vehicle.location?.coordinates?.[0] || 0,
        address: vehicle.location?.address
      };
    }

    if (fuel && typeof fuel.level === 'number') {
      update['sensors.fuel'] = fuel.level;
    }

    const updatedVehicle = await Vehicle.findByIdAndUpdate(vehicle._id, update, { new: true });

    // --- Hardware Alarm / Panic Business Logic ---
    if (alarmSensor?.panicButton || alarmSensor?.sos) {
      await Alert.create({
        vehicle: vehicle._id,
        company: vehicle.company,
        type: 'panic',
        severity: 'critical',
        message: '¡BOTÓN DE PÁNICO ACTIVADO!',
        location: alertLocation,
        triggerValue: true
      });
    }

    // Emitir socket para actualización en tiempo real (si está disponible)
    if (req.io) {
      req.io.emit('location_update', {
        vehicleId: vehicle._id,
        gps: update.location,
        speed: update.speed,
        heading: update.heading,
        lastUpdate: now
      });
    }

    res.status(201).json({
      message: 'Datos recibidos y aplicados',
      vehicleId: updatedVehicle._id,
      location: updatedVehicle.location
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
