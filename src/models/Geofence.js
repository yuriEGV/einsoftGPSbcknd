import mongoose from 'mongoose';

const geofenceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: String,
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
  },
  geometry: {
    type: {
      type: String,
      enum: ['Polygon', 'Point'],
      required: true,
      default: 'Polygon',
    },
    coordinates: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  radius: Number, // For circle type (where geometry.type is 'Point'), in meters
  alerts: {
    onEntry: { type: Boolean, default: true },
    onExit: { type: Boolean, default: true },
    notificationChannels: [
      {
        type: String,
        enum: ['email', 'sms', 'push', 'dashboard'],
      },
    ],
  },
  assignedVehicles: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
    },
  ],
  allowedVehicles: [String], // License plates
  speed_limit: Number, // km/h
  enableSpeedAlert: Boolean,
  dwell_time: Number, // minutes before alert
  tags: [String],
  active: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

geofenceSchema.index({ geometry: '2dsphere' });
geofenceSchema.index({ company: 1 });
geofenceSchema.index({ center: '2dsphere' });

export default mongoose.model('Geofence', geofenceSchema);
