import express from 'express';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import PersonTracker from '../models/PersonTracker.js';
import User from '../models/User.js';
import SensorData from '../models/SensorData.js';
import DeviceCommand from '../models/DeviceCommand.js';
import { authenticate } from '../middleware/auth.js';
import { broadcastVehicleUpdate } from '../socket/index.js';
import { analyzeVehicle, analyzePerson } from '../services/alertEngine.js';
import { resolveCity } from './sensors.js';

const router = express.Router();

// ─── Helper: Process and save a single telemetry point ────────────────────────
async function processTelemetryPoint(point, clientIp, io = null) {
  const {
    deviceId,
    userId,
    trackerCode,
    latitude,
    longitude,
    accuracy = 0,
    altitude = 0,
    speed = 0,
    heading = 0,
    battery = 100,
    isCharging = false,
    timestamp = new Date(),
    isPanic = false,
  } = point;

  const lat = latitude != null && !isNaN(Number(latitude)) ? Number(latitude) : null;
  const lng = longitude != null && !isNaN(Number(longitude)) ? Number(longitude) : null;
  const hasCoords = lat != null && lng != null && (lat !== 0 || lng !== 0);
  const receivedAt = new Date();
  const pointTime = new Date(timestamp);

  let targetVehicle = null;
  let targetPerson = null;

  // 1. Check if device matches a Vehicle by IMEI or custom deviceId
  if (deviceId) {
    targetVehicle = await Vehicle.findOne({
      $or: [{ deviceIMEI: deviceId }, { licensePlate: deviceId }, { _id: mongoose.isValidObjectId(deviceId) ? deviceId : null }],
    });
  }

  // 2. Check if matches PersonTracker by code, deviceId, phone (or digits), or name
  if (trackerCode || deviceId) {
    const rawId = String(trackerCode || deviceId).trim();
    const cleanDigits = rawId.replace(/\D/g, '');
    const phoneRegex = cleanDigits.length >= 7 ? new RegExp(cleanDigits.slice(-8) + '$') : null;

    targetPerson = await PersonTracker.findOne({
      $or: [
        { trackerCode: rawId },
        { trackerCode: new RegExp('^' + rawId + '$', 'i') },
        { deviceId: rawId },
        { phone: rawId },
        phoneRegex ? { phone: phoneRegex } : null,
        { name: new RegExp('^' + rawId + '$', 'i') },
        mongoose.isValidObjectId(rawId) ? { _id: rawId } : null,
      ].filter(Boolean),
    });
  }

  // 3. Check if matches User by userId, deviceId or IMEI
  if (!targetPerson) {
    const userMatch = await User.findOne({
      $or: [
        userId && mongoose.isValidObjectId(userId) ? { _id: userId } : null,
        deviceId ? { imei: deviceId } : null,
        deviceId ? { phone: deviceId } : null,
        trackerCode ? { name: new RegExp('^' + trackerCode + '$', 'i') } : null,
      ].filter(Boolean),
    });

    if (userMatch) {
      targetPerson = await PersonTracker.findOne({
        $or: [
          { user: userMatch._id },
          { name: userMatch.name },
          { phone: userMatch.phone },
        ],
      });
      if (targetPerson && deviceId && !targetPerson.deviceId) {
        targetPerson.deviceId = deviceId;
      }
      userMatch.lastBatteryLevel = battery;
      userMatch.lastGpsAccuracy = accuracy;
      userMatch.lastSeen = receivedAt;
      await userMatch.save().catch(() => {});
    }
  }

  // 4. Update Vehicle if matched
  if (targetVehicle) {
    if (hasCoords) {
      targetVehicle.location = {
        type: 'Point',
        coordinates: [lng, lat],
        address: targetVehicle.location?.address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      };
      targetVehicle.speed = speed;
      targetVehicle.heading = heading;
      targetVehicle.altitude = altitude;
      targetVehicle.accuracy = accuracy;
    }
    targetVehicle.lastUpdate = pointTime;
    targetVehicle.status = isPanic ? 'alert' : 'active';
    if (!targetVehicle.sensors) targetVehicle.sensors = {};
    targetVehicle.sensors.battery = battery;
    await targetVehicle.save();

    // Record SensorData
    SensorData.create({
      vehicle: targetVehicle._id,
      location: {
        type: 'Point',
        coordinates: [lng || 0, lat || 0],
      },
      speed,
      heading,
      altitude,
      accuracy,
      sensors: {
        speed,
        altitude,
        accuracy,
        heading,
      },
      battery: { level: battery, isCharging },
      timestamp: pointTime,
    }).catch(() => {});

    if (io) {
      broadcastVehicleUpdate(io, targetVehicle._id, {
        lat: lat || targetVehicle.location?.coordinates?.[1],
        lng: lng || targetVehicle.location?.coordinates?.[0],
        speed,
        heading,
        altitude,
        accuracy,
        battery,
        timestamp: pointTime,
        status: targetVehicle.status,
      });
    }

    if (hasCoords) {
      analyzeVehicle(targetVehicle, { gps: { coordinates: [lng, lat], speed }, battery: { level: battery }, alarmSensor: isPanic }, io).catch(() => {});
    }
  }

  // 5. Update PersonTracker if matched
  if (targetPerson) {
    if (deviceId && targetPerson.deviceId !== deviceId) {
      targetPerson.deviceId = deviceId;
    }
    if (hasCoords) {
      const { address: dynamicAddress } = resolveCity(lat, lng);

      targetPerson.location = {
        type: 'Point',
        coordinates: [lng, lat],
        address: dynamicAddress || `GPS (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
        timestamp: pointTime,
      };
      targetPerson.hasReportedLocation = true;
      targetPerson.speed = speed;
      targetPerson.gpsAccuracy = accuracy;
    }
    targetPerson.batteryLevel = battery;
    targetPerson.lastSeen = receivedAt;
    targetPerson.status = isPanic ? 'panic' : 'normal';

    if (isPanic) {
      targetPerson.panicAlert = {
        active: true,
        triggeredAt: pointTime,
        message: '🚨 ¡BOTÓN DE PÁNICO SOS ACTIVADO DESDE CELULAR!',
      };
      analyzePerson(targetPerson, true).catch(() => {});
    }

    await targetPerson.save();

    if (io) {
      io.emit('person_location_update', {
        trackerId: targetPerson._id,
        code: targetPerson.trackerCode || targetPerson.code,
        name: targetPerson.name,
        location: targetPerson.location ? {
          lat: targetPerson.location.coordinates[1],
          lng: targetPerson.location.coordinates[0],
          address: targetPerson.location.address,
        } : null,
        speed: targetPerson.speed || 0,
        accuracy: targetPerson.gpsAccuracy || 0,
        batteryLevel: targetPerson.batteryLevel,
        status: targetPerson.status,
        timestamp: pointTime,
      });
    }
  }

  return { success: true, target: targetVehicle ? 'vehicle' : targetPerson ? 'person' : 'general', receivedAt };
}

// ─── Helper: Normalize Traccar, OsmAnd and Native Payloads ─────────────────────
function normalizePayload(raw) {
  const deviceId = raw.deviceId || raw.id || raw.device_id || raw.uniqueId || raw.imei || raw.phone;
  const trackerCode = raw.trackerCode || raw.code || raw.id;
  const lat = raw.latitude != null ? raw.latitude : (raw.lat != null ? raw.lat : null);
  const lng = raw.longitude != null ? raw.longitude : (raw.lon != null ? raw.lon : (raw.lng != null ? raw.lng : null));
  const alt = raw.altitude != null ? raw.altitude : (raw.alt != null ? raw.alt : 0);
  const spd = raw.speed != null ? Number(raw.speed) : 0;
  const hdg = raw.heading != null ? raw.heading : (raw.bearing != null ? raw.bearing : (raw.course != null ? raw.course : 0));
  const batt = raw.battery != null ? raw.battery : (raw.batt != null ? raw.batt : (raw.batteryLevel != null ? raw.batteryLevel : 100));
  const acc = raw.accuracy != null ? raw.accuracy : (raw.acc != null ? raw.acc : (raw.hdop != null ? Number(raw.hdop) * 5 : 0));
  const isPanic = raw.isPanic === true || raw.panic === 'true' || raw.alarm === 'sos' || raw.event === 'sos';

  let time = new Date();
  if (raw.timestamp) {
    const num = Number(raw.timestamp);
    if (!isNaN(num)) {
      time = num < 2000000000 ? new Date(num * 1000) : new Date(num);
    } else {
      time = new Date(raw.timestamp);
    }
  }

  return {
    deviceId: String(deviceId || ''),
    trackerCode: String(trackerCode || ''),
    userId: raw.userId || null,
    latitude: lat != null ? Number(lat) : null,
    longitude: lng != null ? Number(lng) : null,
    altitude: Number(alt) || 0,
    speed: spd > 0 && spd < 100 && raw.speed?.toString()?.includes('.') ? Math.round(spd * 1.852) : Math.round(spd), // knots to km/h fallback
    heading: Number(hdg) || 0,
    battery: Number(batt) || 100,
    accuracy: Number(acc) || 0,
    isCharging: raw.isCharging === true || raw.charge === 'true',
    isPanic,
    timestamp: isNaN(time.getTime()) ? new Date() : time,
  };
}

// Universal telemetry handler (supports JSON body, URL query params, Traccar & OsmAnd)
async function handleTelemetryRequest(req, res) {
  try {
    const raw = { ...req.query, ...req.body };
    const normalized = normalizePayload(raw);

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const result = await processTelemetryPoint(normalized, clientIp, req.io);

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Check for any pending bidirectional commands for this device
    const targetId = normalized.deviceId || normalized.trackerCode || normalized.userId;
    let pendingCommands = [];
    if (targetId) {
      pendingCommands = await DeviceCommand.find({
        deviceId: String(targetId),
        status: 'PENDING',
      }).sort({ createdAt: 1 }).limit(5);

      if (pendingCommands.length > 0) {
        await DeviceCommand.updateMany(
          { _id: { $in: pendingCommands.map(c => c._id) } },
          { $set: { status: 'SENT' } }
        );
      }
    }

    res.status(200).json({
      message: 'Telemetría procesada exitosamente',
      receivedAt: result.receivedAt,
      commands: pendingCommands.map(c => ({ id: c._id, command: c.command, payload: c.payload })),
    });
  } catch (error) {
    console.error('[telemetry] Error:', error);
    res.status(500).json({ error: error.message });
  }
}

// ─── GET & POST /api/telemetry (Traccar Client default root endpoint) ──────────
router.get('/', handleTelemetryRequest);
router.post('/', handleTelemetryRequest);

// ─── GET & POST /api/telemetry/report ───────────────────────────────────────────
router.get('/report', handleTelemetryRequest);
router.post('/report', handleTelemetryRequest);

// ─── POST /api/telemetry/batch — Sincronización de cola acumulada offline ───────
router.post('/batch', async (req, res) => {
  try {
    const { points } = req.body;
    if (!Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ error: 'Arreglo points es requerido y no puede estar vacío' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    // Sort chronologically
    const sortedPoints = [...points].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let processedCount = 0;
    for (const point of sortedPoints) {
      await processTelemetryPoint(point, clientIp, req.io);
      processedCount++;
    }

    res.status(200).json({
      message: `Sincronización offline completada: ${processedCount} posiciones guardadas en MongoDB`,
      count: processedCount,
      synchronizedAt: new Date(),
    });
  } catch (error) {
    console.error('[telemetry/batch] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/telemetry/command — Enviar comando a un dispositivo ─────────────
router.post('/command', authenticate, async (req, res) => {
  try {
    const { deviceId, command, payload = {}, targetType = 'mobile' } = req.body;
    if (!deviceId || !command) {
      return res.status(400).json({ error: 'deviceId y command son requeridos' });
    }

    const cmd = await DeviceCommand.create({
      deviceId: String(deviceId),
      command,
      payload,
      targetType,
      issuedBy: req.user.id,
      issuedByName: req.user.name || req.user.email,
      status: 'PENDING',
      createdAt: new Date(),
    });

    // Notify via Socket.IO if connected
    if (req.io) {
      req.io.emit(`device_command_${deviceId}`, {
        id: cmd._id,
        command: cmd.command,
        payload: cmd.payload,
      });
    }

    res.status(201).json({
      message: `Comando ${command} emitido hacia ${deviceId}`,
      command: cmd,
    });
  } catch (error) {
    console.error('[telemetry/command] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/telemetry/commands/pending — Polling de comandos pendientes ───────
router.get('/commands/pending', async (req, res) => {
  try {
    const { deviceId, trackerCode } = req.query;
    const queryIds = [deviceId, trackerCode].filter(Boolean);
    if (queryIds.length === 0) return res.json({ commands: [] });

    const pending = await DeviceCommand.find({
      deviceId: { $in: queryIds },
      status: 'PENDING',
    }).limit(10);

    if (pending.length > 0) {
      await DeviceCommand.updateMany(
        { _id: { $in: pending.map(p => p._id) } },
        { status: 'SENT', sentAt: new Date() }
      );
    }

    res.json({
      commands: pending.map(c => ({ id: c._id, command: c.command, payload: c.payload || c.params })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/telemetry/commands/:id/ack — Dispositivo confirma recepción ────
router.post('/commands/:id/ack', async (req, res) => {
  try {
    const { id } = req.params;
    const { response = {} } = req.body;
    await DeviceCommand.findByIdAndUpdate(id, {
      status: 'DELIVERED',
      deliveredAt: new Date(),
      responsePayload: response,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/telemetry/commands/:cmdId/ack — Confirmar ejecución de comando ─
router.post('/commands/:cmdId/ack', async (req, res) => {
  try {
    const { cmdId } = req.params;
    const { response } = req.body;

    const cmd = await DeviceCommand.findByIdAndUpdate(cmdId, {
      status: 'EXECUTED',
      executedAt: new Date(),
      response: response || {},
    }, { new: true });

    if (!cmd) return res.status(404).json({ error: 'Comando no encontrado' });

    res.status(200).json({ message: 'Comando confirmado como ejecutado', command: cmd });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
