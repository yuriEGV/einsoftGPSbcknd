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
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [-70.64827, -33.45694],
    },
    address: {
      type: String,
      default: 'Ubicación no reportada',
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
}, {
  timestamps: true,
});

personTrackerSchema.index({ 'location.coordinates': '2dsphere' });

export default mongoose.models.PersonTracker || mongoose.model('PersonTracker', personTrackerSchema);
