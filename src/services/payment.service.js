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

/**
 * Crea una preferencia de pago en Mercado Pago y guarda el registro Payment(pending).
 * @param {string} customerId     - ID del User o Company
 * @param {string} customerModel  - 'User' | 'Company'
 * @param {string} planCode       - e.g. 'GPS-BASICO'
 * @returns {{ paymentId, checkoutUrl, sandboxUrl, planName, amount }}
 */
export async function createPayment(customerId, customerModel, planCode) {
  // 1. Buscar plan
  const plan = await Plan.findOne({ code: planCode.toUpperCase(), isActive: true });
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

  // 5. Guardar preferenceId en el registro de pago
  paymentDoc.preferenceId = preferenceId;
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
