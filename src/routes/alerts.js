import express from 'express';
import mongoose from 'mongoose';
import Alert from '../models/Alert.js';
import Vehicle from '../models/Vehicle.js';
import { authenticate, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { getAlertScope } from '../middleware/scope.js';
import { broadcastAlert } from '../socket/index.js';

const router = express.Router();

// ─── POST /alerts/panic — Botón de pánico (conductores y usuarios celular GPS) ─
router.post('/panic', authenticate, requirePermission('panic.create'), async (req, res) => {
  try {
    const { vehicleId, latitude, longitude } = req.body;

    // Para conductor: debe asociarse a un vehículo
    if (req.user.role === 'driver') {
      if (!vehicleId) return res.status(400).json({ error: 'vehicleId es requerido para conductores' });
      const vehicleFilter = {
        _id: vehicleId,
        $or: [{ owner: req.user.id }, { driver: req.user.id }],
      };
      const vehicle = await Vehicle.findOne(vehicleFilter);
      if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

      const alert = await Alert.create({
        vehicle: vehicle._id,
        company: vehicle.company,
        type: 'panic',
        severity: 'critical',
        message: `🚨 ¡BOTÓN DE PÁNICO! Conductor: ${req.user.name || req.user.email} — Vehículo: ${vehicle.licensePlate}`,
        location: {
          latitude: latitude || vehicle.location?.coordinates?.[1] || 0,
          longitude: longitude || vehicle.location?.coordinates?.[0] || 0,
          address: vehicle.location?.address || 'Ubicación desconocida',
        },
        triggerValue: true,
      });

      if (req.io) broadcastAlert(req.io, vehicle._id, vehicle.company, alert);
      return res.status(201).json({ message: 'Alerta de pánico enviada', alert });
    }

    // Para mobile_gps_user: sin vehículo, solo posición
    const alert = await Alert.create({
      type: 'panic',
      severity: 'critical',
      message: `🚨 ¡BOTÓN DE PÁNICO! Usuario GPS: ${req.user.name || req.user.email}`,
      location: {
        latitude: latitude || 0,
        longitude: longitude || 0,
        address: 'Ubicación GPS móvil',
      },
      triggerValue: true,
      personTracker: req.userObj?.personTracker,
    });

    res.status(201).json({ message: 'Alerta de pánico enviada', alert });
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
