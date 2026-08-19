import express from 'express';
import mongoose from 'mongoose';
import Alert from '../models/Alert.js';
import Vehicle from '../models/Vehicle.js';
import PanicAlert from '../models/PanicAlert.js';
import { authenticate, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { getAlertScope } from '../middleware/scope.js';
import { broadcastAlert } from '../socket/index.js';
import { notifyPanic } from '../services/alertEngine.js';

const router = express.Router();

// ─── POST /alerts/panic — Botón de pánico (conductores y usuarios celular GPS) ─
router.post('/panic', authenticate, requirePermission('panic.create'), async (req, res) => {
  try {
    const { vehicleId, latitude, longitude, address } = req.body;

    // Para conductor: asociado a un vehículo
    if (req.user.role === 'driver') {
      let vehicle = null;
      if (vehicleId) {
        vehicle = await Vehicle.findById(vehicleId);
      }
      if (!vehicle) {
        // Fallback: buscar el vehículo asignado al conductor
        vehicle = await Vehicle.findOne({ driver: req.user.id });
      }
      if (!vehicle) {
        return res.status(404).json({ error: 'No se encontró vehículo asignado para este conductor' });
      }

      // 1. Actualizar estado del vehículo a 'alert'
      vehicle.status = 'alert';
      if (latitude && longitude && Number(latitude) !== 0 && Number(longitude) !== 0) {
        vehicle.location = {
          type: 'Point',
          coordinates: [Number(longitude), Number(latitude)],
          address: address || vehicle.location?.address || '🚨 Ubicación de Pánico SOS',
        };
      }
      await vehicle.save();

      const lat = latitude || vehicle.location?.coordinates?.[1] || -33.045;
      const lng = longitude || vehicle.location?.coordinates?.[0] || -71.615;
      const addr = address || vehicle.location?.address || 'Ubicación de Emergencia SOS';

      // 2. Crear documento de Alert
      const alert = await Alert.create({
        vehicle: vehicle._id,
        company: vehicle.company || req.user.company || undefined,
        type: 'panic',
        severity: 'critical',
        message: `🚨 ¡BOTÓN DE PÁNICO! Conductor: ${req.user.name || req.user.email} — Vehículo: ${vehicle.licensePlate}`,
        location: {
          latitude: lat,
          longitude: lng,
          address: addr,
        },
        triggerValue: true,
      });

      // 3. Crear documento de PanicAlert para atención en Telegram
      const panicDoc = await PanicAlert.create({
        source: 'vehicle',
        vehicle: vehicle._id,
        company: vehicle.company || undefined,
        latitude: lat,
        longitude: lng,
        address: addr,
        speed: vehicle.speed || 0,
        status: 'ACTIVE',
        triggeredAt: new Date(),
      });

      // 4. Notificar a Telegram inmediatamente
      notifyPanic(panicDoc, `${vehicle.licensePlate} (${req.user.name || 'Conductor'})`, 'vehicle').catch(err => {
        console.error('[alerts/panic] Error notificando Telegram:', err.message);
      });

      // 5. Emitir por Socket.IO
      if (req.io) {
        broadcastAlert(req.io, vehicle._id, vehicle.company, alert);
        req.io.emit('panic_alert', { panic: panicDoc, vehicle, alert });
        req.io.emit('vehicle_status_changed', { vehicleId: vehicle._id, status: 'alert' });
      }

      return res.status(201).json({ message: '🚨 Alerta de pánico enviada y notificada a Telegram', alert, panic: panicDoc });
    }

    // Para mobile_gps_user y otros roles:
    const lat = latitude || -33.045;
    const lng = longitude || -71.615;
    const addr = address || '🚨 Ubicación GPS Móvil de Emergencia';

    const alert = await Alert.create({
      company: req.user.company || undefined,
      type: 'panic',
      severity: 'critical',
      message: `🚨 ¡BOTÓN DE PÁNICO! Usuario Móvil: ${req.user.name || req.user.email}`,
      location: {
        latitude: lat,
        longitude: lng,
        address: addr,
      },
      triggerValue: true,
      personTracker: req.userObj?.personTracker,
    });

    const panicDoc = await PanicAlert.create({
      source: 'person',
      person: req.userObj?.personTracker || undefined,
      company: req.user.company || undefined,
      latitude: lat,
      longitude: lng,
      address: addr,
      speed: 0,
      status: 'ACTIVE',
      triggeredAt: new Date(),
    });

    // Notificar a Telegram inmediatamente
    notifyPanic(panicDoc, req.user.name || req.user.email, 'person').catch(err => {
      console.error('[alerts/panic] Error notificando Telegram:', err.message);
    });

    if (req.io) {
      req.io.emit('panic_alert', { panic: panicDoc, alert });
    }

    return res.status(201).json({ message: '🚨 Alerta de pánico enviada y notificada a Telegram', alert, panic: panicDoc });
  } catch (error) {
    console.error('Panic alert error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /alerts — Listar alertas según scope del rol ────────────────────────────
router.get('/', authenticate, requirePermission('alerts.view'), async (req, res) => {
  try {
    const { status = 'all', severity = 'all', limit = 50 } = req.query;

    const scopeQuery = await getAlertScope(req.user);
    let query = { ...scopeQuery };

    if (status === 'unacknowledged') query.acknowledged = false;
    else if (status === 'acknowledged') query.acknowledged = true;
    if (severity !== 'all') query.severity = severity;

    const alerts = await Alert.find(query)
      .populate('vehicle', 'licensePlate')
      .populate('driver', 'name')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /alerts/vehicle/:vehicleId — Alertas de un vehículo específico ──────
router.get('/vehicle/:vehicleId', authenticate, requirePermission('alerts.view'), async (req, res) => {
  try {
    const { days = 7 } = req.query;


    // Verificar acceso al vehículo
    const { getVehicleScope } = await import('./vehicles.js');
    const vehicleFilter = getVehicleScope(req.user, req.params.vehicleId);
    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const alertFilter = {
      vehicle: req.params.vehicleId,
      createdAt: { $gte: startTime },
    };

    // Acotar además por empresa si aplica
    if (req.user.company) alertFilter.company = req.user.company;

    const alerts = await Alert.find(alertFilter).sort({ createdAt: -1 });
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /alerts/:alertId/acknowledge — Marcar alerta leída ─────────────────
router.post('/:alertId/acknowledge', authenticate, requirePermission('alerts.acknowledge'), async (req, res) => {
  try {
    const { notes } = req.body;

    // Verificar que la alerta pertenece al scope del usuario antes de confirmar
    const scopeQuery = await getAlertScope(req.user);
    const existingAlert = await Alert.findOne({ _id: req.params.alertId, ...scopeQuery });
    if (!existingAlert) return res.status(404).json({ error: 'Alerta no encontrada o sin acceso' });

    const alert = await Alert.findByIdAndUpdate(
      req.params.alertId,
      { acknowledged: true, acknowledgedBy: req.user.id, acknowledgedAt: new Date(), acknowledgeNotes: notes },
      { new: true }
    );

    res.json({ message: 'Alerta confirmada', alert });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /alerts/stats/summary — Estadísticas de alertas ─────────────────────
router.get('/stats/summary', authenticate, requirePermission('alerts.view'), async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scopeQuery = await getAlertScope(req.user);

    const matchQuery = { ...scopeQuery, createdAt: { $gte: startTime } };

    // Convertir ObjectId strings a ObjectId para el pipeline de agregación
    if (matchQuery.company && typeof matchQuery.company === 'string') {
      try {
        matchQuery.company = new mongoose.Types.ObjectId(matchQuery.company);
      } catch { /* ignorar */ }
    }

    const stats = await Alert.aggregate([
      { $match: matchQuery },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const countFilter = { ...scopeQuery, createdAt: { $gte: startTime } };
    const unackFilter = { ...scopeQuery, acknowledged: false };

    const [totalAlerts, unacknowledged] = await Promise.all([
      Alert.countDocuments(countFilter),
      Alert.countDocuments(unackFilter),
    ]);

    res.json({ totalAlerts, unacknowledged, byType: stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
