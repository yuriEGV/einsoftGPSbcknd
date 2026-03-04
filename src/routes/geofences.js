import express from 'express';
import Geofence from '../models/Geofence.js';
import Vehicle from '../models/Vehicle.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Create geofence
router.post('/', authenticate, async (req, res) => {
  try {
    const geofence = new Geofence({
      ...req.body,
      company: req.user.company,
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
    const geofences = await Geofence.find({ company: req.user.company })
      .populate('assignedVehicles', 'licensePlate');

    res.json(geofences);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get geofence by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const geofence = await Geofence.findOne({ _id: req.params.id, company: req.user.company })
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
    const geofence = await Geofence.findOneAndUpdate(
      { _id: req.params.id, company: req.user.company },
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
    const geofence = await Geofence.findOneAndDelete({
      _id: req.params.id,
      company: req.user.company
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
