import express from 'express';
import Plan from '../models/Plan.js';
import Payment from '../models/Payment.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { createPayment, retryPayment, updatePaymentStatus, processWebhook } from '../services/payment.service.js';
import { checkSubscriptionStatus, runExpiryCheck } from '../services/subscription.service.js';

const router = express.Router();

const DEFAULT_PLANS = [
  // ─── Rastreo Vehicular & Flotas ───────────────────────────────────────────
  {
    code: 'VEH-FAMILIAR',
    name: 'Plan Particular / Familiar',
    description: '1 vehículo principal con rastreo satelital en tiempo real.',
    price: 9990,
    currency: 'CLP',
    period: 'CLP / mes',
    category: 'vehicles',
    icon: '🚗',
    tag: 'Familiar',
    highlight: false,
    maxDevices: 1,
    durationDays: 30,
    targetType: 'user',
    sortOrder: 1,
    features: [
      '1 vehículo principal incluido',
      'Rastreo satelital en tiempo real',
      'Historial de rutas (30 días)',
      'Alertas de encendido y velocidad',
      'App móvil PWA para toda la familia',
      '+25% por vehículo adicional ($12.488)',
    ],
  },
  {
    code: 'VEH-PYME',
    name: 'Plan Pyme / Flotas Pro',
    description: 'Rastreo GPS en vivo de alta frecuencia para flotas comerciales.',
    price: 19990,
    currency: 'CLP',
    period: 'CLP / mes por móvil',
    category: 'vehicles',
    icon: '🚀',
    tag: 'Más Popular',
    highlight: true,
    maxDevices: 5,
    durationDays: 30,
    targetType: 'company',
    sortOrder: 2,
    features: [
      'Rastreo GPS en vivo (actualización 4s)',
      'Historial de viajes 90 días + Playback',
      'Corte de motor remoto y geocercas',
      'Monitoreo de combustible y kilometraje',
      'Reportes ejecutivos en PDF y Excel',
      'Integración con Bot de Telegram 24/7',
    ],
  },
  {
    code: 'VEH-CORP',
    name: 'Plan Corporativo 360',
    description: 'Telemetría industrial avanzada IMU, detección de choques y caja negra.',
    price: 34990,
    currency: 'CLP',
    period: 'CLP / mes por móvil',
    category: 'vehicles',
    icon: '🏢',
    tag: 'Empresarial',
    highlight: false,
    maxDevices: 30,
    durationDays: 30,
    targetType: 'company',
    sortOrder: 3,
    features: [
      'Todo lo del Plan Pyme Flotas',
      'Telemetría avanzada IMU & Fuerza G',
      'Detección automática de choques e impactos',
      'Modo Centinela anti-manipulación activo',
      'Caja Negra offline de alta redundancia',
      'Soporte técnico dedicado prioritario',
    ],
  },

  // ─── Rastreo Celular & Personal SOS ───────────────────────────────────────
  {
    code: 'PERS-INDIVIDUAL',
    name: 'Protección Personal SOS',
    description: '1 smartphone celular rastreado con botón de pánico satelital.',
    price: 4990,
    currency: 'CLP',
    period: 'CLP / mes por persona',
    category: 'people',
    icon: '👤',
    tag: 'Individual',
    highlight: false,
    maxDevices: 1,
    durationDays: 30,
    targetType: 'user',
    sortOrder: 4,
    features: [
      '1 celular smartphone rastreado',
      'Geolocalización satelital en vivo',
      'Botón de Pánico SOS Instantáneo',
      'Sirena sonora y síntesis de voz',
      'Monitoreo de nivel de batería %',
      'Enlace privado directo para WhatsApp',
    ],
  },
  {
    code: 'PERS-FAMILIAR',
    name: 'Pack Familiar 360',
    description: 'Hasta 3 familiares con botón de pánico SOS y alertas a Telegram.',
    price: 9990,
    currency: 'CLP',
    period: 'CLP / mes (hasta 3 personas)',
    category: 'people',
    icon: '👨‍👩‍👧‍👦',
    tag: 'Recomendado',
    highlight: true,
    maxDevices: 3,
    durationDays: 30,
    targetType: 'user',
    sortOrder: 5,
    features: [
      'Hasta 3 familiares / teléfonos incluidos',
      'Botón de Pánico SOS con mapa satelital',
      'Alertas directas a Telegram de la familia',
      'Historial de desplazamientos 30 días',
      'Sin contratos de permanencia',
    ],
  },
  {
    code: 'PERS-CUADRILLAS',
    name: 'Seguridad & Cuadrillas',
    description: 'Hasta 10 guardias o trabajadores de campo con panel centralizado.',
    price: 24990,
    currency: 'CLP',
    period: 'CLP / mes (hasta 10 personas)',
    category: 'people',
    icon: '🛡️',
    tag: 'Guardias & Terreno',
    highlight: false,
    maxDevices: 10,
    durationDays: 30,
    targetType: 'company',
    sortOrder: 6,
    features: [
      'Hasta 10 trabajadores de campo / guardias',
      'Panel centralizado de emergencias SOS',
      'Mapa táctico con actualización en tiempo real',
      'Registro de rondas y puntos de control',
      'Reporte de asistencia y cobertura',
    ],
  },
];

// ─── Catalogo de planes GPS (publico con auto-seed y sincronizacion) ──────────
router.get('/plans', async (req, res) => {
  try {
    const { category } = req.query; // 'vehicles' | 'people' | undefined
    let query = { isActive: true };
    if (category) query.category = category;

    let plans = await Plan.find(query).sort({ sortOrder: 1, price: 1 });
    if (!plans || plans.length === 0) {
      for (const p of DEFAULT_PLANS) {
        await Plan.findOneAndUpdate({ code: p.code }, p, { upsert: true, new: true });
      }
      plans = await Plan.find(query).sort({ sortOrder: 1, price: 1 });
    }
    res.json({ success: true, plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Crear preferencia de pago ────────────────────────────────────────────────
router.post('/create', authenticate, async (req, res) => {
  try {
    const { planCode, customerId, customerModel } = req.body;

    if (!planCode) return res.status(400).json({ error: 'planCode es requerido' });

    const resolvedCustomerId = customerId || req.user.id;
    const resolvedModel = customerModel || (req.user.company ? 'Company' : 'User');

    const result = await createPayment(resolvedCustomerId, resolvedModel, planCode);

    res.json({
      success: true,
      paymentId: result.paymentId,
      preferenceId: result.preferenceId,
      checkoutUrl: result.checkoutUrl,
      sandboxUrl: result.sandboxUrl,
      planName: result.planName,
      amount: result.amount,
      currency: result.currency,
    });
  } catch (err) {
    console.error('[POST /payments/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Retomar / Reintentar Pago Pendiente ───────────────────────────────────────
router.post('/:paymentId/retry', authenticate, async (req, res) => {
  try {
    const result = await retryPayment(req.params.paymentId);
    res.json({
      success: true,
      paymentId: result.paymentId,
      preferenceId: result.preferenceId,
      checkoutUrl: result.checkoutUrl,
      sandboxUrl: result.sandboxUrl,
      planName: result.planName,
      amount: result.amount,
      currency: result.currency,
    });
  } catch (err) {
    console.error('[POST /payments/:paymentId/retry]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Modificar Estado de Pago (Admin / Superadmin) ─────────────────────────────
router.patch('/:paymentId/status', authenticate, async (req, res) => {
  try {
    // Permitir a superadmin y admin
    if (!['superadmin', 'admin', 'fleet_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para modificar pagos' });
    }

    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Estado es requerido' });

    const result = await updatePaymentStatus(req.params.paymentId, status, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[PATCH /payments/:paymentId/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Eliminar o Cancelar Pago Pendiente ────────────────────────────────────────
router.delete('/:paymentId', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });

    // Si ya está aprobado, solo superadmin puede eliminar
    if (payment.status === 'approved' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Solo un superadmin puede eliminar pagos aprobados' });
    }

    await Payment.findByIdAndDelete(req.params.paymentId);
    res.json({ success: true, message: 'Pago eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook de Mercado Pago ──────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  try {
    console.log('[webhook MP] Notificacion recibida:', JSON.stringify(req.body));
    const result = await processWebhook(req.body);
    res.status(200).json({ received: true, result });
  } catch (err) {
    console.error('[webhook MP] Error:', err.message);
    res.status(200).json({ received: true, error: err.message });
  }
});

// ─── Suscripcion activa del cliente ───────────────────────────────────────────
router.get('/subscription/:customerId', authenticate, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { model } = req.query;

    let customerModel = model;
    if (!customerModel) {
      const Company = (await import('../models/Company.js')).default;
      const company = await Company.findById(customerId).catch(() => null);
      customerModel = company ? 'Company' : 'User';
    }

    const status = await checkSubscriptionStatus(customerId, customerModel);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Historial de pagos del cliente o general (Superadmin) ────────────────────
router.get('/history/:customerId', authenticate, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { limit = 50, skip = 0, all } = req.query;

    // Si es superadmin y pasa all=true, devolver todos los pagos del sistema
    let filter = { customerId };
    if (all === 'true' && req.user.role === 'superadmin') {
      filter = {};
    }

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('-__v');

    const total = await Payment.countDocuments(filter);
    res.json({ success: true, payments, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Estado de un pago especifico ─────────────────────────────────────────────
router.get('/:paymentId', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId)
      .populate('subscriptionId', 'status startedAt expiresAt planCode maxDevices');
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    res.json({ success: true, payment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Job de expiracion ────────────────────────────────────────────────────────
router.post('/run-expiry-check', async (req, res) => {
  const secret = req.headers['x-expiry-secret'] || req.body.secret;
  if (secret !== process.env.EXPIRY_CHECK_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const result = await runExpiryCheck();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Seed inicial y forzado de planes ─────────────────────────────────────────
router.post('/seed-plans', authenticate, async (req, res) => {
  try {
    const results = [];
    for (const planData of DEFAULT_PLANS) {
      const plan = await Plan.findOneAndUpdate(
        { code: planData.code },
        { ...planData, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      results.push(plan.code);
    }

    res.json({ success: true, message: `${results.length} planes cargados y actualizados`, plans: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

