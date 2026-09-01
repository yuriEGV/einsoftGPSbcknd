import mongoose from 'mongoose';

/**
 * Subscription — Suscripcion GPS activa de un cliente (empresa o usuario individual).
 * 
 * Estados:
 *   trial      — Periodo de prueba gratuito
 *   active     — Servicio GPS activo y pagado
 *   expired    — Fecha de vencimiento superada
 *   suspended  — Suspendido por falta de pago o administrativo
 *   cancelled  — Cancelado por el cliente
 */
const subscriptionSchema = new mongoose.Schema({
  // Quien tiene la suscripcion (empresa o usuario individual)
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'customerModel',
  },
  customerModel: {
    type: String,
    required: true,
    enum: ['Company', 'User'],
  },

  // Plan contratado
  plan: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Plan',
    required: true,
  },
  planCode: { type: String, required: true }, // desnormalizado para consultas rapidas

  status: {
    type: String,
    enum: ['trial', 'active', 'expired', 'suspended', 'cancelled'],
    default: 'trial',
  },

  startedAt: { type: Date },
  expiresAt: { type: Date },

  maxDevices: { type: Number, default: 1 },

  // Referencia al ultimo pago que activo esta suscripcion
  lastPaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
  },

  // Historico de pagos asociados
  paymentHistory: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
  }],

  // Notas internas del admin
  notes: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

subscriptionSchema.index({ customerId: 1, customerModel: 1 });
subscriptionSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
