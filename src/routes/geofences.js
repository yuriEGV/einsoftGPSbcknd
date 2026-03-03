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
    const geofence = await Geofence.findById(req.params.id)
      .populate('assignedVehicles');

    if (!geofence) {
      return res.status(404).json({ error: 'Geofence not found' });
    }

    res.json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update geofence
router.put('/:id', authenticate, async (req, res) => {
  try {
    const geofence = await Geofence.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    res.json(geofence);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete geofence
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await Geofence.findByIdAndDelete(req.params.id);
    res.json({ message: 'Geofence deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if vehicles are inside geofence
router.post('/:id/check-vehicles', authenticate, async (req, res) => {
  try {
    const geofence = await Geofence.findById(req.params.id);

    const vehiclesInside = await Vehicle.find({
      company: req.user.company,
      location: {
        $geoWithin: {
          $geometry: geofence.geometry,
        },
      },
    });

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
