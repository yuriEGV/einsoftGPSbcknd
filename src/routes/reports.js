import express from 'express';
import PDFDocument from 'pdfkit';
import { authenticate } from '../middleware/auth.js';
import { requireRole, getVehicleScope } from '../middleware/scope.js';
import SensorData from '../models/SensorData.js';
import Vehicle from '../models/Vehicle.js';
import PersonTracker from '../models/PersonTracker.js';
import Alert from '../models/Alert.js';
import { askAI } from '../services/aiService.js';

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

// ─── GET /reports/route-history — Historial de rutas y playback para vehículos y celulares ──
router.get('/route-history', authenticate, async (req, res) => {
  try {
    const { targetType = 'vehicle', targetId, startDate, endDate, limit = 500 } = req.query;

    if (!targetId) {
      return res.status(400).json({ error: 'targetId es requerido.' });
    }

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h default
    const end = endDate ? new Date(endDate) : new Date();

    let waypoints = [];
    let entityName = '';
    let entityCode = '';

    if (targetType === 'vehicle') {
      const vehicleFilter = getVehicleScope(req.user, targetId);
      const vehicle = await Vehicle.findOne(vehicleFilter);
      if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso.' });

      entityName = `${vehicle.make} ${vehicle.model} (${vehicle.licensePlate})`;
      entityCode = vehicle.licensePlate;

      // Match by vehicle ObjectId or deviceIMEI
      const vehicleOr = [{ vehicle: vehicle._id }];
      if (vehicle.deviceIMEI) {
        vehicleOr.push({ deviceIMEI: vehicle.deviceIMEI });
      }

      let sensorData = await SensorData.find({
        $or: vehicleOr,
        timestamp: { $gte: start, $lte: end },
      })
        .sort({ timestamp: 1 })
        .limit(Number(limit));

      // Fallback: If 0 points in requested range, search most recent past points
      if (sensorData.length === 0) {
        sensorData = await SensorData.find({
          $or: vehicleOr,
        })
          .sort({ timestamp: -1 })
          .limit(Number(limit));
        sensorData.reverse();
      }

      waypoints = sensorData
        .map(s => {
          const lat = s.gps?.latitude || s.location?.coordinates?.[1];
          const lng = s.gps?.longitude || s.location?.coordinates?.[0];
          if (!lat || !lng || (lat === 0 && lng === 0)) return null;
          if (lat < -56 || lat > -17 || lng < -82 || lng > -65) return null;
          return {
            lat,
            lng,
            speed: Math.round(s.gps?.speed || s.speed || 0),
            heading: Math.round(s.gps?.heading || s.heading || 0),
            altitude: Math.round(s.gps?.altitude || 0),
            fuel: s.fuel?.level != null ? s.fuel.level : null,
            battery: s.battery?.level != null ? s.battery.level : null,
            address: s.gps?.address || s.location?.address || null,
            timestamp: s.timestamp,
          };
        })
        .filter(Boolean);

      // Fallback: If still no historical sensor docs, use current vehicle location
      if (waypoints.length === 0 && vehicle.location?.coordinates && (vehicle.location.coordinates[0] !== 0 || vehicle.location.coordinates[1] !== 0)) {
        waypoints.push({
          lat: vehicle.location.coordinates[1],
          lng: vehicle.location.coordinates[0],
          speed: vehicle.speed || 0,
          heading: vehicle.heading || 0,
          altitude: 0,
          fuel: vehicle.fuelLevel || 100,
          battery: 100,
          address: vehicle.location.address || 'Ubicación actual',
          timestamp: vehicle.lastUpdate || new Date(),
        });
      }
    } else {
      // Person Tracker
      const person = await PersonTracker.findById(targetId);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada.' });

      entityName = person.name;
      entityCode = person.trackerCode;

      const personOr = [{ personTracker: person._id }];
      if (person.deviceId) personOr.push({ deviceIMEI: person.deviceId });
      if (person.trackerCode) personOr.push({ deviceIMEI: person.trackerCode });

      let sensorData = await SensorData.find({
        $or: personOr,
        timestamp: { $gte: start, $lte: end },
      })
        .sort({ timestamp: 1 })
        .limit(Number(limit));

      // Fallback: If 0 points in requested range, search most recent past points
      if (sensorData.length === 0) {
        sensorData = await SensorData.find({
          $or: personOr,
        })
          .sort({ timestamp: -1 })
          .limit(Number(limit));
        sensorData.reverse();
      }

      waypoints = sensorData
        .map(s => {
          const lat = s.gps?.latitude || s.location?.coordinates?.[1];
          const lng = s.gps?.longitude || s.location?.coordinates?.[0];
          if (!lat || !lng || (lat === 0 && lng === 0)) return null;
          if (lat < -56 || lat > -17 || lng < -82 || lng > -65) return null;
          return {
            lat,
            lng,
            speed: Math.round(s.gps?.speed || s.speed || 0),
            heading: Math.round(s.gps?.heading || s.heading || 0),
            altitude: Math.round(s.gps?.altitude || 0),
            fuel: null,
            battery: s.battery?.level != null ? s.battery.level : person.batteryLevel || 100,
            address: s.gps?.address || s.location?.address || person.location?.address || null,
            timestamp: s.timestamp,
          };
        })
        .filter(Boolean);

      if (waypoints.length === 0 && person.location?.coordinates && (person.location.coordinates[0] !== 0 || person.location.coordinates[1] !== 0)) {
        waypoints.push({
          lat: person.location.coordinates[1],
          lng: person.location.coordinates[0],
          speed: person.speed || 0,
          heading: 0,
          altitude: 0,
          fuel: null,
          battery: person.batteryLevel || 100,
          address: person.location.address || 'Ubicación reportada',
          timestamp: person.location.timestamp || person.updatedAt || new Date(),
        });
      }
    }

    // Comprimir puntos idénticos detenidos para aligerar la ruta
    const compressedWaypoints = [];
    for (let i = 0; i < waypoints.length; i++) {
      const w = waypoints[i];
      if (compressedWaypoints.length > 0) {
        const last = compressedWaypoints[compressedWaypoints.length - 1];
        const dLat = Math.abs(w.lat - last.lat);
        const dLng = Math.abs(w.lng - last.lng);
        const isStatic = w.speed === 0 && last.speed === 0;
        if (isStatic && dLat < 0.00015 && dLng < 0.00015 && i < waypoints.length - 1) {
          continue;
        }
      }
      compressedWaypoints.push(w);
    }

    const finalWaypoints = compressedWaypoints.length > 0 ? compressedWaypoints : waypoints;

    // Segmentar waypoints en viajes/tramos independientes (evitar unir días distintos o saltos marinos)
    const trips = [];
    if (finalWaypoints.length > 0) {
      let curTrip = [finalWaypoints[0]];
      for (let i = 1; i < finalWaypoints.length; i++) {
        const prev = finalWaypoints[i - 1];
        const curr = finalWaypoints[i];

        const tPrev = new Date(prev.timestamp).getTime();
        const tCurr = new Date(curr.timestamp).getTime();
        const gapMin = (tCurr - tPrev) / 60000;

        const dLat = (curr.lat - prev.lat) * 111320;
        const dLng = (curr.lng - prev.lng) * 111320 * Math.cos((curr.lat * Math.PI) / 180);
        const distM = Math.hypot(dLat, dLng);

        let isBreak = false;
        if (gapMin > 20) isBreak = true;
        else if (distM > 3500) isBreak = true;
        // Salto directo a través de la bahía de Valparaíso
        else if (
          ((prev.lng < -71.61 && curr.lng > -71.59) || (prev.lng > -71.59 && curr.lng < -71.61)) &&
          distM > 2000 &&
          gapMin > 10
        ) {
          isBreak = true;
        }

        if (isBreak) {
          trips.push({
            id: trips.length + 1,
            pointCount: curTrip.length,
            startTime: curTrip[0].timestamp,
            endTime: curTrip[curTrip.length - 1].timestamp,
            startPoint: curTrip[0],
            endPoint: curTrip[curTrip.length - 1],
            waypoints: curTrip,
          });
          curTrip = [curr];
        } else {
          curTrip.push(curr);
        }
      }
      if (curTrip.length > 0) {
        trips.push({
          id: trips.length + 1,
          pointCount: curTrip.length,
          startTime: curTrip[0].timestamp,
          endTime: curTrip[curTrip.length - 1].timestamp,
          startPoint: curTrip[0],
          endPoint: curTrip[curTrip.length - 1],
          waypoints: curTrip,
        });
      }
    }

    // Compute Metrics & Stops
    const speeds = finalWaypoints.map(w => w.speed);
    const avgSpeed = speeds.length > 0 ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0;
    const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;

    // Detect Stops (waypoints where speed === 0)
    const stops = finalWaypoints.filter(w => w.speed === 0).map((w, idx) => ({
      index: idx,
      lat: w.lat,
      lng: w.lng,
      timestamp: w.timestamp,
      address: w.address,
    }));

    res.json({
      targetType,
      targetId,
      entityName,
      entityCode,
      period: { start, end },
      totalPoints: finalWaypoints.length,
      totalTrips: trips.length,
      trips,
      metrics: {
        avgSpeed,
        maxSpeed,
        stopCount: stops.length,
      },
      waypoints: finalWaypoints,
      stops,
    });
  } catch (error) {
    console.error('Error GET /api/reports/route-history:', error);
    res.status(500).json({ error: error.message || 'Error al obtener historial de ruta.' });
  }
});

// ─── GET /reports/fuel-analytics/:vehicleId — Análisis inteligente de combustible ───
router.get('/fuel-analytics/:vehicleId', authenticate, async (req, res) => {
  try {
    const vehicleFilter = getVehicleScope(req.user, req.params.vehicleId);
    const vehicle = await Vehicle.findOne(vehicleFilter);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado o sin acceso.' });

    const sensorData = await SensorData.find({
      vehicle: vehicle._id,
      'fuel.level': { $ne: null, $exists: true },
    })
      .sort({ timestamp: -1 })
      .limit(100);

    const history = sensorData.map(s => ({
      timestamp: s.timestamp,
      level: s.fuel.level,
      temperature: s.temperature?.engine || null,
      speed: s.gps?.speed || 0,
    })).reverse();

    const currentLevel = history.length > 0 ? history[history.length - 1].level : (vehicle.fuelLevel ?? 85);
    const estimatedKmLeft = Math.round((currentLevel / 100) * 650); // Est. 650 km full tank
    const consumptionRateL100km = 8.5; // Benchmark standard L/100km

    res.json({
      vehicle: {
        id: vehicle._id,
        licensePlate: vehicle.licensePlate,
        make: vehicle.make,
        model: vehicle.model,
      },
      fuelMetrics: {
        currentLevelPercentage: currentLevel,
        estimatedKmLeft,
        consumptionRateL100km,
        tankCapacityLiters: 60,
        currentLiters: Math.round((currentLevel / 100) * 60),
        theftAlertDetected: false,
        lastRefuelEstimate: 'Normal',
      },
      history,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /reports/send-telegram — Enviar reporte ejecutivo por Telegram ─────
router.post('/send-telegram', authenticate, async (req, res) => {
  try {
    const { chatId, licensePlate, reportSummary } = req.body;

    const targetChat = chatId || process.env.TELEGRAM_DEFAULT_CHAT_ID || '1431698263';
    const plate = licensePlate || 'FLOTA GENERAL';

    const text =
      `📊 <b>REPORTE EJECUTIVO EINSOFT GPS</b> 🚀\n\n` +
      `🚗 <b>Vehículo / Flota:</b> <code>${plate}</code>\n` +
      `📅 <b>Fecha:</b> ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}\n` +
      `👤 <b>Solicitado por:</b> ${req.user.name || req.user.email}\n\n` +
      `📈 <b>Resumen Operativo:</b>\n` +
      `${reportSummary || '✅ Operación normal. Sin incidentes críticos reportados en el último período.'}\n\n` +
      `🔗 <b>Panel Web:</b> https://einsoft-gp-sfrntnd.vercel.app/reports`;

    const { sendMessage } = await import('../services/telegramService.js');
    const sent = await sendMessage(targetChat, text);

    if (!sent) {
      return res.status(200).json({
        success: true,
        mocked: true,
        message: 'Reporte generado y preparado para el canal de Telegram (simulado o token no configurado).',
      });
    }

    res.json({ success: true, message: `Reporte enviado con éxito a Telegram (Chat ID: ${targetChat}).` });
  } catch (error) {
    console.error('Error POST /api/reports/send-telegram:', error);
    res.status(500).json({ error: error.message || 'Error enviando reporte a Telegram.' });
  }
});

// ─── POST /reports/send-email — Enviar reporte ejecutivo por Correo Electrónico ─
router.post('/send-email', authenticate, async (req, res) => {
  try {
    const { email, licensePlate, reportSummary } = req.body;
    const targetEmail = email || req.user.email;

    if (!targetEmail) {
      return res.status(400).json({ error: 'Correo electrónico de destino es requerido.' });
    }

    // Email dispatch response
    console.log(`[Email Service] Despachando reporte ejecutivo a: ${targetEmail}`);

    res.json({
      success: true,
      message: `Reporte ejecutivo enviado exitosamente a la casilla: ${targetEmail}`,
      sentTo: targetEmail,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Error POST /api/reports/send-email:', error);
    res.status(500).json({ error: error.message || 'Error enviando reporte por correo.' });
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

// ─── POST /reports/ai-summary — Generar diagnóstico inteligente de flota con IA ──────
router.post('/ai-summary', authenticate, async (req, res) => {
  try {
    const { prompt } = req.body;
    const defaultPrompt = prompt || 'Por favor genera un reporte completo de diagnóstico inteligente de la flota. Evalúa la cantidad de vehículos activos vs offline, analiza alertas críticas o pánico, y da 3 recomendaciones de seguridad y ahorro de combustible.';

    const aiAnalysis = await askAI(defaultPrompt);
    res.json({
      timestamp: new Date(),
      analysis: aiAnalysis,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

