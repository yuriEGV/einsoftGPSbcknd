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
    expiresAt: { $lt: now },
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

/**
 * Determina el estado de suscripción del usuario, límites y conteo de consultas del día.
 * - Modo Gratuito: 1 dispositivo máximo, 1 consulta diaria. Bloqueo inmediato tras la 1ª consulta.
 * - Modo Pago: Dispositivos según plan, consultas ilimitadas, desbloqueo total.
 */
export async function getUserSubscriptionAndLimits(userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('Usuario no encontrado');

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // 1. Superadmin tiene acceso universal
  if (user.role === 'superadmin') {
    return {
      isPaid: true,
      isSuperadmin: true,
      planCode: 'SUPERADMIN',
      planName: 'Acceso Total Superadministrador',
      maxDevices: 9999,
      dailyLimit: Infinity,
      queriesUsed: 0,
      remainingQueries: Infinity,
      isBlocked: false,
      expiresAt: null,
    };
  }

  // 2. Suscripción activa individual
  let activeSub = await Subscription.findOne({
    customerId: user._id,
    customerModel: 'User',
    status: 'active',
    expiresAt: { $gt: now },
  }).populate('plan');

  // 3. Suscripción corporativa si pertenece a Company
  if (!activeSub && user.company) {
    activeSub = await Subscription.findOne({
      customerId: user.company,
      customerModel: 'Company',
      status: 'active',
      expiresAt: { $gt: now },
    }).populate('plan');

    if (!activeSub) {
      const company = await Company.findById(user.company);
      if (company && company.isActive && company.subscriptionPlan && company.subscriptionPlan !== 'free') {
        return {
          isPaid: true,
          planCode: `CORP-${company.subscriptionPlan.toUpperCase()}`,
          planName: `Plan Corporativo ${company.subscriptionPlan}`,
          maxDevices: company.subscriptionPlan === 'enterprise' ? 100 : 20,
          dailyLimit: Infinity,
          queriesUsed: 0,
          remainingQueries: Infinity,
          isBlocked: false,
          expiresAt: null,
        };
      }
    }
  }

  // 4. Flag manual subscriptionTier === 'paid'
  if (user.subscriptionTier === 'paid' && !activeSub) {
    return {
      isPaid: true,
      planCode: 'MEMBERSHIP-ACTIVE',
      planName: 'Membresía Activa',
      maxDevices: 10,
      dailyLimit: Infinity,
      queriesUsed: 0,
      remainingQueries: Infinity,
      isBlocked: false,
      expiresAt: null,
    };
  }

  // 5. Suscripción activa en MongoDB
  if (activeSub) {
    const daysLeft = Math.max(0, Math.ceil((activeSub.expiresAt - now) / (1000 * 60 * 60 * 24)));
    return {
      isPaid: true,
      subscriptionId: activeSub._id,
      planCode: activeSub.planCode,
      planName: activeSub.plan?.name || activeSub.planCode,
      maxDevices: activeSub.maxDevices || activeSub.plan?.maxDevices || 1,
      dailyLimit: Infinity,
      queriesUsed: 0,
      remainingQueries: Infinity,
      isBlocked: false,
      expiresAt: activeSub.expiresAt,
      daysLeft,
    };
  }

  // 6. Modo Demo / Gratuito Super Limitado
  const userDailyDate = user.dailyUsage?.date || '';
  const queriesUsed = (userDailyDate === today) ? (user.dailyUsage?.queryCount || 0) : 0;
  const DAILY_LIMIT = 1; // Solo 1 consulta diaria según requerimiento
  const remainingQueries = Math.max(0, DAILY_LIMIT - queriesUsed);
  const isBlocked = queriesUsed >= DAILY_LIMIT;

  return {
    isPaid: false,
    planCode: 'FREE_DEMO',
    planName: 'Modo Demo / Gratuito',
    maxDevices: 1, // Solo 1 vehículo o celular
    dailyLimit: DAILY_LIMIT,
    queriesUsed,
    remainingQueries,
    isBlocked,
    expiresAt: null,
    lastQueryAt: user.dailyUsage?.lastQueryAt || null,
  };
}

/**
 * Registra y descuenta una consulta diaria para usuarios gratuitos.
 * Si ya alcanzó el límite (1 consulta), lanza error DAILY_LIMIT_REACHED.
 */
export async function consumeDailyQuery(userId) {
  const limits = await getUserSubscriptionAndLimits(userId);
  if (limits.isPaid) {
    return { isPaid: true, allowed: true, remainingQueries: Infinity, isBlocked: false };
  }

  const today = new Date().toISOString().slice(0, 10);
  const user = await User.findById(userId);

  let currentCount = 0;
  if (user.dailyUsage && user.dailyUsage.date === today) {
    currentCount = user.dailyUsage.queryCount || 0;
  }

  const DAILY_LIMIT = 1;

  if (currentCount >= DAILY_LIMIT) {
    const err = new Error('DAILY_LIMIT_REACHED');
    err.code = 'DAILY_LIMIT_REACHED';
    err.statusCode = 403;
    err.usage = {
      dailyLimit: DAILY_LIMIT,
      queriesUsed: currentCount,
      remainingQueries: 0,
      isBlocked: true,
    };
    throw err;
  }

  // Incrementar conteo
  user.dailyUsage = {
    date: today,
    queryCount: currentCount + 1,
    lastQueryAt: new Date(),
  };
  await user.save();

  const newUsed = currentCount + 1;
  const remaining = Math.max(0, DAILY_LIMIT - newUsed);
  const isBlocked = newUsed >= DAILY_LIMIT;

  return {
    isPaid: false,
    allowed: true,
    dailyLimit: DAILY_LIMIT,
    queriesUsed: newUsed,
    remainingQueries: remaining,
    isBlocked,
  };
}

/**
 * Activa directamente un plan para un usuario (utilizado en testing, admin o confirmación).
 */
export async function activateDirectPlan(userId, planCode = 'VEH-FAMILIAR', durationDays = 30) {
  const user = await User.findById(userId);
  if (!user) throw new Error('Usuario no encontrado');

  let plan = await Plan.findOne({ code: planCode.toUpperCase() });
  if (!plan) {
    plan = await Plan.findOne({ isActive: true }).sort({ sortOrder: 1 });
  }

  const now = new Date();
  const days = durationDays || plan?.durationDays || 30;
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  let subscription = await Subscription.findOne({
    customerId: user._id,
    customerModel: 'User',
  });

  if (subscription) {
    subscription.status = 'active';
    subscription.plan = plan?._id || subscription.plan;
    subscription.planCode = plan?.code || planCode;
    subscription.maxDevices = plan?.maxDevices || 10;
    subscription.expiresAt = expiresAt;
    subscription.updatedAt = now;
    await subscription.save();
  } else {
    subscription = new Subscription({
      customerId: user._id,
      customerModel: 'User',
      plan: plan?._id,
      planCode: plan?.code || planCode,
      status: 'active',
      startedAt: now,
      expiresAt,
      maxDevices: plan?.maxDevices || 10,
    });
    await subscription.save();
  }

  user.subscriptionTier = 'paid';
  await user.save();

  return {
    success: true,
    message: `Plan ${plan?.name || planCode} activado exitosamente`,
    subscription,
  };
}
