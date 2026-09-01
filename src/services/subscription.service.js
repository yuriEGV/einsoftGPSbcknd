/**
 * subscription.service.js
 * Logica de negocio para activar, consultar y expirar suscripciones GPS.
 */
import Payment from '../models/Payment.js';
import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import User from '../models/User.js';
import Company from '../models/Company.js';

/**
 * Activa el servicio GPS una vez que el pago fue aprobado por MP.
 * Crea o renueva la suscripcion del cliente.
 * @param {string} paymentId - ID del documento Payment en MongoDB
 */
export async function activateGPSService(paymentId) {
  const payment = await Payment.findById(paymentId).populate('subscriptionId');
  if (!payment) throw new Error('Pago no encontrado: ' + paymentId);
  if (payment.status !== 'approved') throw new Error('El pago no esta aprobado');

  let plan = await Plan.findOne({ code: payment.metadata.planCode });
  if (!plan) {
    // Alias fallback
    const ALIAS_MAP = {
      'GPS-BASICO': 'PERS-INDIVIDUAL',
      'GPS-FAMILIAR': 'PERS-FAMILIAR',
      'GPS-EMPRESA': 'VEH-PYME',
      'GPS-EMPRESA-PRO': 'VEH-CORP',
    };
    const mapped = ALIAS_MAP[payment.metadata.planCode];
    if (mapped) plan = await Plan.findOne({ code: mapped });
  }
  if (!plan) {
    // Default fallback to first active plan if not found
    plan = await Plan.findOne({ isActive: true }).sort({ sortOrder: 1 });
  }
  if (!plan) throw new Error('Plan no encontrado: ' + payment.metadata.planCode);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  // Buscar suscripcion existente del cliente
  let subscription = await Subscription.findOne({
    customerId: payment.customerId,
    customerModel: payment.customerModel,
  });

  if (subscription) {
    // Renovar suscripcion existente
    // Si aun esta activa, sumar dias desde la fecha de vencimiento actual
    const base = subscription.status === 'active' && subscription.expiresAt > now
      ? subscription.expiresAt
      : now;
    subscription.expiresAt = new Date(base.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    subscription.status = 'active';
    subscription.plan = plan._id;
    subscription.planCode = plan.code;
    subscription.maxDevices = plan.maxDevices;
    subscription.lastPaymentId = payment._id;
    subscription.startedAt = subscription.startedAt || now;
    subscription.paymentHistory.push(payment._id);
    subscription.updatedAt = now;
  } else {
    // Crear nueva suscripcion
    subscription = new Subscription({
      customerId: payment.customerId,
      customerModel: payment.customerModel,
      plan: plan._id,
      planCode: plan.code,
      status: 'active',
      startedAt: now,
      expiresAt,
      maxDevices: plan.maxDevices,
      lastPaymentId: payment._id,
      paymentHistory: [payment._id],
    });
  }

  await subscription.save();

  // Vincular suscripcion al pago
  payment.subscriptionId = subscription._id;
  payment.updatedAt = now;
  await payment.save();

  // Si es empresa, actualizar el plan de suscripcion en Company
  if (payment.customerModel === 'Company') {
    const planMap = {
      'VEH-FAMILIAR': 'basic',
      'VEH-PYME': 'pro',
      'VEH-CORP': 'enterprise',
      'PERS-INDIVIDUAL': 'basic',
      'PERS-FAMILIAR': 'basic',
      'PERS-CUADRILLAS': 'pro',
      'GPS-BASICO': 'basic',
      'GPS-FAMILIAR': 'basic',
      'GPS-EMPRESA': 'pro',
      'GPS-EMPRESA-PRO': 'enterprise',
    };
    const newPlan = planMap[plan.code] || 'basic';
    await Company.findByIdAndUpdate(payment.customerId, {
      subscriptionPlan: newPlan,
      isActive: true,
      updatedAt: now,
    });
  }

  console.log('[subscription] GPS activado para', payment.customerModel, payment.customerId.toString(), 'plan:', plan.code, 'vence:', expiresAt.toISOString());
  return subscription;
}

/**
 * Consulta el estado de suscripcion activa de un cliente.
 * @param {string} customerId
 * @param {string} customerModel - 'Company' | 'User'
 * @returns {{ hasSubscription, status, plan, expiresAt, daysLeft, maxDevices }}
 */
export async function checkSubscriptionStatus(customerId, customerModel) {
  const subscription = await Subscription.findOne({ customerId, customerModel })
    .populate('plan', 'name code price currency maxDevices durationDays features')
    .populate('lastPaymentId', 'status amount approvedAt');

  if (!subscription) {
    return { hasSubscription: false, status: 'none' };
  }

  const now = new Date();
  const daysLeft = subscription.expiresAt
    ? Math.max(0, Math.ceil((subscription.expiresAt - now) / (1000 * 60 * 60 * 24)))
    : 0;

  return {
    hasSubscription: true,
    status: subscription.status,
    active: subscription.status === 'active' && subscription.expiresAt > now,
    plan: subscription.plan,
    planCode: subscription.planCode,
    startedAt: subscription.startedAt,
    expiresAt: subscription.expiresAt,
    daysLeft,
    maxDevices: subscription.maxDevices,
    lastPayment: subscription.lastPaymentId,
  };
}

/**
 * Job de expiracion: busca suscripciones vencidas y las suspende.
 * Se llama desde el endpoint protegido /api/payments/run-expiry-check.
 * @returns {{ processed, expired }}
 */
export async function runExpiryCheck() {
  const now = new Date();
  const expiredSubs = await Subscription.find({
    status: 'active',
    expiresAt: { '': now },
  });

  let expired = 0;
  for (const sub of expiredSubs) {
    sub.status = 'expired';
    sub.updatedAt = now;
    await sub.save();

    // Si es empresa, marcarla como suspendida
    if (sub.customerModel === 'Company') {
      await Company.findByIdAndUpdate(sub.customerId, {
        subscriptionPlan: 'free',
        updatedAt: now,
      }).catch(() => {});
    }

    expired++;
    console.log('[subscription] Suscripcion expirada:', sub.customerId.toString(), sub.planCode);
  }

  return { processed: expiredSubs.length, expired };
}
