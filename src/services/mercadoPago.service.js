/**
 * mercadoPago.service.js
 * Wrapper del SDK oficial de Mercado Pago v2.
 * Mantiene toda la logica de comunicacion con la API de MP centralizada aqui.
 */
import { MercadoPagoConfig, Preference, Payment as MPPayment } from 'mercadopago';

const DEFAULT_MP_TOKEN = 'APP_USR-688766111264020-122409-679374d6a8091ac45e5120946e13d4da-3089068043';
const DEFAULT_SUCCESS_URL = 'https://einsoft-gp-sfrntnd.vercel.app/payment-success';
const DEFAULT_FAILURE_URL = 'https://einsoft-gp-sfrntnd.vercel.app/payment-failed';
const DEFAULT_PENDING_URL = 'https://einsoft-gp-sfrntnd.vercel.app/payment-pending';
const DEFAULT_WEBHOOK_URL = 'https://einsoft-gp-sbcknd.vercel.app/api/payments/webhook';

let mpClient = null;

const getMPClient = () => {
  if (!mpClient) {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN || DEFAULT_MP_TOKEN;
    mpClient = new MercadoPagoConfig({
      accessToken: token,
      options: { timeout: 10000 },
    });
  }
  return mpClient;
};

/**
 * Crea una preferencia de pago en Mercado Pago.
 * @param {Object} customer - { id, name, email }
 * @param {Object} plan     - { code, name, price, currency, durationDays }
 * @param {string} paymentDocId - ID del documento Payment en MongoDB
 * @returns {{ preferenceId, checkoutUrl, sandboxUrl }}
 */
export async function createPreference(customer, plan, paymentDocId) {
  const client = getMPClient();
  const preferenceClient = new Preference(client);

  const successUrl = process.env.MERCADOPAGO_SUCCESS_URL || DEFAULT_SUCCESS_URL;
  const failureUrl = process.env.MERCADOPAGO_FAILURE_URL || DEFAULT_FAILURE_URL;
  const pendingUrl = process.env.MERCADOPAGO_PENDING_URL || DEFAULT_PENDING_URL;
  const webhookUrl = process.env.MERCADOPAGO_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;

  const preference = await preferenceClient.create({
    body: {
      items: [
        {
          id: plan.code,
          title: `EINSoft GPS — ${plan.name}`,
          description: `Suscripcion GPS por ${plan.durationDays} dias. Hasta ${plan.maxDevices} dispositivo(s).`,
          quantity: 1,
          unit_price: plan.price,
          currency_id: plan.currency || 'CLP',
        },
      ],
      payer: {
        name: customer.name || 'Cliente EINSoft',
        email: customer.email || 'cliente@einsoftgps.com',
      },
      back_urls: {
        success: `${successUrl}?payment_id=${paymentDocId}`,
        failure: `${failureUrl}?payment_id=${paymentDocId}`,
        pending: `${pendingUrl}?payment_id=${paymentDocId}`,
      },
      auto_return: 'approved',
      external_reference: paymentDocId.toString(),
      notification_url: webhookUrl,
      statement_descriptor: 'EINSOFT GPS',
      expires: false,
    },
  });

  return {
    preferenceId: preference.id,
    checkoutUrl: preference.init_point,
    sandboxUrl: preference.sandbox_init_point,
  };
}

/**
 * Consulta el estado real de un pago directamente a la API de MP.
 * Usar siempre en el webhook para verificar antes de activar servicio.
 * @param {string} mpPaymentId - ID del pago en Mercado Pago
 * @returns {Object} Datos del pago de MP
 */
export async function getMPPaymentById(mpPaymentId) {
  const client = getMPClient();
  const paymentClient = new MPPayment(client);
  const payment = await paymentClient.get({ id: mpPaymentId });
  return payment;
}
