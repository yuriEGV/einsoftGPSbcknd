/**
 * payments.js — Rutas del sistema de pagos EINSoft GPS.
 *
 * GET  /api/payments/plans                          — Catalogo de planes (publico)
 * POST /api/payments/create                         — Crear preferencia de pago MP
 * POST /api/payments/webhook                        — Webhook de Mercado Pago
 * GET  /api/payments/subscription/:customerId       — Suscripcion activa del cliente
 * GET  /api/payments/history/:customerId            — Historial de pagos
 * GET  /api/payments/:paymentId                     — Estado de un pago especifico
 * POST /api/payments/run-expiry-check               — Job protegido de expiracion
 * POST /api/payments/seed-plans                     — Carga inicial de planes (solo superadmin)
 */
import express from 'express';
import Plan from '../models/Plan.js';
import Payment from '../models/Payment.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { createPayment, processWebhook } from '../services/payment.service.js';
import { checkSubscriptionStatus, runExpiryCheck } from '../services/subscription.service.js';

const router = express.Router();

const DEFAULT_PLANS = [
  {
    code: 'GPS-BASICO',
    name: 'GPS Basico',
    description: 'Ideal para 1 vehiculo o persona. Monitoreo en tiempo real.',
    price: 4990,
    currency: 'CLP',
    maxDevices: 1,
    durationDays: 30,
    targetType: 'both',
    sortOrder: 1,
    features: [
      'Monitoreo en tiempo real',
      'Historial de recorridos 30 dias',
      'Alertas basicas',
      '1 dispositivo GPS',
    ],
  },
  {
    code: 'GPS-FAMILIAR',
    name: 'GPS Familiar',
    description: 'Para hasta 3 personas o vehiculos. Perfecto para familias.',
    price: 8990,
    currency: 'CLP',
    maxDevices: 3,
    durationDays: 30,
    targetType: 'user',
    sortOrder: 2,
    features: [
      'Monitoreo en tiempo real',
      'Historial de recorridos 60 dias',
      'Alertas de panico SOS',
      'Geocercas personalizadas',
      'Hasta 3 dispositivos GPS',
    ],
  },
  {
    code: 'GPS-EMPRESA',
    name: 'GPS Empresa',
    description: 'Gestion de flota corporativa. Hasta 10 vehiculos o personas.',
    price: 19990,
    currency: 'CLP',
    maxDevices: 10,
    durationDays: 30,
    targetType: 'company',
    sortOrder: 3,
    features: [
      'Monitoreo en tiempo real',
      'Historial ilimitado',
      'Reportes y estadisticas',
      'Alertas avanzadas y SOS',
      'Gestion de conductores',
      'Geocercas ilimitadas',
      'Hasta 10 dispositivos GPS',
    ],
  },
  {
    code: 'GPS-EMPRESA-PRO',
    name: 'GPS Empresa Pro',
    description: 'Para flotas grandes. Hasta 30 dispositivos y soporte prioritario.',
    price: 39990,
    currency: 'CLP',
    maxDevices: 30,
    durationDays: 30,
    targetType: 'company',
    sortOrder: 4,
    features: [
      'Monitoreo en tiempo real',
      'Historial ilimitado',
      'Reportes avanzados PDF/Excel',
      'Alertas personalizadas y SOS',
      'IA de comportamiento conductores',
      'Geocercas ilimitadas',
      'API de integracion',
      'Soporte prioritario 24/7',
      'Hasta 30 dispositivos GPS',
    ],
  },
];

// ─── Catalogo de planes GPS (publico con auto-seed) ───────────────────────────
router.get('/plans', async (req, res) => {
  try {
    let plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, price: 1 });
    if (!plans || plans.length === 0) {
      for (const p of DEFAULT_PLANS) {
        await Plan.findOneAndUpdate({ code: p.code }, p, { upsert: true, new: true });
      }
      plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, price: 1 });
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

    // Si no se especifica customerId, usar el usuario autenticado
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

// ─── Webhook de Mercado Pago ──────────────────────────────────────────────────
// IMPORTANTE: Sin auth JWT — Mercado Pago llama a esta ruta directamente.
// La verificacion de autenticidad se hace consultando el estado real a MP API.
router.post('/webhook', async (req, res) => {
  try {
    console.log('[webhook MP] Notificacion recibida:', JSON.stringify(req.body));
    const result = await processWebhook(req.body);
    // Siempre responder 200 a MP para que no reintente
    res.status(200).json({ received: true, result });
  } catch (err) {
    console.error('[webhook MP] Error:', err.message);
    // Igual respondemos 200 para que MP no marque el webhook como fallido
    res.status(200).json({ received: true, error: err.message });
  }
});

// ─── Suscripcion activa del cliente ───────────────────────────────────────────
router.get('/subscription/:customerId', authenticate, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { model } = req.query; // 'Company' | 'User' (default: auto-detectar)

    let customerModel = model;
    if (!customerModel) {
      // Auto-detectar: si customerId es una empresa existente, usar 'Company'
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

// ─── Historial de pagos del cliente ───────────────────────────────────────────
router.get('/history/:customerId', authenticate, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { limit = 20, skip = 0 } = req.query;

    const payments = await Payment.find({ customerId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('-__v');

    const total = await Payment.countDocuments({ customerId });
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

// ─── Job de expiracion (protegido por secret, para cron externo) ──────────────
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

// ─── Seed inicial de planes (solo superadmin) ─────────────────────────────────
router.post('/seed-plans', authenticate, requireRole('superadmin'), async (req, res) => {
  try {
    const defaultPlans = [
      {
        code: 'GPS-BASICO',
        name: 'GPS Basico',
        description: 'Ideal para 1 vehiculo o persona. Monitoreo en tiempo real.',
        price: 4990,
        currency: 'CLP',
        maxDevices: 1,
        durationDays: 30,
        targetType: 'both',
        sortOrder: 1,
        features: [
          'Monitoreo en tiempo real',
          'Historial de recorridos 30 dias',
          'Alertas basicas',
          '1 dispositivo GPS',
        ],
      },
      {
        code: 'GPS-FAMILIAR',
        name: 'GPS Familiar',
        description: 'Para hasta 3 personas o vehiculos. Perfecto para familias.',
        price: 8990,
        currency: 'CLP',
        maxDevices: 3,
        durationDays: 30,
        targetType: 'user',
        sortOrder: 2,
        features: [
          'Monitoreo en tiempo real',
          'Historial de recorridos 60 dias',
          'Alertas de panico SOS',
          'Geocercas personalizadas',
          'Hasta 3 dispositivos GPS',
        ],
      },
      {
        code: 'GPS-EMPRESA',
        name: 'GPS Empresa',
        description: 'Gestion de flota corporativa. Hasta 10 vehiculos o personas.',
        price: 19990,
        currency: 'CLP',
        maxDevices: 10,
        durationDays: 30,
        targetType: 'company',
        sortOrder: 3,
        features: [
          'Monitoreo en tiempo real',
          'Historial ilimitado',
          'Reportes y estadisticas',
          'Alertas avanzadas y SOS',
          'Gestion de conductores',
          'Geocercas ilimitadas',
          'Hasta 10 dispositivos GPS',
        ],
      },
      {
        code: 'GPS-EMPRESA-PRO',
        name: 'GPS Empresa Pro',
        description: 'Para flotas grandes. Hasta 30 dispositivos y soporte prioritario.',
        price: 39990,
        currency: 'CLP',
        maxDevices: 30,
        durationDays: 30,
        targetType: 'company',
        sortOrder: 4,
        features: [
          'Monitoreo en tiempo real',
          'Historial ilimitado',
          'Reportes avanzados PDF/Excel',
          'Alertas personalizadas y SOS',
          'IA de comportamiento conductores',
          'Geocercas ilimitadas',
          'API de integracion',
          'Soporte prioritario 24/7',
          'Hasta 30 dispositivos GPS',
        ],
      },
    ];

    const results = [];
    for (const planData of defaultPlans) {
      const plan = await Plan.findOneAndUpdate(
        { code: planData.code },
        { ...planData, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      results.push(plan.code);
    }

    res.json({ success: true, message: `${results.length} planes cargados`, plans: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
