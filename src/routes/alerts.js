import express from 'express';
import mongoose from 'mongoose';
import Alert from '../models/Alert.js';
import Vehicle from '../models/Vehicle.js';
import PanicAlert from '../models/PanicAlert.js';
import PersonTracker from '../models/PersonTracker.js';
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

// ─── GET /alerts — Listar alertas según scope del rol (Unificando Alert + PanicAlert) ──
router.get('/', authenticate, requirePermission('alerts.view'), async (req, res) => {
  try {
    const { status = 'all', severity = 'all', limit = 150 } = req.query;

    const scopeQuery = await getAlertScope(req.user);
    let alertQuery = { ...scopeQuery };

    if (status === 'unacknowledged') alertQuery.acknowledged = false;
    else if (status === 'acknowledged') alertQuery.acknowledged = true;
    if (severity !== 'all') alertQuery.severity = severity;

    // 1. Obtener alertas de la colección estándar Alert
    const standardAlerts = await Alert.find(alertQuery)
      .populate('vehicle', 'licensePlate make model')
      .populate('driver', 'name email phone')
      .populate('personTracker', 'name trackerCode phone')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // 2. Obtener alertas de la colección PanicAlert (donde se han registrado los pánicos reales)
    let panicAlerts = [];
    if (severity === 'all' || severity === 'critical') {
      let panicQuery = {};
      if (scopeQuery.company) panicQuery.company = scopeQuery.company;
      
      if (status === 'unacknowledged') {
        panicQuery.status = 'ACTIVE';
      } else if (status === 'acknowledged') {
        panicQuery.status = { $in: ['ACKNOWLEDGED', 'RESOLVED', 'FALSE_ALARM'] };
      }

      const rawPanics = await PanicAlert.find(panicQuery)
        .populate('vehicle', 'licensePlate make model')
        .populate('person', 'name trackerCode phone')
        .sort({ triggeredAt: -1 })
        .limit(parseInt(limit))
        .lean();

      panicAlerts = rawPanics.map(p => ({
        _id: p._id,
        isPanicDoc: true,
        type: 'panic',
        severity: 'critical',
        source: p.source,
        message: p.source === 'person'
          ? `🚨 BOTÓN DE PÁNICO SOS: ${p.person?.name || 'Celular / EYE-NODE 360'}`
          : `🚨 BOTÓN DE PÁNICO SOS: ${p.vehicle?.licensePlate || 'Vehículo'}`,
        description: p.notes || `Alerta de pánico SOS activada en ${p.address || 'vía pública'}.`,
        location: {
          latitude: p.latitude,
          longitude: p.longitude,
          address: p.address || (p.latitude && p.longitude ? `Ubicación (${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)})` : 'Sin dirección'),
        },
        speed: p.speed || 0,
        vehicle: p.vehicle || null,
        personTracker: p.person || null,
        driver: null,
        acknowledged: p.status === 'ACKNOWLEDGED' || p.status === 'RESOLVED',
        acknowledgedBy: p.acknowledgedBy ? { name: p.acknowledgedBy } : null,
        acknowledgedAt: p.acknowledgedAt,
        createdAt: p.triggeredAt,
        status: p.status,
      }));
    }

    // 3. Fusionar ambas colecciones y ordenar cronológicamente
    const combined = [...standardAlerts, ...panicAlerts]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, parseInt(limit));

    res.json(combined);
  } catch (error) {
    console.error('Error GET /alerts:', error);
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

    if (req.user.company) alertFilter.company = req.user.company;

    const alerts = await Alert.find(alertFilter).sort({ createdAt: -1 });
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /alerts/:alertId/acknowledge — Marcar alerta leída (Alert o PanicAlert) ─
router.post('/:alertId/acknowledge', authenticate, requirePermission('alerts.acknowledge'), async (req, res) => {
  try {
    const { notes } = req.body;
    const alertId = req.params.alertId;
    const userName = req.user.name || req.user.email || 'Operador SOC';

    // 1. Intentar actualizar en colección Alert
    let alert = await Alert.findById(alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date();
      alert.acknowledgedBy = req.user.id;
      alert.acknowledgeNotes = notes || 'Atendido por operador SOC';
      await alert.save();
      if (req.io) req.io.emit('alert_acknowledged', { alertId, acknowledgedBy: userName });
      return res.json({ success: true, message: 'Alerta confirmada como atendida', alert });
    }

    // 2. Intentar actualizar en colección PanicAlert
    let panic = await PanicAlert.findById(alertId);
    if (panic) {
      panic.status = 'ACKNOWLEDGED';
      panic.acknowledgedAt = new Date();
      panic.acknowledgedBy = userName;
      panic.notes = notes || 'Atendido por operador SOC';
      await panic.save();
      if (req.io) req.io.emit('alert_acknowledged', { alertId, acknowledgedBy: userName });
      return res.json({ success: true, message: 'Alerta de pánico confirmada como atendida', alert: panic });
    }

    return res.status(404).json({ error: 'Alerta no encontrada' });
  } catch (error) {
    console.error('Error POST /alerts/:id/acknowledge:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /alerts/acknowledge-all — Marcar todas las alertas como atendidas ─
router.post('/acknowledge-all', authenticate, async (req, res) => {
  try {
    const scopeQuery = await getAlertScope(req.user);
    const userName = req.user.name || req.user.email || 'Operador SOC';

    const r1 = await Alert.updateMany(
      { ...scopeQuery, acknowledged: false },
      { $set: { acknowledged: true, acknowledgedBy: req.user.id, acknowledgedAt: new Date() } }
    );

    let panicScope = { status: 'ACTIVE' };
    if (scopeQuery.company) panicScope.company = scopeQuery.company;
    const r2 = await PanicAlert.updateMany(
      panicScope,
      { $set: { status: 'ACKNOWLEDGED', acknowledgedBy: userName, acknowledgedAt: new Date() } }
    );

    const totalModified = (r1.modifiedCount || 0) + (r2.modifiedCount || 0);

    if (req.io) req.io.emit('alerts_acknowledged');
    res.json({ message: 'Todas las alertas han sido marcadas como atendidas', modifiedCount: totalModified });
  } catch (error) {
    console.error('Error POST /alerts/acknowledge-all:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /alerts/resolve-panic-all — Desactivar todas las alarmas SOS ──────
router.post('/resolve-panic-all', authenticate, async (req, res) => {
  try {
    const PersonTracker = (await import('../models/PersonTracker.js')).default;
    const PanicAlert = (await import('../models/PanicAlert.js')).default;

    // 1. Reset all person trackers in panic
    await PersonTracker.updateMany(
      {},
      { $set: { status: 'normal', 'panicAlert.active': false, 'panicAlert.resolvedAt': new Date() } }
    );

    // 2. Reset all vehicles in alert
    await Vehicle.updateMany(
      { status: 'alert' },
      { $set: { status: 'active' } }
    );

    // 3. Mark panic alerts as acknowledged and resolved
    await Alert.updateMany(
      { type: 'panic' },
      { $set: { acknowledged: true, acknowledgedBy: req.user.id, acknowledgedAt: new Date() } }
    );

    await PanicAlert.updateMany(
      { status: 'ACTIVE' },
      { $set: { status: 'RESOLVED', resolvedAt: new Date() } }
    );

    if (req.io) {
      req.io.emit('all_panics_resolved');
      req.io.emit('alerts_acknowledged');
    }

    res.json({ success: true, message: 'Todas las alertas de pánico han sido atendidas y desactivadas.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /alerts/:alertId — Eliminar una alerta individual ────────────────
router.delete('/:alertId', authenticate, async (req, res) => {
  try {
    const alert = await Alert.findByIdAndDelete(req.params.alertId);
    if (!alert) return res.status(404).json({ error: 'Alerta no encontrada' });
    if (req.io) req.io.emit('alert_deleted', { alertId: req.params.alertId });
    res.json({ message: 'Alerta eliminada correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /alerts/clear-all — Eliminar alertas atendidas ────────────────────
router.delete('/clear-all', authenticate, async (req, res) => {
  try {
    const scopeQuery = await getAlertScope(req.user);
    const result = await Alert.deleteMany({ ...scopeQuery, acknowledged: true });
    res.json({ message: 'Alertas atendidas eliminadas del historial', deletedCount: result.deletedCount });
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
