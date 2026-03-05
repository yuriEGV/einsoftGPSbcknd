import mongoose from 'mongoose';

const alertSchema = new mongoose.Schema({
  vehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
  },
  type: {
    type: String,
    enum: [
      'speeding',
      'geofence_entry',
      'geofence_exit',
      'hard_acceleration',
      'hard_braking',
      'harsh_cornering',
      'idle_time',
      'engine_malfunction',
      'low_fuel',
      'high_temperature',
      'door_open',
      'offline',
      'motor_cut_activated',
      'accident_detection',
      'fatigue_detection',
      'panic',
      'security',
    ],
    required: true,
  },
  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
  },
  message: String,
  description: String,
  location: {
    latitude: Number,
    longitude: Number,
    address: String,
  },
  triggerValue: mongoose.Schema.Types.Mixed, // e.g., speed value
  threshold: mongoose.Schema.Types.Mixed, // e.g., speed limit
  geofence: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Geofence',
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  notificationChannels: [String], // email, sms, push, dashboard
  sent: {
    type: Boolean,
    default: false,
  },
  acknowledged: {
    type: Boolean,
    default: false,
  },
  acknowledgedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  acknowledgedAt: Date,
  acknowledgeNotes: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  expiresAt: {
    type: Date,
    default: () => new Date(+new Date() + 7 * 24 * 60 * 60 * 1000), // 7 days
    index: { expires: 0 }, // Auto-delete after expiration
  },
});

alertSchema.index({ vehicle: 1, createdAt: -1 });
alertSchema.index({ type: 1, severity: 1 });
alertSchema.index({ acknowledged: 1 });

export default mongoose.model('Alert', alertSchema);
