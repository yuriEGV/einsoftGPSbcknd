import mongoose from 'mongoose';

const personTrackerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    default: '',
  },
  roleDescription: {
    type: String,
    default: 'Familiar / Personal',
  },
  trackerCode: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    default: null,
  },
  assignedVehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    default: null,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['normal', 'panic', 'offline'],
    default: 'normal',
  },
  panicAlert: {
    active: {
      type: Boolean,
      default: false,
    },
    triggeredAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    message: {
      type: String,
      default: '',
    },
  },
  batteryLevel: {
    type: Number,
    default: 100,
    min: 0,
    max: 100,
  },
  gpsAccuracy: {
    type: Number,
    default: 0,
  },
  hasReportedLocation: {
    type: Boolean,
    default: false,
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0],
    },
    address: {
      type: String,
      default: 'Sin señal GPS inicial (Esperando conexión del teléfono)',
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  speed: {
    type: Number,
    default: 0,
  },
  deviceId: {
    type: String,
    default: '',
    index: true,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

personTrackerSchema.index({ 'location.coordinates': '2dsphere' });

export default mongoose.models.PersonTracker || mongoose.model('PersonTracker', personTrackerSchema);
