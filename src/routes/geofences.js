import express from 'express';
import Geofence from '../models/Geofence.js';
import Vehicle from '../models/Vehicle.js';
import Company from '../models/Company.js';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Helper: resolve company for the request user
// Super admins may not have company in their JWT — look it up from DB or use first available
async function resolveCompany(req) {
  if (req.user.company) return req.user.company;
  // Try fetching from DB
  const user = await User.findById(req.user.id).select('company');
  if (user?.company) return user.company;
  // Super admin fallback: use first company
  const firstCompany = await Company.findOne().select('_id');
  return firstCompany?._id || null;
}

// Create geofence
router.post('/', authenticate, async (req, res) => {
  try {
    const companyId = await resolveCompany(req);
    if (!companyId) {
      return res.status(400).json({ error: 'No se encontró empresa asociada al usuario.' });
    }
    const geofence = new Geofence({
      ...req.body,
      company: companyId,
    });

    await geofence.save();
    res.status(201).json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get all geofences for company
router.get('/', authenticate, async (req, res) => {
  try {
    let query = {};
    const companyId = await resolveCompany(req);
    if (companyId) {
      query.company = companyId;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado: Sin contexto de empresa' });
    }
    const geofences = await Geofence.find(query)
      .populate('assignedVehicles', 'licensePlate');

    res.json(geofences);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get geofence by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    let filter = { _id: req.params.id };
    if (req.user.company) {
      filter.company = req.user.company;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado: Sin contexto de empresa' });
    }
    const geofence = await Geofence.findOne(filter)
      .populate('assignedVehicles');

    if (!geofence) {
      return res.status(404).json({ error: 'Geofence not found or unauthorized' });
    }

    res.json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update geofence
router.put('/:id', authenticate, async (req, res) => {
  try {
    const companyId = await resolveCompany(req);
    const geofence = await Geofence.findOneAndUpdate(
      { _id: req.params.id, ...(companyId ? { company: companyId } : {}) },
      req.body,
      { new: true }
    );

    if (!geofence) {
      return res.status(404).json({ error: 'Geofence not found or unauthorized' });
    }

    res.json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete geofence
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const companyId = await resolveCompany(req);
    const geofence = await Geofence.findOneAndDelete({
      _id: req.params.id,
      ...(companyId ? { company: companyId } : {})
    });

    if (!geofence) {
      return res.status(404).json({ error: 'Geofence not found or unauthorized' });
    }

    res.json({ message: 'Geofence deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if vehicles are inside geofence
router.post('/:id/check-vehicles', authenticate, async (req, res) => {
  try {
    const geofence = await Geofence.findById(req.params.id);
    if (!geofence) return res.status(404).json({ error: 'Geofence not found' });

    let query = { company: req.user.company };

    if (geofence.geometry.type === 'Polygon') {
      query.location = {
        $geoWithin: {
          $geometry: geofence.geometry,
        },
      };
    } else if (geofence.geometry.type === 'Point' && geofence.radius) {
      // Circle detection using $centerSphere: [ [lng, lat], radius_in_radians ]
      // Earth radius approx 6378.1 km
      const radiusInRadians = geofence.radius / 6378100;
      query.location = {
        $geoWithin: {
          $centerSphere: [geofence.geometry.coordinates, radiusInRadians],
        },
      };
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
