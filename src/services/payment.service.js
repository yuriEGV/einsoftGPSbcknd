/**
 * payment.service.js
 * Orquesta la creacion de pagos y el procesamiento de webhooks de Mercado Pago.
 */
import Payment from '../models/Payment.js';
import Plan from '../models/Plan.js';
import User from '../models/User.js';
import Company from '../models/Company.js';
import { createPreference, getMPPaymentById } from './mercadoPago.service.js';
import { activateGPSService } from './subscription.service.js';

const ALIAS_MAP = {
  'GPS-BASICO': 'PERS-INDIVIDUAL',
  'GPS-FAMILIAR': 'PERS-FAMILIAR',
  'GPS-EMPRESA': 'VEH-PYME',
  'GPS-EMPRESA-PRO': 'VEH-CORP',
  'PLAN-PARTICULAR': 'VEH-FAMILIAR',
  'PLAN-PYME': 'VEH-PYME',
  'PLAN-CORPORATIVO': 'VEH-CORP',
};

/**
 * Crea una preferencia de pago en Mercado Pago y guarda el registro Payment(pending).
 * @param {string} customerId     - ID del User o Company
 * @param {string} customerModel  - 'User' | 'Company'
 * @param {string} planCode       - e.g. 'VEH-FAMILIAR' o 'GPS-BASICO'
 * @returns {{ paymentId, checkoutUrl, sandboxUrl, planName, amount }}
 */
export async function createPayment(customerId, customerModel, planCode) {
  // 1. Buscar plan (directo o por alias)
  const normalizedCode = planCode.toUpperCase();
  let plan = await Plan.findOne({ code: normalizedCode, isActive: true });
  if (!plan && ALIAS_MAP[normalizedCode]) {
    plan = await Plan.findOne({ code: ALIAS_MAP[normalizedCode], isActive: true });
  }
  if (!plan) throw new Error('Plan no encontrado o inactivo: ' + planCode);

  // 2. Resolver cliente (nombre + email para MP)
  let customer = { id: customerId, name: 'Cliente EINSoft', email: 'cliente@einsoftgps.com' };
  if (customerModel === 'Company') {
    const company = await Company.findById(customerId);
    if (!company) throw new Error('Empresa no encontrada');
    customer = { id: customerId, name: company.name, email: company.email || 'empresa@einsoftgps.com' };
  } else {
    const user = await User.findById(customerId);
    if (!user) throw new Error('Usuario no encontrado');
    customer = { id: customerId, name: user.name, email: user.email };
  }

  // 3. Crear registro Payment(pending) en MongoDB
  const paymentDoc = new Payment({
    customerId,
    customerModel,
    amount: plan.price,
    currency: plan.currency || 'CLP',
    status: 'pending',
    metadata: {
      planCode: plan.code,
      planName: plan.name,
    },
  });
  await paymentDoc.save();

  // 4. Crear preferencia en Mercado Pago
  const { preferenceId, checkoutUrl, sandboxUrl } = await createPreference(customer, plan, paymentDoc._id);

  // 5. Guardar preferenceId y URLs en el registro de pago
  paymentDoc.preferenceId = preferenceId;
  paymentDoc.checkoutUrl = checkoutUrl;
  paymentDoc.sandboxUrl = sandboxUrl;
  await paymentDoc.save();

  return {
    paymentId: paymentDoc._id,
    preferenceId,
    checkoutUrl,
    sandboxUrl,
    planName: plan.name,
    amount: plan.price,
    currency: plan.currency,
  };
}

/**
 * Reintenta / retoma un pago pendiente existente generando una preferencia MP fresca si es necesario.
 * @param {string} paymentId 
 */
export async function retryPayment(paymentId) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new Error('Pago no encontrado');
  if (payment.status === 'approved') throw new Error('Este pago ya fue aprobado');

  // Buscar plan asociado
  const normalizedCode = (payment.metadata?.planCode || '').toUpperCase();
  let plan = await Plan.findOne({ code: normalizedCode });
  if (!plan && ALIAS_MAP[normalizedCode]) {
    plan = await Plan.findOne({ code: ALIAS_MAP[normalizedCode] });
  }
  if (!plan) {
    plan = await Plan.findOne({ isActive: true }).sort({ sortOrder: 1 });
  }
  if (!plan) throw new Error('Plan no disponible para este pago');

  // Resolver cliente
  let customer = { id: payment.customerId, name: 'Cliente EINSoft', email: 'cliente@einsoftgps.com' };
  if (payment.customerModel === 'Company') {
    const company = await Company.findById(payment.customerId);
    if (company) customer = { id: company._id, name: company.name, email: company.email || 'empresa@einsoftgps.com' };
  } else {
    const user = await User.findById(payment.customerId);
    if (user) customer = { id: user._id, name: user.name, email: user.email };
  }

  // Generar preferencia fresca en MP
  const { preferenceId, checkoutUrl, sandboxUrl } = await createPreference(customer, plan, payment._id);
  payment.preferenceId = preferenceId;
  payment.checkoutUrl = checkoutUrl;
  payment.sandboxUrl = sandboxUrl;
  payment.status = 'pending';
  payment.updatedAt = new Date();
  await payment.save();

  return {
    paymentId: payment._id,
    preferenceId,
    checkoutUrl,
    sandboxUrl,
    planName: plan.name,
    amount: payment.amount,
    currency: payment.currency,
  };
}

/**
 * Modifica manualmente el estado de un pago (Superadmin / Admin).
 * Si se cambia a 'approved', activa automáticamente el servicio GPS.
 * @param {string} paymentId
 * @param {string} newStatus - 'approved' | 'pending' | 'rejected' | 'cancelled' | 'refunded'
 * @param {Object} adminUser
 */
export async function updatePaymentStatus(paymentId, newStatus, adminUser) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new Error('Pago no encontrado');

  const validStatuses = ['approved', 'pending', 'rejected', 'cancelled', 'refunded', 'charged_back'];
  if (!validStatuses.includes(newStatus)) {
    throw new Error('Estado inválido. Válidos: ' + validStatuses.join(', '));
  }

  const now = new Date();
  const oldStatus = payment.status;
  payment.status = newStatus;
  payment.updatedAt = now;

  if (newStatus === 'approved') {
    payment.approvedAt = payment.approvedAt || now;
  } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(newStatus)) {
    payment.rejectedAt = now;
  }

  payment.metadata = {
    ...payment.metadata,
    manualOverride: true,
    modifiedBy: adminUser?.email || 'admin',
    modifiedAt: now.toISOString(),
    previousStatus: oldStatus,
  };

  await payment.save();

  // Si fue marcado como approved, activar el servicio GPS
  let subscription = null;
  if (newStatus === 'approved') {
    subscription = await activateGPSService(payment._id.toString());
  }

  return {
    payment,
    subscription,
    message: `Estado actualizado de ${oldStatus} a ${newStatus}`,
  };
}

/**
 * Procesa la notificacion de webhook de Mercado Pago.
 * Verifica el estado REAL del pago directamente contra la API de MP.
 * @param {Object} webhookData - Body recibido del webhook
 */
export async function processWebhook(webhookData) {
  const { type, data } = webhookData;

  if (type !== 'payment' || !data?.id) {
    return { skipped: true, reason: 'Notificacion no es de tipo payment' };
  }

  const mpPaymentId = data.id.toString();

  // 1. Consultar estado REAL a la API de MP (nunca confiar solo en el webhook)
  let mpPayment;
  try {
    mpPayment = await getMPPaymentById(mpPaymentId);
  } catch (err) {
    console.error('[webhook] Error consultando pago a MP:', err.message);
    return { error: 'No se pudo consultar el pago a Mercado Pago' };
  }

  const mpStatus = mpPayment.status;
  const externalRef = mpPayment.external_reference; // es el paymentDocId en MongoDB

  // 2. Buscar el documento Payment en MongoDB por preferenceId o externalReference
  let paymentDoc = null;

  if (externalRef) {
    paymentDoc = await Payment.findById(externalRef).catch(() => null);
  }

  // Fallback: buscar por mpPaymentId ya registrado
  if (!paymentDoc) {
    paymentDoc = await Payment.findOne({ mpPaymentId }).catch(() => null);
  }

  if (!paymentDoc) {
    console.warn('[webhook] Pago no encontrado en BD. mpPaymentId:', mpPaymentId, 'externalRef:', externalRef);
    return { skipped: true, reason: 'Pago no encontrado en base de datos' };
  }

  // 3. Verificar monto (anti-fraude basico)
  if (mpPayment.transaction_amount && paymentDoc.amount > 0) {
    const diff = Math.abs(mpPayment.transaction_amount - paymentDoc.amount);
    if (diff > 10) { // tolerancia de  CLP por redondeo
      console.error('[webhook] ALERTA: Monto no coincide. Esperado:', paymentDoc.amount, 'Recibido:', mpPayment.transaction_amount);
      return { error: 'Monto del pago no coincide con el esperado' };
    }
  }

  // 4. Actualizar estado en MongoDB
  const now = new Date();
  paymentDoc.mpPaymentId = mpPaymentId;
  paymentDoc.status = mapMPStatus(mpStatus);
  paymentDoc.metadata.mpStatus = mpStatus;
  paymentDoc.metadata.mpStatusDetail = mpPayment.status_detail || '';
  paymentDoc.updatedAt = now;

  if (mpStatus === 'approved') {
    paymentDoc.approvedAt = now;
  } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(mpStatus)) {
    paymentDoc.rejectedAt = now;
  }

  await paymentDoc.save();

  // 5. Si fue aprobado, activar el servicio GPS
  if (paymentDoc.status === 'approved') {
    try {
      await activateGPSService(paymentDoc._id.toString());
      console.log('[webhook] Servicio GPS activado. PaymentId:', paymentDoc._id.toString());
      return { success: true, action: 'service_activated', paymentId: paymentDoc._id };
    } catch (activationErr) {
      console.error('[webhook] Error activando servicio GPS:', activationErr.message);
      return { error: 'Pago aprobado pero error al activar servicio: ' + activationErr.message };
    }
  }

  return { success: true, action: 'status_updated', status: paymentDoc.status };
}

/**
 * Mapea estados de Mercado Pago a los estados internos del sistema.
 */
function mapMPStatus(mpStatus) {
  const statusMap = {
    pending: 'pending',
    in_process: 'pending',
    in_mediation: 'pending',
    approved: 'approved',
    rejected: 'rejected',
    cancelled: 'cancelled',
    refunded: 'refunded',
    charged_back: 'charged_back',
  };
  return statusMap[mpStatus] || 'pending';
}
