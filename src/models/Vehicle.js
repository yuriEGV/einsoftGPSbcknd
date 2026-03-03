import mongoose from 'mongoose';

const vehicleSchema = new mongoose.Schema({
  licensePlate: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
  },
  vin: {
    type: String,
    unique: true,
    sparse: true,
  },
  make: String,
  model: String,
  year: Number,
  color: String,
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  assignedDriver: String,
  deviceIMEI: {
    type: String,
    unique: true,
    sparse: true,
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
    address: String,
    city: String,
    country: String,
    timestamp: Date,
  },
  speed: {
    type: Number,
    default: 0,
    min: 0,
  },
  heading: Number, // Direction in degrees
  odometer: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'offline', 'alert'],
    default: 'offline',
  },
  engineStatus: {
    type: Boolean,
    default: false,
  },
  ignitionStatus: {
    type: Boolean,
    default: false,
  },
  lastUpdate: {
    type: Date,
    default: Date.now,
  },
  sensors: {
    fuel: Number, // 0-100 %
    temperature: Number, // Celsius
    engineRPM: Number,
    odometerKm: Number,
    batteryVoltage: Number,
    gServiceLight: Boolean,
    checkEngineLight: Boolean,
  },
  geofences: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Geofence',
    },
  ],
  maintenanceSchedule: {
    nextService: Date,
    lastService: Date,
    notes: String,
  },
  alerts: {
    speeding: { type: Boolean, default: false },
    hardBraking: { type: Boolean, default: false },
    doorOpen: { type: Boolean, default: false },
    lowFuel: { type: Boolean, default: false },
    highTemperature: { type: Boolean, default: false },
    engineMalfunction: { type: Boolean, default: false },
  },
  motorCutStatus: {
    type: Boolean,
    default: false,
  },
  motorCutRules: [
    {
      name: String,
      active: Boolean,
      conditions: {
        timeFrom: String,
        timeTo: String,
        geofenceId: mongoose.Schema.Types.ObjectId,
        dayOfWeek: [Number],
      },
    },
  ],
  ecoScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  drivingBehavior: {
    hardAccelerations: Number,
    hardBrakings: Number,
    speedings: Number,
    idleTime: Number,
  },
  routes: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Route',
    },
  ],
  photos: [String],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

vehicleSchema.index({ location: '2dsphere' });
vehicleSchema.index({ company: 1 });
vehicleSchema.index({ licensePlate: 1 });
vehicleSchema.index({ deviceIMEI: 1 });
vehicleSchema.index({ lastUpdate: -1 });

export default mongoose.model('Vehicle', vehicleSchema);
