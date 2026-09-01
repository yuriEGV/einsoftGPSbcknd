/**
 * mercadoPago.service.js
 * Wrapper del SDK oficial de Mercado Pago v2.
 * Mantiene toda la logica de comunicacion con la API de MP centralizada aqui.
 */
import { MercadoPagoConfig, Preference, Payment as MPPayment } from 'mercadopago';

let mpClient = null;

const getMPClient = () => {
  if (!mpClient) {
    mpClient = new MercadoPagoConfig({
      accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
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

  const preference = await preferenceClient.create({
    body: {
      items: [
        {
          id: plan.code,
          title: EINSoft GPS — ,
          description: Suscripcion GPS por  dias. Hasta  dispositivo(s).,
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
        success: ${process.env.MERCADOPAGO_SUCCESS_URL}?payment_id=,
        failure: ${process.env.MERCADOPAGO_FAILURE_URL}?payment_id=,
        pending: ${process.env.MERCADOPAGO_PENDING_URL}?payment_id=,
      },
      auto_return: 'approved',
      external_reference: paymentDocId.toString(),
      notification_url: process.env.MERCADOPAGO_WEBHOOK_URL,
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
