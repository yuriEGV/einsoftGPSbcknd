import express from 'express';
import PDFDocument from 'pdfkit';
import { authenticate } from '../middleware/auth.js';
import { requireRole, getVehicleScope } from '../middleware/scope.js';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import Alert from '../models/Alert.js';

const router = express.Router();

// ─── GET /reports/generate/:period — Generar reporte (admin, fleet_manager, independent) ─
router.get('/generate/:period', authenticate, requireRole('admin', 'fleet_manager', 'independent'), async (req, res) => {
  try {
    const { vehicleId, startDate, endDate } = req.query;
    const { period } = req.params;

    let start, end;
    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      end = new Date();
      const periodMap = { daily: 1, weekly: 7, monthly: 30 };
      const days = periodMap[period] || 7;
      start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    }

    // Verificar que el vehículo pertenece al scope del usuario
    const vehicleFilter = getVehicleScope(req.user, vehicleId);
    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    const sensorData = await SensorData.find({
      vehicle: vehicleId,
      timestamp: { $gte: start, $lte: end },
    }).sort({ timestamp: 1 });

    // Solo alertas del scope del vehículo
    const alertFilter = { vehicle: vehicleId, createdAt: { $gte: start, $lte: end } };
    if (req.user.company) alertFilter.company = req.user.company;
    const alerts = await Alert.find(alertFilter);

    const speeds = sensorData.map(d => d.gps?.speed || 0);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
    const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;
    const fuelStart = sensorData[0]?.fuel?.level;
    const fuelEnd = sensorData[sensorData.length - 1]?.fuel?.level;
    const fuelConsumed = fuelStart != null && fuelEnd != null ? (fuelStart - fuelEnd).toFixed(2) : 'N/A';

    // Estimación de distancia: avg_speed * data_points * 10s / 3600
    const estimatedDistanceKm = avgSpeed > 0
      ? (avgSpeed * sensorData.length * 10 / 3600).toFixed(2)
      : '0.00';

    res.json({
      reportPeriod: { start, end },
      vehicle: {
        id: vehicle._id,
        licensePlate: vehicle.licensePlate,
        make: vehicle.make,
        model: vehicle.model,
        driver: vehicle.assignedDriver,
      },
      metrics: {
        estimatedDistanceKm,
        averageSpeed: avgSpeed.toFixed(2),
        maxSpeed,
        fuelConsumed,
        tripCount: sensorData.length,
        drivingMinutes: speeds.filter(s => s > 0).length,
      },
      alertsCount: alerts.length,
      alertsByType: alerts.reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + 1; return acc; }, {}),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /reports/export/pdf/:vehicleId — Exportar PDF (admin, fleet_manager, independent) ─
router.get('/export/pdf/:vehicleId', authenticate, requireRole('admin', 'fleet_manager', 'independent'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const vehicleFilter = getVehicleScope(req.user, req.params.vehicleId);
    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso' });

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${vehicle.licensePlate}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).text('Einsoft GPS — Reporte de Vehículo', 100, 80);
    doc.fontSize(12).text(`Patente: ${vehicle.licensePlate}`, 100, 120);
    doc.text(`Marca/Modelo: ${vehicle.make} ${vehicle.model}`, 100, 140);
    doc.text(`Período: ${startDate || 'N/A'} al ${endDate || 'N/A'}`, 100, 160);
    doc.text(`Generado: ${new Date().toLocaleString('es-CL')}`, 100, 180);

    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /reports/schedule — Programar reporte (admin, fleet_manager) ────────
router.post('/schedule', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { vehicleId, frequency, recipients, format } = req.body;
    res.json({ message: 'Reporte programado', schedule: { vehicleId, frequency, recipients, format } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
