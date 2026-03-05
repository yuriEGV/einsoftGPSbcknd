import express from 'express';
import PDFDocument from 'pdfkit';
import { authenticate, authorize } from '../middleware/auth.js';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import Alert from '../models/Alert.js';

const router = express.Router();

// Generate daily/weekly/monthly report
router.get('/generate/:period', authenticate, authorize('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { vehicleId, startDate, endDate } = req.query;
    const { period } = req.params;

    let start, end;
    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      end = new Date();
      switch (period) {
        case 'daily':
          start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
          break;
        case 'weekly':
          start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'monthly':
          start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
      }
    }

    let vehicleFilter = { _id: vehicleId };
    if (req.user.role !== 'admin') {
      vehicleFilter.company = req.user.company;
    }

    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or unauthorized' });
    }

    const sensorData = await SensorData.find({
      vehicle: vehicleId,
      timestamp: { $gte: start, $lte: end },
    }).sort({ timestamp: 1 });

    let alertFilter = {
      vehicle: vehicleId,
      createdAt: { $gte: start, $lte: end },
    };
    if (req.user.role !== 'admin') {
      alertFilter.company = req.user.company;
    }

    const alerts = await Alert.find(alertFilter);

    // Calculate metrics
    const totalDistance = sensorData.reduce((sum, data) => {
      return sum + (data.gps?.speed || 0);
    }, 0);

    const avgSpeed = sensorData.length > 0
      ? sensorData.reduce((sum, data) => sum + (data.gps?.speed || 0), 0) / sensorData.length
      : 0;

    const fuelConsumed = sensorData[0]?.fuel?.level - sensorData[sensorData.length - 1]?.fuel?.level;

    res.json({
      reportPeriod: { start, end },
      vehicle: {
        id: vehicle._id,
        licensePlate: vehicle.licensePlate,
        driver: vehicle.assignedDriver,
      },
      metrics: {
        totalDistance: (totalDistance / 1000).toFixed(2),
        averageSpeed: avgSpeed.toFixed(2),
        fuelConsumed: fuelConsumed?.toFixed(2) || 'N/A',
        maxSpeed: Math.max(...sensorData.map(d => d.gps?.speed || 0)),
        tripCount: sensorData.length,
      },
      alertsCount: alerts.length,
      alertsByType: alerts.reduce((acc, alert) => {
        acc[alert.type] = (acc[alert.type] || 0) + 1;
        return acc;
      }, {}),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export report as PDF
router.get('/export/pdf/:vehicleId', authenticate, authorize('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let vehicleFilter = { _id: req.params.vehicleId };
    if (req.user.role !== 'admin') {
      vehicleFilter.company = req.user.company;
    }

    const vehicle = await Vehicle.findOne(vehicleFilter);

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found or unauthorized' });
    }

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_${vehicle.licensePlate}.pdf"`);

    doc.pipe(res);

    doc.fontSize(20).text('Einsoft GPS - Fleet Report', 100, 100);
    doc.fontSize(12).text(`Vehicle: ${vehicle.licensePlate}`, 100, 150);
    doc.text(`Period: ${startDate} to ${endDate}`, 100, 170);

    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule report generation
router.post('/schedule', authenticate, async (req, res) => {
  try {
    const { vehicleId, frequency, recipients, format } = req.body;

    // This would integrate with Bull/Redis queue for scheduled reports
    res.json({
      message: 'Report scheduled',
      schedule: {
        vehicleId,
        frequency, // daily, weekly, monthly
        recipients,
        format, // pdf, excel, email
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
