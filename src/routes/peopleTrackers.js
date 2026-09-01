import express from 'express';
import crypto from 'crypto';
import PersonTracker from '../models/PersonTracker.js';
import Vehicle from '../models/Vehicle.js';
import User from '../models/User.js';
import Company from '../models/Company.js';
import DeviceCommand from '../models/DeviceCommand.js';
import Alert from '../models/Alert.js';
import SensorData from '../models/SensorData.js';
import { authenticate } from '../middleware/auth.js';
import { analyzePerson } from '../services/alertEngine.js';

const router = express.Router();

// Helper to generate readable tracker code (e.g. PER-8A2F9)
function generateTrackerCode() {
  return 'PER-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ─── GET /api/people-trackers — List tracked people ──────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    let filter = {};

    if (req.user?.role === 'driver' || req.user?.role === 'mobile_gps_user') {
      filter = { user: userId };
    } else if (req.user?.role !== 'superadmin' && req.user?.company) {
      filter = {
        $or: [
          { company: req.user.company },
          { user: userId }
        ]
      };
    }

    if (req.query.companyId) {
      filter.company = req.query.companyId;
    }

    const trackers = await PersonTracker.find(filter)
      .populate('assignedVehicle', 'licensePlate make model status company')
      .populate('company', 'name code')
      .sort({ updatedAt: -1 });
    const processed = trackers.map(t => {
      const obj = t.toObject();
      const coords = obj.location?.coordinates;
      const hasRealCoords = obj.hasReportedLocation === true && coords && Array.isArray(coords) && (coords[0] !== 0 || coords[1] !== 0);

      if (!hasRealCoords) {
        obj.hasReportedLocation = false;
        obj.location = {
          type: 'Point',
          coordinates: [0, 0],
          address: 'Sin señal GPS inicial (Esperando conexión del teléfono)',
          timestamp: obj.location?.timestamp || obj.updatedAt,
        };
      }
      return obj;
    });

    res.json(processed);
  } catch (error) {
    console.error('Error GET /api/people-trackers:', error);
    res.status(500).json({ error: error.message || 'Error al obtener la lista de personas' });
  }
});

// Helper to sync person mobile location to assigned Vehicle
async function syncVehicleLocation(tracker, io) {
  try {
    const Vehicle = (await import('../models/Vehicle.js')).default;
    const SensorData = (await import('../models/SensorData.js')).default;

    let vehicle = null;
    if (tracker.assignedVehicle) {
      const vId = tracker.assignedVehicle._id || tracker.assignedVehicle;
      vehicle = await Vehicle.findById(vId);
    }
    if (!vehicle && tracker.deviceId) {
      vehicle = await Vehicle.findOne({ deviceIMEI: tracker.deviceId });
    }
    if (!vehicle && tracker.trackerCode) {
      vehicle = await Vehicle.findOne({ deviceIMEI: tracker.trackerCode });
    }

    if (vehicle && tracker.location?.coordinates && (tracker.location.coordinates[0] !== 0 || tracker.location.coordinates[1] !== 0)) {
      vehicle.location = {
        type: 'Point',
        coordinates: [tracker.location.coordinates[0], tracker.location.coordinates[1]],
        address: tracker.location.address || 'Ubicación reportada por teléfono celular',
        timestamp: tracker.location.timestamp || new Date(),
      };
      vehicle.speed = tracker.speed || 0;
      vehicle.lastUpdate = tracker.location.timestamp || new Date();
      vehicle.status = 'active';
      await vehicle.save();

      // Also record in SensorData for vehicle route playback
      const sensorDoc = new SensorData({
        deviceIMEI: vehicle.deviceIMEI || tracker.deviceId || tracker.trackerCode,
        vehicle: vehicle._id,
        personTracker: tracker._id,
        gps: {
          latitude: tracker.location.coordinates[1],
          longitude: tracker.location.coordinates[0],
          speed: tracker.speed || 0,
          accuracy: tracker.gpsAccuracy || 0,
          address: tracker.location.address || null,
        },
        battery: { level: tracker.batteryLevel || 100 },
        timestamp: tracker.location.timestamp || new Date(),
      });
      await sensorDoc.save();

      if (io) {
        io.emit('location_update', {
          vehicleId: vehicle._id,
          gps: {
            coordinates: vehicle.location.coordinates,
            speed: vehicle.speed,
            address: vehicle.location.address,
          },
          status: vehicle.status,
          lastUpdate: vehicle.lastUpdate,
        });
      }
    }
  } catch (err) {
    console.error('Error in syncVehicleLocation:', err.message);
  }
}

// ─── POST /api/people-trackers — Register a person to track ──────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, phone, deviceId, roleDescription, assignedVehicle } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'El nombre de la persona es obligatorio.' });
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Sesión de usuario no válida o expirable.' });
    }

    let trackerCode = generateTrackerCode();
    let exists = await PersonTracker.findOne({ trackerCode });
    while (exists) {
      trackerCode = generateTrackerCode();
      exists = await PersonTracker.findOne({ trackerCode });
    }

    const companyId = req.body.company || ((req.user?.company && req.user.company !== '') ? req.user.company : null);

    // Buscar si existe un Usuario registrado con este teléfono o nombre para vincularlo
    let linkedUserId = userId;
    if (phone && phone.trim()) {
      const cleanP = phone.replace(/\D/g, '');
      const matchedUser = await User.findOne({
        $or: [
          { phone: phone.trim() },
          cleanP.length >= 8 ? { phone: new RegExp(cleanP.slice(-8) + '$') } : null,
          { name: new RegExp('^' + name.trim() + '$', 'i') }
        ].filter(Boolean)
      });
      if (matchedUser) linkedUserId = matchedUser._id;
    }

    // Auto-generar lista completa de alias (para que el despertar por Ping y la telemetría siempre lo ubiquen)
    const cleanPhoneDigits = phone ? phone.replace(/\D/g, '') : '';
    const aliasesList = Array.from(new Set([
      trackerCode,
      deviceId ? deviceId.trim() : null,
      phone ? phone.trim() : null,
      cleanPhoneDigits.length >= 7 ? cleanPhoneDigits : null,
      cleanPhoneDigits.length >= 8 ? cleanPhoneDigits.slice(-8) : null,
      name.trim(),
      name.trim().toLowerCase(),
    ].filter(Boolean)));

    const newPerson = new PersonTracker({
      name: name.trim(),
      phone: phone ? phone.trim() : '',
      deviceId: deviceId ? deviceId.trim() : trackerCode,
      roleDescription: roleDescription || 'Familiar / Personal',
      assignedVehicle: assignedVehicle || null,
      trackerCode,
      user: linkedUserId,
      company: companyId,
      aliases: aliasesList,
      hasReportedLocation: false,
      location: {
        type: 'Point',
        coordinates: [0, 0],
        address: 'Sin señal GPS inicial (Esperando conexión del teléfono)',
        timestamp: null,
      },
    });

    await newPerson.save();

    if (assignedVehicle) {
      const Vehicle = (await import('../models/Vehicle.js')).default;
      await Vehicle.findByIdAndUpdate(assignedVehicle, { assignedPerson: newPerson._id });
    }

    res.status(201).json(newPerson);
  } catch (error) {
    console.error('Error POST /api/people-trackers:', error);
    res.status(500).json({ error: error.message || 'Error al registrar la persona en el servidor' });
  }
});

// ─── GET /api/people-trackers/public/:trackerCode — Public Mobile Data ────────
router.get('/public/:trackerCode', async (req, res) => {
  try {
    const tracker = await PersonTracker.findOne({ trackerCode: req.params.trackerCode })
      .populate('assignedVehicle', 'licensePlate make model status');
    if (!tracker) {
      return res.status(404).json({ error: 'Rastreador no encontrado.' });
    }
    res.json(tracker);
  } catch (error) {
    console.error('Error GET /public/:trackerCode:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/public/:trackerCode/location ─────────────────
router.post('/public/:trackerCode/location', async (req, res) => {
  try {
    const { latitude, longitude, speed, batteryLevel, gpsAccuracy, address } = req.body;
    const tracker = await PersonTracker.findOne({ trackerCode: req.params.trackerCode });

    if (!tracker) {
      return res.status(404).json({ error: 'Rastreador no encontrado.' });
    }

    if (latitude !== undefined && longitude !== undefined && (Number(latitude) !== 0 || Number(longitude) !== 0)) {
      tracker.location = {
        type: 'Point',
        coordinates: [Number(longitude), Number(latitude)],
        address: address || tracker.location?.address || 'Coordenadas desde Celular',
        timestamp: new Date(),
      };
      tracker.hasReportedLocation = true;
    }

    if (speed !== undefined) tracker.speed = Number(speed);
    if (batteryLevel !== undefined) tracker.batteryLevel = Math.max(0, Math.min(100, Number(batteryLevel)));
    if (gpsAccuracy !== undefined) tracker.gpsAccuracy = Number(gpsAccuracy);

    if (tracker.status === 'offline') {
      tracker.status = 'normal';
    }

    await tracker.save();

    // Auto-sync location to assigned vehicle if any
    await syncVehicleLocation(tracker, req.io);

    if (req.io) {
      req.io.emit('person_location_update', tracker);
    }

    res.json({ success: true, tracker });
  } catch (error) {
    console.error('Error POST /location:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/public/:trackerCode/panic ───────────────────
router.post('/public/:trackerCode/panic', async (req, res) => {
  try {
    const { active, message, latitude, longitude } = req.body;
    const tracker = await PersonTracker.findOne({ trackerCode: req.params.trackerCode });

    if (!tracker) {
      return res.status(404).json({ error: 'Rastreador no encontrado.' });
    }

    const isPanicActive = active !== undefined ? Boolean(active) : true;

    if (isPanicActive) {
      tracker.status = 'panic';
      tracker.panicAlert = {
        active: true,
        triggeredAt: new Date(),
        message: message || '🚨 ¡BOTÓN DE PÁNICO SOS ACTIVADO DESDE CELULAR!',
      };

      if (latitude !== undefined && longitude !== undefined) {
        tracker.location = {
          type: 'Point',
          coordinates: [Number(longitude), Number(latitude)],
          address: '🚨 Ubicación de Emergencia SOS',
          timestamp: new Date(),
        };
      }

      const alert = new Alert({
        company: tracker.company || tracker.user,
        personTracker: tracker._id,
        type: 'panic',
        severity: 'critical',
        message: `🚨 BOTÓN DE PÁNICO ACTIVADO: ${tracker.name} (${tracker.phone || 'Sin cel'})`,
        description: message || `Se ha activado el botón de pánico de emergencia desde el dispositivo de ${tracker.name}.`,
        location: {
          latitude: tracker.location.coordinates[1],
          longitude: tracker.location.coordinates[0],
          address: tracker.location.address,
        },
        notificationChannels: ['dashboard', 'sound'],
      });
      await alert.save();

      // ── Alert Engine ── Notify Telegram for person panic ────────────────
      analyzePerson(tracker, true).catch(err =>
        console.error('[alertEngine] person panic error:', err.message)
      );

      if (req.io) {
        req.io.emit('person_panic_alert', { tracker, alert });
      }
    } else {
      tracker.status = 'normal';
      tracker.panicAlert.active = false;
      tracker.panicAlert.resolvedAt = new Date();

      if (req.io) {
        req.io.emit('person_panic_resolved', tracker);
      }
    }

    await tracker.save();
    res.json({ success: true, tracker });
  } catch (error) {
    console.error('Error POST /panic:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/panic/resolve-all — Apagar todas las alarmas ──
router.post('/panic/resolve-all', authenticate, async (req, res) => {
  try {
    await PersonTracker.updateMany(
      {},
      { $set: { status: 'normal', 'panicAlert.active': false, 'panicAlert.resolvedAt': new Date() } }
    );
    await Alert.updateMany(
      { status: { $ne: 'resolved' } },
      { $set: { status: 'resolved', resolvedAt: new Date() } }
    );
    if (req.io) req.io.emit('all_panics_resolved');
    res.json({ success: true, message: 'Todas las alarmas de pánico han sido apagadas.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/:id/panic — Admin Toggle/Acknowledge Panic ───
router.post('/:id/panic', authenticate, async (req, res) => {
  try {
    const { active } = req.body;
    const tracker = await PersonTracker.findById(req.params.id);

    if (!tracker) {
      return res.status(404).json({ error: 'Rastreador de persona no encontrado.' });
    }

    const isPanicActive = Boolean(active);
    if (isPanicActive) {
      tracker.status = 'panic';
      tracker.panicAlert.active = true;
      tracker.panicAlert.triggeredAt = new Date();
      tracker.panicAlert.message = '🚨 Pánico activado desde la plataforma de monitoreo.';

      const alert = new Alert({
        company: tracker.company || tracker.user,
        personTracker: tracker._id,
        type: 'panic',
        severity: 'critical',
        message: `🚨 ALERTA DE PÁNICO: ${tracker.name}`,
        description: `Activado manualmente desde el panel de control.`,
        location: {
          latitude: tracker.location.coordinates[1],
          longitude: tracker.location.coordinates[0],
          address: tracker.location.address,
        },
        notificationChannels: ['dashboard', 'sound', 'telegram'],
      });
      await alert.save();

      // Trigger Telegram notification
      analyzePerson(tracker, true).catch(err =>
        console.error('[peopleTrackers admin panic] Telegram notify error:', err.message)
      );

      if (req.io) req.io.emit('person_panic_alert', { tracker, alert });
    } else {
      tracker.status = 'normal';
      tracker.panicAlert.active = false;
      tracker.panicAlert.resolvedAt = new Date();

      if (req.io) req.io.emit('person_panic_resolved', tracker);
    }

    await tracker.save();
    res.json(tracker);
  } catch (error) {
    console.error('Error admin POST /panic:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/:id/ping — Solicitar ping satelital / despertar ───
router.post('/:id/ping', authenticate, async (req, res) => {
  try {
    const tracker = await PersonTracker.findById(req.params.id);
    if (!tracker) {
      return res.status(404).json({ error: 'Persona no encontrada.' });
    }

    tracker.lastSeen = new Date();
    if (tracker.status === 'offline') {
      tracker.status = 'normal';
    }
    await tracker.save();

    // 1. Guardar comando PENDING en base de datos para todas las identidades del dispositivo
    const targetCodes = [
      tracker.deviceId,
      tracker.trackerCode,
      tracker.phone,
      tracker._id?.toString(),
      ...(tracker.aliases || [])
    ].filter(Boolean);

    for (const code of targetCodes) {
      await DeviceCommand.create({
        deviceId: String(code),
        command: 'LOCATE_NOW',
        targetType: 'person',
        targetId: tracker._id,
        payload: { forced: true, triggerBy: req.user?.name || 'Admin', timestamp: new Date(), targetPerson: tracker.name },
        status: 'PENDING',
      }).catch(() => {});
    }

    // 2. Disparar evento de despertar en tiempo real por WebSocket
    if (req.io) {
      const wakePayload = {
        trackerId: tracker._id,
        deviceId: tracker.deviceId,
        trackerCode: tracker.trackerCode,
        name: tracker.name,
        command: 'LOCATE_NOW',
        timestamp: new Date(),
      };

      req.io.emit('force_gps_locate', wakePayload);
      for (const code of targetCodes) {
        req.io.emit(`device_command_${code}`, { command: 'LOCATE_NOW', ...wakePayload });
      }

      try {
        req.io.of('/vehicles').emit('force_gps_locate', wakePayload);
        for (const code of targetCodes) {
          req.io.of('/vehicles').emit(`device_command_${code}`, { command: 'LOCATE_NOW', ...wakePayload });
        }
      } catch (_) {}
    }

    res.json({
      success: true,
      message: `Comando de localización satelital emitido a ${tracker.name}. Despertando receptor EYE-NODE...`,
      tracker,
      targetCodes,
    });
  } catch (error) {
    console.error('Error POST /people-trackers/:id/ping:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/:id/reset-location — Limpiar ubicación antigua ──
router.post('/:id/reset-location', authenticate, async (req, res) => {
  try {
    const tracker = await PersonTracker.findById(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Persona no encontrada.' });

    tracker.hasReportedLocation = false;
    tracker.location = {
      type: 'Point',
      coordinates: [0, 0],
      address: 'Sin señal GPS reciente (Esperando conexión del teléfono)',
      timestamp: null,
    };
    tracker.speed = 0;
    tracker.gpsAccuracy = null;
    await tracker.save();

    if (req.io) {
      req.io.emit('person_location_update', tracker);
    }
    res.json({ success: true, message: 'Ubicación antigua limpiada correctamente.', tracker });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/people-trackers/:id/history — Historial de puntos GPS y viajes ───
router.get('/:id/history', authenticate, async (req, res) => {
  try {
    const tracker = await PersonTracker.findById(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Persona no encontrada' });

    const filter = {
      $or: [
        { personTracker: tracker._id },
        tracker.deviceId ? { deviceIMEI: tracker.deviceId } : null,
      ].filter(Boolean),
    };

    const points = await SensorData.find(filter)
      .sort({ timestamp: 1 })
      .limit(1000)
      .lean();

    res.json(points);
  } catch (error) {
    console.error('Error GET /people-trackers/:id/history:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/people-trackers/history/all — Todos los puntos para mapa multi-ruta ──
// ?since=168  → últimas N horas (default: 168h = 7 días)
// ?limit=5000 → máximo puntos retornados
router.get('/history/all', authenticate, async (req, res) => {
  try {
    const sinceHours = parseInt(req.query.since, 10) || 168; // default 7 días
    const maxLimit = Math.min(parseInt(req.query.limit, 10) || 5000, 10000);
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const points = await SensorData.find({
      personTracker: { $exists: true, $ne: null },
      timestamp: { $gte: since },
      // Excluir puntos con coordenadas inválidas
      $or: [
        { 'gps.latitude': { $exists: true, $ne: 0, $ne: null } },
        { 'location.coordinates.1': { $exists: true, $ne: 0 } },
      ],
    })
      .sort({ timestamp: 1 })
      .limit(maxLimit)
      .lean();

    // Filtrar en memoria puntos oceánicos / inválidos
    const validPoints = points.filter(pt => {
      const lat = pt.gps?.latitude || pt.location?.coordinates?.[1];
      const lng = pt.gps?.longitude || pt.location?.coordinates?.[0];
      if (!lat || !lng) return false;
      if (lat === 0 && lng === 0) return false;
      // Chile: lat entre -56 y -17, lng entre -82 y -65
      if (lat < -56 || lat > -17 || lng < -82 || lng > -65) return false;
      return true;
    });

    res.json(validPoints);
  } catch (error) {
    console.error('Error GET /people-trackers/history/all:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/people-trackers/history/all — Borrar todo el historial de trazas ──
router.delete('/history/all', authenticate, async (req, res) => {
  try {
    const result = await SensorData.deleteMany({ personTracker: { $exists: true, $ne: null } });
    if (req.io) req.io.emit('person_trails_cleared');
    res.json({ success: true, message: `Historial eliminado: ${result.deletedCount} registros.`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/cleanup-coords — Purgar coordenadas inválidas ──
// Elimina puntos GPS con (0,0), oceánicos, o fuera de Chile
router.post('/cleanup-coords', authenticate, async (req, res) => {
  try {
    const CHILE_LAT_MIN = -56, CHILE_LAT_MAX = -17;
    const CHILE_LNG_MIN = -82, CHILE_LNG_MAX = -65;

    // 1. Borrar puntos (0,0)
    const r1 = await SensorData.deleteMany({
      personTracker: { $exists: true, $ne: null },
      $or: [
        { 'gps.latitude': 0, 'gps.longitude': 0 },
        { 'location.coordinates': [0, 0] },
      ],
    });

    // 2. Borrar puntos fuera de Chile
    const r2 = await SensorData.deleteMany({
      personTracker: { $exists: true, $ne: null },
      $or: [
        { 'gps.latitude': { $lt: CHILE_LAT_MIN } },
        { 'gps.latitude': { $gt: CHILE_LAT_MAX } },
        { 'gps.longitude': { $lt: CHILE_LNG_MIN } },
        { 'gps.longitude': { $gt: CHILE_LNG_MAX } },
        { 'location.coordinates.1': { $lt: CHILE_LAT_MIN } },
        { 'location.coordinates.1': { $gt: CHILE_LAT_MAX } },
        { 'location.coordinates.0': { $lt: CHILE_LNG_MIN } },
        { 'location.coordinates.0': { $gt: CHILE_LNG_MAX } },
      ],
    });

    // 3. También resetear PersonTrackers atascados en Playa Ancha con coords incorrectas
    const PersonTracker = (await import('../models/PersonTracker.js')).default;
    const stuckTrackers = await PersonTracker.find({
      $or: [
        { 'location.coordinates.0': { $lt: CHILE_LNG_MIN } },
        { 'location.coordinates.0': { $gt: CHILE_LNG_MAX } },
        { 'location.coordinates.1': { $lt: CHILE_LAT_MIN } },
        { 'location.coordinates.1': { $gt: CHILE_LAT_MAX } },
        { 'location.coordinates': [0, 0] },
      ],
    });

    let resetCount = 0;
    for (const t of stuckTrackers) {
      t.location = { type: 'Point', coordinates: [0, 0], address: 'Esperando señal GPS...', timestamp: null };
      t.hasReportedLocation = false;
      t.speed = 0;
      await t.save().catch(() => {});
      resetCount++;
    }

    const total = r1.deletedCount + r2.deletedCount;
    if (req.io) req.io.emit('person_trails_cleared');

    res.json({
      success: true,
      message: `Limpieza completada: ${total} puntos GPS inválidos eliminados, ${resetCount} personas reseteadas.`,
      details: {
        zeroCoordsDeleted: r1.deletedCount,
        outOfChileDeleted: r2.deletedCount,
        trackersReset: resetCount,
      },
    });
  } catch (error) {
    console.error('Error POST /people-trackers/cleanup-coords:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/people-trackers/:id/history — Borrar historial de una persona ──
router.delete('/:id/history', authenticate, async (req, res) => {
  try {
    const tracker = await PersonTracker.findById(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Persona no encontrada.' });

    const filter = {
      $or: [
        { personTracker: tracker._id },
        { deviceIMEI: tracker.deviceId },
        { deviceIMEI: tracker.trackerCode },
      ],
    };
    await SensorData.deleteMany(filter);
    if (req.io) req.io.emit('person_trail_cleared', { personId: tracker._id });
    res.json({ success: true, message: `Historial de trazas de ${tracker.name} eliminado.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/people-trackers/:id/reset-location — Resetear posición a 0 y borrar traza ─
router.post('/:id/reset-location', authenticate, async (req, res) => {
  try {
    const tracker = await PersonTracker.findById(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Persona no encontrada.' });

    tracker.location = {
      type: 'Point',
      coordinates: [0, 0],
      address: 'Esperando conexión satelital del teléfono...',
      timestamp: new Date(),
    };
    tracker.hasReportedLocation = false;
    tracker.status = 'normal';
    if (tracker.panicAlert) tracker.panicAlert.active = false;
    await tracker.save();

    // Clean historical points
    await SensorData.deleteMany({
      $or: [
        { personTracker: tracker._id },
        { deviceIMEI: tracker.deviceId },
        { deviceIMEI: tracker.trackerCode },
      ],
    });

    if (req.io) {
      req.io.emit('person_location_update', tracker);
      req.io.emit('person_trail_cleared', { personId: tracker._id });
    }

    res.json({ success: true, message: `Posición de ${tracker.name} reseteada exitosamente.`, tracker });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/people-trackers/:id — Actualizar datos de persona / IMEI / Vehículo ──
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name, phone, deviceId, roleDescription, assignedVehicle } = req.body;
    const tracker = await PersonTracker.findById(req.params.id);
    if (!tracker) return res.status(404).json({ error: 'Persona no encontrada.' });

    if (name) tracker.name = name.trim();
    if (phone !== undefined) tracker.phone = phone.trim();
    if (deviceId !== undefined) tracker.deviceId = deviceId ? deviceId.trim() : '';
    if (roleDescription) tracker.roleDescription = roleDescription;

    // Actualizar lista de alias
    const currentName = tracker.name || '';
    const currentPhone = tracker.phone || '';
    const currentDevId = tracker.deviceId || '';
    const cleanPhoneDigits = currentPhone.replace(/\D/g, '');
    tracker.aliases = Array.from(new Set([
      tracker.trackerCode,
      currentDevId || null,
      currentPhone || null,
      cleanPhoneDigits.length >= 7 ? cleanPhoneDigits : null,
      cleanPhoneDigits.length >= 8 ? cleanPhoneDigits.slice(-8) : null,
      currentName,
      currentName.toLowerCase(),
      ...(tracker.aliases || [])
    ].filter(Boolean)));

    if (assignedVehicle !== undefined) {
      const oldVehicleId = tracker.assignedVehicle;
      tracker.assignedVehicle = assignedVehicle || null;

      const Vehicle = (await import('../models/Vehicle.js')).default;
      if (oldVehicleId && String(oldVehicleId) !== String(assignedVehicle)) {
        await Vehicle.findByIdAndUpdate(oldVehicleId, { $unset: { assignedPerson: 1 } });
      }
      if (assignedVehicle) {
        await Vehicle.findByIdAndUpdate(assignedVehicle, { assignedPerson: tracker._id });
        const vDoc = await Vehicle.findById(assignedVehicle);
        if (vDoc && vDoc.company && !tracker.company) {
          tracker.company = vDoc.company;
        }
      }
    }

    if (req.body.company !== undefined) {
      tracker.company = req.body.company || null;
    }

    await tracker.save();
    const updated = await PersonTracker.findById(tracker._id)
      .populate('assignedVehicle', 'licensePlate make model status company')
      .populate('company', 'name code');
    res.json(updated);
  } catch (error) {
    console.error('Error PUT /people-trackers/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/people-trackers/:id — Remove tracked person ───────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const tracker = await PersonTracker.findByIdAndDelete(req.params.id);
    if (!tracker) {
      return res.status(404).json({ error: 'Persona no encontrada.' });
    }
    res.json({ message: 'Registro de rastreo eliminado exitosamente.' });
  } catch (error) {
    console.error('Error DELETE /people-trackers:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
