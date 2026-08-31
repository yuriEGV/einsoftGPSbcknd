import express from 'express';
import mongoose from 'mongoose';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import Geofence from '../models/Geofence.js';
import Alert from '../models/Alert.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastAlert } from '../socket/index.js';
import { analyzeVehicle } from '../services/alertEngine.js';

const router = express.Router();

// ─── resolveCity ─────────────────────────────────────────────────────────────
// Geocodificación inversa real usando OpenStreetMap Nominatim.
// En caso de error de red, usa bounding boxes de alta precisión como fallback.
export async function resolveCity(lat, lng) {
  // Validación rápida: coordenadas dentro de Chile
  if (!lat || !lng || lat === 0 || lng === 0) {
    return { city: 'Sin señal', address: 'Sin señal GPS' };
  }
  if (lat < -56 || lat > -17 || lng < -82 || lng > -65) {
    return { city: 'Fuera de Chile', address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }

  // Intentar geocodificación inversa real con Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1&accept-language=es`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EINSoft-GPS/1.0 (contact@einsoft.cl)' },
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.address) {
        const addr = data.address;
        // Construir dirección legible
        const road = addr.road || addr.pedestrian || addr.footway || '';
        const houseNum = addr.house_number || '';
        const suburb = addr.suburb || addr.neighbourhood || addr.quarter || '';
        const city = addr.city || addr.town || addr.village || addr.municipality || 'Chile';
        const state = addr.state || '';

        const streetPart = road ? `${road}${houseNum ? ' ' + houseNum : ''}` : '';
        const localPart = suburb ? `${suburb}, ` : '';
        const cityPart = `${city}${state && state !== city ? ', ' + state : ''}`;

        const address = streetPart
          ? `${streetPart}, ${localPart}${cityPart}`
          : `${localPart}${cityPart}`;

        return { city, address: address.trim() || data.display_name?.split(',').slice(0, 3).join(', ') || cityPart };
      }
    }
  } catch (_) {
    // Fallback si Nominatim falla (timeout, sin red, etc.)
  }

  // ── Fallback de alta precisión (sin necesitar API) ─────────────────────────
  // Valparaíso y región (sectores más comunes del sistema)
  if (lat >= -33.10 && lat <= -32.85 && lng >= -71.78 && lng <= -71.42) {
    // Playa Ancha (al oeste del cerro, acceso desde Av. España)
    if (lng < -71.645 && lat < -33.04) {
      return { city: 'Valparaíso', address: `Playa Ancha, Valparaíso (${lat.toFixed(4)}, ${lng.toFixed(4)})` };
    }
    // Cerro Alegre / Concepción / centro histórico
    if (lng >= -71.635 && lng <= -71.61 && lat >= -33.05 && lat <= -33.035) {
      return { city: 'Valparaíso', address: `Centro/Puerto, Valparaíso` };
    }
    // Cerro Placeres / USM
    if (lng >= -71.615 && lng <= -71.585) {
      return { city: 'Valparaíso', address: `Cerro Placeres, Valparaíso` };
    }
    // Viña del Mar
    if (lng > -71.57) {
      return { city: 'Viña del Mar', address: `Viña del Mar, Región de Valparaíso` };
    }
    // Quilpué / Villa Alemana
    if (lat > -33.05 && lng > -71.45) {
      return { city: 'Quilpué', address: `Quilpué, Región de Valparaíso` };
    }
    return { city: 'Valparaíso', address: `Valparaíso, Chile (${lat.toFixed(4)}, ${lng.toFixed(4)})` };
  }
  // Santiago RM
  if (lat >= -33.75 && lat <= -33.20 && lng >= -70.85 && lng <= -70.35) {
    return { city: 'Santiago', address: `Santiago, Región Metropolitana` };
  }
  // Concepción
  if (lat >= -37.0 && lat <= -36.5 && lng >= -73.2 && lng <= -72.9) {
    return { city: 'Concepción', address: `Concepción, Región del Biobío` };
  }
  // Antofagasta
  if (lat >= -23.8 && lat <= -23.4 && lng >= -70.5 && lng <= -70.3) {
    return { city: 'Antofagasta', address: `Antofagasta, Región de Antofagasta` };
  }
  // Genérico: coordenadas exactas
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
// Core helper: receives an IMEI + GPS payload and updates vehicle or person location.
async function processGPSUpload(deviceIMEI, payload, io) {
  const { gps, obd2, fuel, temperature, accelerometer, doorSensor, battery, alarmSensor } = payload;

  if (!deviceIMEI || deviceIMEI === 'XTAG11-DEMO') {
    return { error: 'IMEI inválido o no registrado.', status: 400 };
  }

  const rawIMEI = String(deviceIMEI).trim();
  const now = new Date();

  // 1. Find if device belongs to a Vehicle
  const vehicle = await Vehicle.findOne({ deviceIMEI: rawIMEI });
  if (!vehicle) {
    // 2. Check if device belongs to a PersonTracker (EYE-NODE APK / mobile)
    const PersonTracker = (await import('../models/PersonTracker.js')).default;
    const cleanDigits = rawIMEI.replace(/\D/g, '');
    const phoneRegex = cleanDigits.length >= 7 ? new RegExp(cleanDigits.slice(-8) + '$') : null;

    const person = await PersonTracker.findOne({
      $or: [
        { deviceId: rawIMEI },
        { trackerCode: rawIMEI },
        { trackerCode: new RegExp('^' + rawIMEI + '$', 'i') },
        { phone: rawIMEI },
        phoneRegex ? { phone: phoneRegex } : null,
        { name: new RegExp('^' + rawIMEI + '$', 'i') },
      ].filter(Boolean),
    });

    if (person) {
      if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number' && (gps.latitude !== 0 || gps.longitude !== 0)) {
        const { city, address } = resolveCity(gps.latitude, gps.longitude);
        person.location = {
          type: 'Point',
          coordinates: [gps.longitude, gps.latitude],
          address: gps.address || address || 'Coordenadas desde Celular',
          city: gps.city || city || 'Chile',
          timestamp: now,
        };
        person.hasReportedLocation = true;
      }
      if (gps?.speed !== undefined) person.speed = Math.max(0, Number(gps.speed));
      if (battery?.level !== undefined) person.batteryLevel = Math.max(0, Math.min(100, Number(battery.level)));
      if (gps?.accuracy !== undefined) person.gpsAccuracy = Number(gps.accuracy);
      if (person.status === 'offline') person.status = 'normal';
      person.lastSeen = now;
      await person.save();

      // If person has an assigned vehicle, also update vehicle location
      let linkedVehicle = null;
      if (person.assignedVehicle) {
        linkedVehicle = await Vehicle.findById(person.assignedVehicle);
      }
      if (linkedVehicle && person.hasReportedLocation) {
        linkedVehicle.location = person.location;
        linkedVehicle.speed = person.speed;
        linkedVehicle.lastUpdate = now;
        linkedVehicle.status = 'active';
        await linkedVehicle.save();
      }

      // Save raw sensor data record
      const sensorDoc = new SensorData({
        deviceIMEI: rawIMEI,
        personTracker: person._id,
        vehicle: linkedVehicle ? linkedVehicle._id : undefined,
        gps, obd2, fuel, temperature, accelerometer, doorSensor, battery, alarmSensor,
        timestamp: now,
      });
      await sensorDoc.save();

      if (io) {
        io.emit('person_location_update', person);
        if (linkedVehicle) {
          io.emit('location_update', {
            vehicleId: linkedVehicle._id,
            licensePlate: linkedVehicle.licensePlate,
            location: linkedVehicle.location,
            speed: linkedVehicle.speed || 0,
            status: linkedVehicle.status,
            lastUpdate: now,
          });
        }
      }

      return {
        personId: person._id,
        name: person.name,
        location: person.location,
        speed: person.speed,
        batteryLevel: person.batteryLevel,
      };
    }

    return {
      error: `Dispositivo ${deviceIMEI} no está vinculado a ningún vehículo ni persona registrada.`,
      status: 404
    };
  }

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

  // ── Run alert engine (Telegram notifications, panic detection, etc.) ────────
  // Fire-and-forget: never blocks GPS response
  analyzeVehicle(updatedVehicle, payload, io).catch(err =>
    console.error('[alertEngine] background error:', err.message)
  );

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
