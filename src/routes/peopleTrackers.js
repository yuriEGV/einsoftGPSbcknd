import express from 'express';
import crypto from 'crypto';
import PersonTracker from '../models/PersonTracker.js';
import Alert from '../models/Alert.js';
import { authenticate } from '../middleware/auth.js';

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

    if (req.user?.role === 'admin' && !req.user?.company) {
      filter = {};
    } else if (req.user?.company) {
      filter = { company: req.user.company };
    } else {
      filter = { user: userId };
    }

    const trackers = await PersonTracker.find(filter).sort({ updatedAt: -1 });
    const processed = trackers.map(t => {
      const obj = t.toObject();
      // If location was never reported or is the old default placeholder, zero it out
      if (!obj.hasReportedLocation || (obj.location?.coordinates?.[0] === -70.64827 && obj.location?.coordinates?.[1] === -33.45694)) {
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

// ─── POST /api/people-trackers — Register a person to track ──────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, phone, roleDescription } = req.body;

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

    const companyId = (req.user?.company && req.user.company !== '') ? req.user.company : null;

    const newPerson = new PersonTracker({
      name: name.trim(),
      phone: phone ? phone.trim() : '',
      roleDescription: roleDescription || 'Familiar / Personal',
      trackerCode,
      user: userId,
      company: companyId,
    });

    await newPerson.save();
    res.status(201).json(newPerson);
  } catch (error) {
    console.error('Error POST /api/people-trackers:', error);
    res.status(500).json({ error: error.message || 'Error al registrar la persona en el servidor' });
  }
});

// ─── GET /api/people-trackers/public/:trackerCode — Public Mobile Data ────────
router.get('/public/:trackerCode', async (req, res) => {
  try {
    const tracker = await PersonTracker.findOne({ trackerCode: req.params.trackerCode });
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
        notificationChannels: ['dashboard', 'sound'],
      });
      await alert.save();

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
