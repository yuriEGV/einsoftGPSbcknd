import mongoose from 'mongoose';

/**
 * PanicAlert — Entidad de ciclo de vida completa para alertas de pánico de vehículos y personas.
 * Separada de Alert.js para tener su propio historial, estados y flujo de reconocimiento.
 */
const panicAlertSchema = new mongoose.Schema({
  // ── Origen ───────────────────────────────────────────────────────────────────
  source: {
    type: String,
    enum: ['vehicle', 'person'],
    required: true,
  },
  vehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: false,
  },
  person: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PersonTracker',
    required: false,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false,
  },

  // ── Ubicación ────────────────────────────────────────────────────────────────
  latitude: Number,
  longitude: Number,
  address: String,
  speed: { type: Number, default: 0 },

  // ── Estado del ciclo de vida ─────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_ALARM'],
    default: 'ACTIVE',
    index: true,
  },

  // ── Reconocimiento ───────────────────────────────────────────────────────────
  acknowledgedBy: {
    type: String, // Telegram username or system user name
    default: null,
  },
  acknowledgedAt: Date,
  resolvedAt: Date,
  notes: String,

  // ── Notificaciones ───────────────────────────────────────────────────────────
  telegramNotified: { type: Boolean, default: false },
  telegramMessageId: String, // ID of the Telegram message (for edit/follow-up)
  telegramChatIds: [String], // All chats that received this alert

  // ── Metadata ─────────────────────────────────────────────────────────────────
  triggeredAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  expiresAt: {
    type: Date,
    default: () => new Date(+new Date() + 30 * 24 * 60 * 60 * 1000), // 30 days
    index: { expires: 0 },
  },
});

panicAlertSchema.index({ status: 1, triggeredAt: -1 });
panicAlertSchema.index({ vehicle: 1 });
panicAlertSchema.index({ person: 1 });

export default mongoose.models.PanicAlert || mongoose.model('PanicAlert', panicAlertSchema);
