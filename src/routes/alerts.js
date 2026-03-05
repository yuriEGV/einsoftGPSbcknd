import express from 'express';
import mongoose from 'mongoose';
import Alert from '../models/Alert.js';
import Vehicle from '../models/Vehicle.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// Get all alerts for company
router.get('/', authenticate, authorize('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { status = 'all', severity = 'all', limit = 50 } = req.query;

    let query = {};
    if (req.user.role !== 'admin') {
      query.company = req.user.company;
    }

    if (status === 'unacknowledged') {
      query.acknowledged = false;
    } else if (status === 'acknowledged') {
      query.acknowledged = true;
    }

    if (severity !== 'all') {
      query.severity = severity;
    }

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

// Get alerts for specific vehicle
router.get('/vehicle/:vehicleId', authenticate, async (req, res) => {
  try {
    const { days = 7 } = req.query;

    // Check vehicle ownership (skip if Admin)
    let vehicleFilter = { _id: req.params.vehicleId };
    if (req.user.role !== 'admin') {
      vehicleFilter.company = req.user.company;
    }

    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or unauthorized' });
    }

    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let alertFilter = {
      vehicle: req.params.vehicleId,
      createdAt: { $gte: startTime },
    };
    if (req.user.role !== 'admin') {
      alertFilter.company = req.user.company;
    }

    const alerts = await Alert.find(alertFilter)
      .sort({ createdAt: -1 });

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Acknowledge alert
router.post('/:alertId/acknowledge', authenticate, async (req, res) => {
  try {
    const { notes } = req.body;

    const alert = await Alert.findByIdAndUpdate(
      req.params.alertId,
      {
        acknowledged: true,
        acknowledgedBy: req.user.id,
        acknowledgedAt: new Date(),
        acknowledgeNotes: notes,
      },
      { new: true }
    );

    res.json({ message: 'Alert acknowledged', alert });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get alert statistics
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let matchQuery = {
      createdAt: { $gte: startTime },
    };
    if (req.user.role !== 'admin') {
      matchQuery.company = mongoose.Types.ObjectId(req.user.company);
    }

    const stats = await Alert.aggregate([
      {
        $match: matchQuery,
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    let countFilter = {
      createdAt: { $gte: startTime },
    };
    let unackFilter = {
      acknowledged: false,
    };

    if (req.user.role !== 'admin') {
      countFilter.company = req.user.company;
      unackFilter.company = req.user.company;
    }

    const totalAlerts = await Alert.countDocuments(countFilter);

    const unacknowledged = await Alert.countDocuments(unackFilter);

    res.json({
      totalAlerts,
      unacknowledged,
      byType: stats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
