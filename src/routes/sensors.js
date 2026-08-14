import express from 'express';
import mongoose from 'mongoose';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import Geofence from '../models/Geofence.js';
import Alert from '../models/Alert.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastAlert } from '../socket/index.js';

const router = express.Router();

// ─── resolveCity ─────────────────────────────────────────────────────────────
// Returns a human-readable city name for Chilean coordinates.
// Accurately distinguishes Cerro Placeres, Playa Ancha, Viña del Mar, etc.
export function resolveCity(lat, lng) {
  // Valparaíso region
  if (lat < -32.8 && lat > -33.2 && lng < -71.3 && lng > -71.8) {
    // Cerro Placeres / USM / Portales area (lng between -71.585 and -71.615)
    if (lng >= -71.615 && lng <= -71.585) {
      return { city: 'Valparaíso (Cerro Placeres)', address: 'Cerro Placeres, Valparaíso' };
    }
    // Viña del Mar (east of -71.585)
    if (lng > -71.585) {
      return { city: 'Viña del Mar', address: 'Viña del Mar, Región de Valparaíso' };
    }
    // Playa Ancha (west of -71.628)
    if (lng < -71.628) {
      return { city: 'Valparaíso (Playa Ancha)', address: 'Playa Ancha, Valparaíso' };
    }
    // Valparaíso Centro / Almendral (-71.615 to -71.628)
    return { city: 'Valparaíso (Centro)', address: 'Valparaíso, Región de Valparaíso' };
  }
  // Santiago RM
  if (lat < -33.2 && lat > -33.75 && lng < -70.35 && lng > -70.85) {
    return { city: 'Santiago', address: 'Santiago, Región Metropolitana' };
  }
  // Concepción
  if (lat < -36.5 && lat > -37.0 && lng < -72.9 && lng > -73.2) {
    return { city: 'Concepción', address: 'Concepción, Región del Biobío' };
  }
  // Antofagasta
  if (lat < -23.4 && lat > -23.8 && lng < -70.3 && lng > -70.5) {
    return { city: 'Antofagasta', address: 'Antofagasta, Región de Antofagasta' };
  }
  // Generic: use raw coordinates
  return { city: 'Chile', address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
}

// ─── isSmartTagDevice ─────────────────────────────────────────────────────────
// Smart Tags / BLE beacons have NO onboard sensors: no fuel, no RPM, no OBD2.
// Their "speed" is always GPS position noise (drift), never real vehicle motion.
function isSmartTagDevice(deviceModel) {
  if (!deviceModel) return false;
  const model = deviceModel.toLowerCase();
  return ['xtag', 'smart tag', 'smarttag', 'beacon', 'tomvista', 'tagx',
    'cx-xtag', 'xtag11', 'find hub', 'tile', 'airtag', 'galaxy tag', 'keyfi',
  ].some(k => model.includes(k));
}

// ─── processGPSUpload ─────────────────────────────────────────────────────────
// Core helper: receives an IMEI + GPS payload and updates ONLY that vehicle's location.
// STRICTLY isolated: each IMEI maps to exactly ONE vehicle.
async function processGPSUpload(deviceIMEI, payload, io) {
  const { gps, obd2, fuel, temperature, accelerometer, doorSensor, battery, alarmSensor } = payload;

  if (!deviceIMEI || deviceIMEI === 'XTAG11-DEMO') {
    return { error: 'IMEI inválido o no registrado. Vincula primero el dispositivo al vehículo.', status: 400 };
  }

  // Find the vehicle that owns this EXACT IMEI — strict match
  const vehicle = await Vehicle.findOne({ deviceIMEI: String(deviceIMEI).trim() });
  if (!vehicle) {
    return {
      error: `Dispositivo ${deviceIMEI} no está vinculado a ningún vehículo. Vincula el IMEI en la ficha del vehículo.`,
      status: 404
    };
  }

  const now = new Date();

  // Save raw sensor data record
  const sensorDoc = new SensorData({
    deviceIMEI,
    vehicle: vehicle._id,
    gps, obd2, fuel, temperature, accelerometer, doorSensor, battery, alarmSensor,
    timestamp: now,
  });
  await sensorDoc.save();

  const update = { lastUpdate: now };
  let alertLocation = null;

  if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number'
      && !isNaN(gps.latitude) && !isNaN(gps.longitude)
      && (gps.latitude !== 0 || gps.longitude !== 0)) {

    const { city, address } = resolveCity(gps.latitude, gps.longitude);

    // ⚠️ KEY FIX: Always build a fresh location object from the incoming GPS.
    // NEVER copy previous location fields — that is what caused Vehículo 2 to
    // inherit Vehículo 1's Playa Ancha coordinates.
    update.location = {
      type: 'Point',
      coordinates: [gps.longitude, gps.latitude],   // GeoJSON: [lng, lat]
      address: gps.address || address,
      city: gps.city || city,
      country: gps.country || 'Chile',
      timestamp: now,
    };
    alertLocation = { latitude: gps.latitude, longitude: gps.longitude, address: update.location.address };

    // ─── Speed noise filter ───────────────────────────────────────────────────
    // GPS devices always show position drift when stationary (±5-15m per sample),
    // which registers as 5-15 km/h even when the vehicle is parked.
    // We zero out any speed below 8 km/h as it's GPS noise, not real motion.
    if (typeof gps.speed === 'number') {
      const rawSpeed = Math.round(gps.speed);
      update.speed = rawSpeed < 8 ? 0 : rawSpeed;  // ← noise filter
      // Speed alert > 120 km/h
      if (rawSpeed > 120) {
        const alert = await Alert.create({
          vehicle: vehicle._id, company: vehicle.company,
          type: 'speeding', severity: 'high',
          message: `🚨 Exceso de velocidad: ${rawSpeed} km/h en ${update.location.city}`,
          location: alertLocation, triggerValue: rawSpeed, threshold: 120,
        });
        if (io) broadcastAlert(io, vehicle._id, vehicle.company, alert);
      }
    } else {
      update.speed = 0;
    }
    if (typeof gps.heading === 'number') update.heading = gps.heading;
    update.status = 'active';
  } else {
    // GPS not valid in this packet — only update timestamp, keep last known location
    alertLocation = {
      latitude: vehicle.location?.coordinates?.[1] || 0,
      longitude: vehicle.location?.coordinates?.[0] || 0,
      address: vehicle.location?.address || 'Sin ubicación',
    };
  }

  // ─── Fuel level — ONLY for real GPS trackers, NOT Smart Tags ─────────────
  // Smart Tags (BLE beacons) have zero sensors. Never store fuel data from them.
  const isTag = isSmartTagDevice(vehicle.deviceModel);
  if (!isTag && fuel && typeof fuel.level === 'number') {
    update['sensors.fuel'] = Math.min(100, Math.max(0, fuel.level));
  }
  // If this is a Smart Tag and the vehicle still has stale fuel data, clear it
  if (isTag && vehicle.sensors?.fuel != null) {
    update['sensors.fuel'] = null;
  }

  // Battery low alert
  if (battery?.percentage != null && battery.percentage < 15) {
    await Alert.create({
      vehicle: vehicle._id, company: vehicle.company,
      type: 'battery', severity: 'medium',
      message: `🔋 Batería baja del dispositivo GPS: ${battery.percentage}%`,
      location: alertLocation,
    }).catch(() => {}); // non-fatal
  }

  // Panic button
  if (alarmSensor?.panicButton || alarmSensor?.sos) {
    const alert = await Alert.create({
      vehicle: vehicle._id, company: vehicle.company,
      type: 'panic', severity: 'critical',
      message: `🚨 ¡BOTÓN DE PÁNICO ACTIVADO! — ${vehicle.licensePlate}`,
      location: alertLocation, triggerValue: true,
    });
    if (io) broadcastAlert(io, vehicle._id, vehicle.company, alert);
  }

  const updatedVehicle = await Vehicle.findByIdAndUpdate(vehicle._id, update, { new: true });

  // Broadcast real-time update to all connected dashboard clients
  if (io && update.location) {
    io.emit('location_update', {
      vehicleId: vehicle._id,
      licensePlate: vehicle.licensePlate,
      location: update.location,
      speed: update.speed || 0,
      heading: update.heading,
      status: update.status,
      lastUpdate: now,
    });
  }

  return {
    vehicleId: updatedVehicle._id,
    licensePlate: updatedVehicle.licensePlate,
    location: updatedVehicle.location,
    speed: updatedVehicle.speed,
  };
}


// ─── POST /sensors/upload — Formato nativo Einsoft GPS ───────────────────────
router.post('/upload', async (req, res) => {
  try {
    const { deviceIMEI, ...payload } = req.body;
    if (!deviceIMEI) return res.status(400).json({ error: 'deviceIMEI es requerido' });
    const result = await processGPSUpload(String(deviceIMEI).trim(), payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(201).json({ message: 'Posición actualizada correctamente', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /sensors/traccar-webhook — Traccar forward URL ─────────────────────
router.post('/traccar-webhook', async (req, res) => {
  try {
    const body = req.body;
    const position = body.position || body;
    if (!position) return res.status(400).json({ error: 'Payload Traccar inválido' });

    // Traccar uniqueId IS the device IMEI
    const deviceIMEI = position.attributes?.uniqueId || position.uniqueId || String(position.deviceId || '');
    if (!deviceIMEI) return res.status(400).json({ error: 'No se pudo extraer el IMEI del payload Traccar' });

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
      alarmSensor: (position.attributes?.alarm === 'sos' || position.attributes?.alarm === 'panic')
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

// ─── POST /sensors/find-hub — Smart Tags y trackers chinos (HTTP Push) ────────
router.post('/find-hub', async (req, res) => {
  try {
    const body = req.body;
    const deviceIMEI = String(
      body.imei || body.deviceIMEI || body.IMEI || body.device_id ||
      body.id || req.query.imei || req.query.id || ''
    ).trim();

    if (!deviceIMEI) {
      return res.status(400).json({ error: 'IMEI no encontrado. Campos aceptados: imei, deviceIMEI, device_id, id' });
    }

    const lat = body.lat ?? body.latitude ?? body.gps?.lat ?? body.gps?.latitude ?? body.location?.lat;
    const lng = body.lng ?? body.lon ?? body.longitude ?? body.gps?.lon ?? body.gps?.longitude ?? body.location?.lng;
    const spd = body.speed ?? body.spd ?? body.gps?.speed;
    const hdg = body.heading ?? body.course ?? body.dir ?? body.gps?.heading;
    const bat = body.battery ?? body.bat ?? body.battery_level;

    const payload = {
      gps: lat != null && lng != null ? {
        latitude: parseFloat(lat),
        longitude: parseFloat(lng),
        speed: spd != null ? parseFloat(spd) : 0,
        heading: hdg != null ? parseFloat(hdg) : undefined,
      } : undefined,
      battery: bat != null ? { percentage: parseFloat(bat) } : undefined,
    };

    const result = await processGPSUpload(deviceIMEI, payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(200).json({ message: 'OK', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /sensors/find-hub — Trackers que reportan por query string ───────────
// Ej: GET /api/sensors/find-hub?imei=865350074658702&lat=-33.44&lng=-70.66&speed=45
router.get('/find-hub', async (req, res) => {
  try {
    const { imei, lat, lng, lon, speed, heading, bat } = req.query;
    const deviceIMEI = String(imei || req.query.id || req.query.device_id || '').trim();
    if (!deviceIMEI) return res.status(400).json({ error: 'IMEI requerido como query param ?imei=...' });

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng || lon);

    const payload = {
      gps: !isNaN(latitude) && !isNaN(longitude) ? {
        latitude,
        longitude,
        speed: speed ? parseFloat(speed) : 0,
        heading: heading ? parseFloat(heading) : undefined,
      } : undefined,
      battery: bat ? { percentage: parseFloat(bat) } : undefined,
    };

    const result = await processGPSUpload(deviceIMEI, payload, req.io);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.status(200).json({ message: 'OK', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /sensors/vehicle/:vehicleId — Historial de sensores ─────────────────
router.get('/vehicle/:vehicleId', authenticate, async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const sensorData = await SensorData.find({
      vehicle: req.params.vehicleId,
      timestamp: { $gte: startTime },
    }).sort({ timestamp: -1 }).limit(500);
    res.json(sensorData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /sensors/obd2/:vehicleId — Diagnóstico OBD2 ─────────────────────────
router.get('/obd2/:vehicleId', authenticate, async (req, res) => {
  try {
    const latestOBD2 = await SensorData.findOne({ vehicle: req.params.vehicleId })
      .select('obd2').sort({ timestamp: -1 });
    res.json(latestOBD2?.obd2 || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /sensors/fuel/trends/:vehicleId — Tendencias de combustible ──────────
router.get('/fuel/trends/:vehicleId', authenticate, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let vehicleObjectId;
    try { vehicleObjectId = new mongoose.Types.ObjectId(req.params.vehicleId); }
    catch { return res.status(400).json({ error: 'ID inválido' }); }

    const fuelTrends = await SensorData.aggregate([
      { $match: { vehicle: vehicleObjectId, timestamp: { $gte: startTime } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
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

// ─── POST /sensors/debug-lookup — Helper para verificar que IMEI está vinculado ─
// Sin auth — útil para probar desde Postman / curl
router.get('/debug/:imei', async (req, res) => {
  try {
    const imei = String(req.params.imei).trim();
    const vehicle = await Vehicle.findOne({ deviceIMEI: imei }).select('licensePlate make model location lastUpdate status');
    if (!vehicle) {
      return res.status(404).json({
        error: `IMEI ${imei} no está vinculado a ningún vehículo.`,
        hint: 'Entra a la ficha del vehículo → Sección "Vincular Dispositivo" → ingresa el IMEI y haz click en "Vincular Dispositivo"'
      });
    }
    res.json({
      imei,
      vehicle: {
        id: vehicle._id,
        licensePlate: vehicle.licensePlate,
        make: vehicle.make,
        model: vehicle.model,
        status: vehicle.status,
        lastUpdate: vehicle.lastUpdate,
        lastKnownLocation: vehicle.location,
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
