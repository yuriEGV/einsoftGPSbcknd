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

  if (latitude == null || longitude == null || isNaN(latitude) || isNaN(longitude)) {
    return { error: 'Coordenadas inválidas' };
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
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

  // 2. Check if matches PersonTracker by code or deviceId
  if (!targetVehicle && (trackerCode || deviceId)) {
    targetPerson = await PersonTracker.findOne({
      $or: [
        { code: trackerCode || deviceId },
        { deviceId: deviceId },
        { _id: mongoose.isValidObjectId(deviceId) ? deviceId : null },
      ],
    });
  }

  // 3. Check if matches User
  if (!targetVehicle && !targetPerson && userId && mongoose.isValidObjectId(userId)) {
    const user = await User.findById(userId);
    if (user) {
      if (user.personTracker) {
        targetPerson = await PersonTracker.findById(user.personTracker);
      }
      user.lastBatteryLevel = battery;
      user.lastGpsAccuracy = accuracy;
      user.lastSeen = receivedAt;
      await user.save();
    }
  }

  // 4. Update Vehicle if matched
  if (targetVehicle) {
    targetVehicle.location = {
      type: 'Point',
      coordinates: [lng, lat],
      address: targetVehicle.location?.address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    };
    targetVehicle.speed = speed;
    targetVehicle.heading = heading;
    targetVehicle.altitude = altitude;
    targetVehicle.accuracy = accuracy;
    targetVehicle.lastUpdate = pointTime;
    targetVehicle.status = isPanic ? 'alert' : 'active';
    if (!targetVehicle.sensors) targetVehicle.sensors = {};
    targetVehicle.sensors.battery = battery;
    await targetVehicle.save();

    // Record SensorData
    await SensorData.create({
      vehicle: targetVehicle._id,
      company: targetVehicle.company,
      gps: {
        coordinates: [lng, lat],
        speed,
        heading,
        altitude,
        accuracy,
      },
      battery: { level: battery, isCharging },
      timestamp: pointTime,
    }).catch(() => {});

    if (io) {
      broadcastVehicleUpdate(io, targetVehicle._id, {
        lat,
        lng,
        speed,
        heading,
        altitude,
        accuracy,
        battery,
        timestamp: pointTime,
        status: targetVehicle.status,
      });
    }

    analyzeVehicle(targetVehicle, { gps: { coordinates: [lng, lat], speed }, battery: { level: battery }, alarmSensor: isPanic }, io).catch(() => {});
  }

  // 5. Update PersonTracker if matched
  if (targetPerson) {
    targetPerson.location = {
      type: 'Point',
      coordinates: [lng, lat],
      address: targetPerson.location?.address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    };
    targetPerson.speed = speed;
    targetPerson.accuracy = accuracy;
    targetPerson.batteryLevel = battery;
    targetPerson.hasReportedLocation = true;
    targetPerson.status = isPanic ? 'alert' : 'active';
    targetPerson.lastSeen = receivedAt;
    await targetPerson.save();

    if (isPanic) {
      analyzePerson(targetPerson, true).catch(() => {});
    }

    if (io) {
      io.emit('person_location_update', {
        trackerId: targetPerson._id,
        code: targetPerson.code,
        name: targetPerson.name,
        location: { lat, lng, address: targetPerson.location.address },
        speed,
        accuracy,
        batteryLevel: battery,
        status: targetPerson.status,
        timestamp: pointTime,
      });
    }
  }

  return { success: true, target: targetVehicle ? 'vehicle' : targetPerson ? 'person' : 'general', receivedAt };
}

// ─── POST /api/telemetry/report — Recepción en tiempo real de telemetría ──────
router.post('/report', async (req, res) => {
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const payload = req.body;

    const result = await processTelemetryPoint(payload, clientIp, req.io);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Check for any pending bidirectional commands for this device
    const deviceId = payload.deviceId || payload.trackerCode || payload.userId;
    let pendingCommands = [];
    if (deviceId) {
      pendingCommands = await DeviceCommand.find({
        deviceId: String(deviceId),
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
    console.error('[telemetry/report] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
