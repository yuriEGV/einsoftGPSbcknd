import express from 'express';
import mongoose from 'mongoose';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import Geofence from '../models/Geofence.js';
import Alert from '../models/Alert.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastAlert } from '../socket/index.js';

const router = express.Router();

// ─── Helper: process and save a GPS upload payload ──────────────────────────
async function processGPSUpload(deviceIMEI, payload, io) {
  const { gps, obd2, fuel, temperature, accelerometer, doorSensor, battery, alarmSensor } = payload;

  const vehicle = await Vehicle.findOne({ deviceIMEI });
  if (!vehicle) return { error: 'Dispositivo no vinculado a ningún vehículo', status: 404 };

  const now = new Date();

  const sensorData = new SensorData({
    deviceIMEI,
    vehicle: vehicle._id,
    gps, obd2, fuel, temperature, accelerometer, doorSensor, battery, alarmSensor,
    timestamp: now,
  });
  await sensorData.save();

  const update = { lastUpdate: now };
  let alertLocation = null;

  if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
    // Resolve address/city dynamically if not explicitly provided
    let city = vehicle.location?.city;
    let country = vehicle.location?.country || 'Chile';
    let address = vehicle.location?.address;

    if (gps.latitude < -32.9 && gps.latitude > -33.2 && gps.longitude < -71.4 && gps.longitude > -71.7) {
      city = 'Valparaíso';
      address = 'Valparaíso, Región de Valparaíso';
    } else if (gps.latitude < -33.3 && gps.latitude > -33.7 && gps.longitude < -70.4 && gps.longitude > -70.8) {
      city = 'Santiago';
      address = 'Santiago, Región Metropolitana';
    } else {
      address = `${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)}`;
    }

    update.location = {
      type: 'Point',
      coordinates: [gps.longitude, gps.latitude],
      address: gps.address || address,
      city: gps.city || city,
      country: gps.country || country,
      timestamp: now,
    };
    alertLocation = { latitude: gps.latitude, longitude: gps.longitude, address: update.location.address };

    if (typeof gps.speed === 'number') {
      update.speed = gps.speed;
      if (gps.speed > 120) {
        const alert = await Alert.create({
          vehicle: vehicle._id, company: vehicle.company,
          type: 'speeding', severity: 'high',
          message: `Exceso de velocidad: ${gps.speed} km/h`,
          location: alertLocation, triggerValue: gps.speed, threshold: 120,
        });
        if (io) broadcastAlert(io, vehicle._id, vehicle.company, alert);
      }
    }
    if (typeof gps.heading === 'number') update.heading = gps.heading;
    update.status = 'active';
  } else {
    alertLocation = {
      latitude: vehicle.location?.coordinates?.[1] || 0,
      longitude: vehicle.location?.coordinates?.[0] || 0,
      address: vehicle.location?.address,
    };
  }

  if (fuel && typeof fuel.level === 'number') update['sensors.fuel'] = fuel.level;

  const updatedVehicle = await Vehicle.findByIdAndUpdate(vehicle._id, update, { new: true });

  if ((alarmSensor?.panicButton || alarmSensor?.sos) && vehicle.company) {
    const alert = await Alert.create({
      vehicle: vehicle._id, company: vehicle.company,
      type: 'panic', severity: 'critical',
      message: '¡BOTÓN DE PÁNICO ACTIVADO!',
      location: alertLocation, triggerValue: true,
    });
    if (io) broadcastAlert(io, vehicle._id, vehicle.company, alert);
  }

  if (io) {
    io.emit('location_update', {
      vehicleId: vehicle._id,
      gps: update.location,
      speed: update.speed,
      heading: update.heading,
      lastUpdate: now,
    });
  }

  return { vehicleId: updatedVehicle._id, location: updatedVehicle.location };
}



// Recibir datos de GPS/Sensores desde el dispositivo (formato nativo Einsoft)
router.post('/upload', async (req, res) => {
  try {
    const { deviceIMEI, ...payload } = req.body;
    if (!deviceIMEI) return res.status(400).json({ error: 'deviceIMEI requerido' });
    const result = await processGPSUpload(deviceIMEI, payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(201).json({ message: 'Datos recibidos y aplicados', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Traccar Webhook ─────────────────────────────────────────────────────────
// Traccar reenvía eventos aquí cuando está configurado con event.forward.url
// Traccar payload: { deviceId, type, position: { deviceId, lat, lon, speed, course, ... } }
router.post('/traccar-webhook', async (req, res) => {
  try {
    const body = req.body;
    // Traccar sends position events
    const position = body.position || body;
    if (!position || !position.deviceId) {
      return res.status(400).json({ error: 'Payload Traccar inválido' });
    }

    // Map Traccar attributes to IMEI — Traccar stores IMEI as device uniqueId
    // The uniqueId in Traccar IS the device IMEI
    const deviceIMEI = position.attributes?.uniqueId || position.uniqueId || String(position.deviceId);

    const payload = {
      gps: {
        latitude: position.latitude || position.lat,
        longitude: position.longitude || position.lon,
        speed: position.speed ? Math.round(position.speed * 1.852) : 0, // knots → km/h
        heading: position.course || position.bearing,
        accuracy: position.accuracy,
        altitude: position.altitude,
      },
      battery: position.attributes?.battery != null
        ? { percentage: position.attributes.battery, voltage: position.attributes.power }
        : undefined,
      alarmSensor: position.attributes?.alarm === 'sos' || position.attributes?.alarm === 'panic'
        ? { sos: true }
        : undefined,
    };

    const result = await processGPSUpload(deviceIMEI, payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(200).json({ message: 'Traccar webhook procesado', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Find Hub / Smart Tag HTTP endpoint ──────────────────────────────────────
// Para dispositivos Smart Tag configurados con URL personalizada en la app Find Hub
// Acepta múltiples formatos comunes de reportes HTTP de trackers chinos
router.post('/find-hub', async (req, res) => {
  try {
    const body = req.body;

    // Normalizar distintos formatos de payload
    const deviceIMEI =
      body.imei || body.deviceIMEI || body.IMEI || body.device_id ||
      body.id || req.query.imei || req.query.id;

    if (!deviceIMEI) {
      return res.status(400).json({ error: 'IMEI no encontrado en el payload. Campos aceptados: imei, deviceIMEI, device_id, id' });
    }

    const lat = body.lat || body.latitude || body.gps?.lat || body.gps?.latitude || body.location?.lat;
    const lng = body.lng || body.lon || body.longitude || body.gps?.lon || body.gps?.longitude || body.location?.lng;
    const spd = body.speed || body.spd || body.gps?.speed;
    const hdg = body.heading || body.course || body.dir || body.gps?.heading;
    const bat = body.battery || body.bat || body.battery_level;

    const payload = {
      gps: lat != null && lng != null ? {
        latitude: parseFloat(lat),
        longitude: parseFloat(lng),
        speed: spd != null ? parseFloat(spd) : undefined,
        heading: hdg != null ? parseFloat(hdg) : undefined,
      } : undefined,
      battery: bat != null ? { percentage: parseFloat(bat) } : undefined,
    };

    const result = await processGPSUpload(String(deviceIMEI), payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(200).json({ message: 'OK', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET version for devices that report via URL query string (some Chinese trackers)
// Example: GET /api/sensors/find-hub?imei=123456789&lat=-33.44&lng=-70.66&speed=45
router.get('/find-hub', async (req, res) => {
  try {
    const { imei, lat, lng, lon, speed, heading, bat } = req.query;
    const deviceIMEI = imei || req.query.id || req.query.device_id;
    if (!deviceIMEI) return res.status(400).json({ error: 'IMEI requerido como query param ?imei=...' });

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng || lon);

    const payload = {
      gps: !isNaN(latitude) && !isNaN(longitude) ? {
        latitude,
        longitude,
        speed: speed ? parseFloat(speed) : undefined,
        heading: heading ? parseFloat(heading) : undefined,
      } : undefined,
      battery: bat ? { percentage: parseFloat(bat) } : undefined,
    };

    const result = await processGPSUpload(String(deviceIMEI), payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(200).json({ message: 'OK', ...result });
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
