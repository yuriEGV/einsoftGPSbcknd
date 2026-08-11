import express from 'express';
import mongoose from 'mongoose';
import Alert from '../models/Alert.js';
import Vehicle from '../models/Vehicle.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole, getAlertScope } from '../middleware/scope.js';
import { broadcastAlert } from '../socket/index.js';

const router = express.Router();

// ─── POST /alerts/panic — Botón de pánico (solo conductores e independientes) ─
router.post('/panic', authenticate, requireRole('driver', 'independent'), async (req, res) => {
  try {
    const { vehicleId, latitude, longitude } = req.body;
    if (!vehicleId) return res.status(400).json({ error: 'vehicleId es requerido' });

    // Verificar que el vehículo pertenece al usuario que activa el pánico
    const vehicleFilter = {
      _id: vehicleId,
      $or: [{ owner: req.user.id }, { driver: req.user.id }],
    };

    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    const alertLocation = {
      latitude: latitude || vehicle.location?.coordinates?.[1] || 0,
      longitude: longitude || vehicle.location?.coordinates?.[0] || 0,
      address: vehicle.location?.address || 'Ubicación desconocida',
    };

    const alert = await Alert.create({
      vehicle: vehicle._id,
      company: vehicle.company,
      type: 'panic',
      severity: 'critical',
      message: `🚨 ¡BOTÓN DE PÁNICO! Usuario: ${req.user.name || req.user.email} — Vehículo: ${vehicle.licensePlate}`,
      location: alertLocation,
      triggerValue: true,
    });

    if (req.io) broadcastAlert(req.io, vehicle._id, vehicle.company, alert);
    res.status(201).json({ message: 'Alerta de pánico enviada', alert });
  } catch (error) {
    console.error('Panic alert error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /alerts — Listar alertas según scope del rol ─────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status = 'all', severity = 'all', limit = 50 } = req.query;

    // Conductores no tienen acceso al listado de alertas
    if (req.user.role === 'driver') {
      return res.status(403).json({ error: 'Conductores no tienen acceso al historial de alertas' });
    }

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
router.get('/vehicle/:vehicleId', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'driver') {
      return res.status(403).json({ error: 'Sin acceso al historial de alertas' });
    }

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
router.post('/:alertId/acknowledge', authenticate, requireRole('admin', 'fleet_manager', 'independent'), async (req, res) => {
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
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'driver') {
      return res.status(403).json({ error: 'Sin acceso a estadísticas de alertas' });
    }

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
