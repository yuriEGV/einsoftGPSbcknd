import mongoose from 'mongoose';

/**
 * BotUser — Autoriza un Telegram ID para interactuar con el bot EINSoft GPS.
 * Un BotUser puede ser creado por el admin y vinculado a un usuario del sistema.
 */
const botUserSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  telegramUsername: {
    type: String,
    default: '',
  },
  telegramFirstName: {
    type: String,
    default: '',
  },
  // Linked system user (optional — can be a standalone bot-only user)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false,
  },
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'operator', 'driver', 'viewer'],
    default: 'viewer',
  },
  // Restrict which vehicles this bot user can see. Empty = all company vehicles.
  allowedVehicles: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
    },
  ],
  enabled: {
    type: Boolean,
    default: true,
  },
  // Conversation state machine for multi-step flows
  state: {
    type: String,
    default: 'idle', // idle | awaiting_vehicle | awaiting_person | ...
  },
  stateData: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  lastActivity: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.models.BotUser || mongoose.model('BotUser', botUserSchema);
