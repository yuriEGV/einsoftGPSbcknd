import express from 'express';
import Geofence from '../models/Geofence.js';
import Vehicle from '../models/Vehicle.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole, getGeofenceScope, getVehicleScope } from '../middleware/scope.js';

const router = express.Router();

// ─── POST /geofences — Crear geocerca (admin, fleet_manager, independent) ────
router.post('/', authenticate, requireRole('admin', 'fleet_manager', 'independent'), async (req, res) => {
  try {
    const geofence = new Geofence({
      ...req.body,
      company: req.user.company || undefined,
      creator: req.user.id,
    });
    await geofence.save();
    res.status(201).json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /geofences — Listar geocercas según scope del rol ────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const scope = getGeofenceScope(req.user);
    if (scope === null) {
      return res.status(403).json({ error: 'Conductores no tienen acceso a geocercas' });
    }

    const geofences = await Geofence.find(scope).populate('assignedVehicles', 'licensePlate');
    res.json(geofences);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /geofences/:id — Detalle de geocerca ─────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const scope = getGeofenceScope(req.user);
    if (scope === null) {
      return res.status(403).json({ error: 'Sin acceso a geocercas' });
    }

    const geofence = await Geofence.findOne({ _id: req.params.id, ...scope })
      .populate('assignedVehicles');

    if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada o sin acceso' });
    res.json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /geofences/:id — Editar geocerca (admin, fleet_manager, independent) ─
router.put('/:id', authenticate, requireRole('admin', 'fleet_manager', 'independent'), async (req, res) => {
  try {
    const scope = getGeofenceScope(req.user);
    const geofence = await Geofence.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      req.body,
      { new: true }
    );
    if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada o sin acceso' });
    res.json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /geofences/:id — Eliminar geocerca (admin, fleet_manager, independent) ─
router.delete('/:id', authenticate, requireRole('admin', 'fleet_manager', 'independent'), async (req, res) => {
  try {
    const scope = getGeofenceScope(req.user);
    const geofence = await Geofence.findOneAndDelete({ _id: req.params.id, ...scope });
    if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada o sin acceso' });
    res.json({ message: 'Geocerca eliminada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /geofences/:id/check-vehicles — Verificar vehículos en zona ────────
router.post('/:id/check-vehicles', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
  try {
    const scope = getGeofenceScope(req.user);
    const geofence = await Geofence.findOne({ _id: req.params.id, ...scope });
    if (!geofence) return res.status(404).json({ error: 'Geocerca no encontrada o sin acceso' });

    // Solo buscar vehículos dentro del scope del usuario
    const vehicleScope = getVehicleScope(req.user);
    let query = { ...vehicleScope };

    if (geofence.geometry.type === 'Polygon') {
      query.location = { $geoWithin: { $geometry: geofence.geometry } };
    } else if (geofence.geometry.type === 'Point' && geofence.radius) {
      const radiusInRadians = geofence.radius / 6378100;
      query.location = { $geoWithin: { $centerSphere: [geofence.geometry.coordinates, radiusInRadians] } };
    }

    const vehiclesInside = await Vehicle.find(query);
    res.json({
      geofenceId: req.params.id,
      geofenceName: geofence.name,
      vehiclesInsideCount: vehiclesInside.length,
      vehicles: vehiclesInside,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
