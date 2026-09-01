import mongoose from 'mongoose';

/**
 * Payment — Registro individual de cada transaccion de pago.
 * NUNCA mezclado con el modelo User ni Company.
 *
 * Estados sincronizados con Mercado Pago:
 *   pending       — Preferencia creada, esperando pago
 *   approved      — Pago aprobado por MP
 *   rejected      — Pago rechazado
 *   cancelled     — Cancelado antes de pagar
 *   refunded      — Devuelto
 *   charged_back  — Contracargo iniciado
 */
const paymentSchema = new mongoose.Schema({
  // Quien paga
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

  // Suscripcion asociada (null hasta que se active)
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription',
    default: null,
  },

  // Proveedor de pago
  provider: {
    type: String,
    default: 'mercadopago',
    enum: ['mercadopago'],
  },

  // IDs de Mercado Pago
  preferenceId: { type: String, default: null },  // ID de la preferencia creada
  mpPaymentId: { type: String, default: null },   // ID del pago real confirmado por MP

  // Monto
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'CLP', uppercase: true },

  // Estado del pago
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back'],
    default: 'pending',
  },

  // Timestamps de eventos
  createdAt: { type: Date, default: Date.now },
  approvedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },

  // Metadata adicional (plan, etc.)
  metadata: {
    planCode: { type: String, default: '' },
    planName: { type: String, default: '' },
    mpStatus: { type: String, default: '' },       // estado raw de MP
    mpStatusDetail: { type: String, default: '' }, // detalle de MP
    externalReference: { type: String, default: '' },
  },

  updatedAt: { type: Date, default: Date.now },
});

paymentSchema.index({ customerId: 1, customerModel: 1, createdAt: -1 });
paymentSchema.index({ preferenceId: 1 });
paymentSchema.index({ mpPaymentId: 1 });
paymentSchema.index({ status: 1 });

export default mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
