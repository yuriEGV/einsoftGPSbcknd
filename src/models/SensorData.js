import mongoose from 'mongoose';

const sensorDataSchema = new mongoose.Schema({
  vehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: false,
    index: true,
  },
  personTracker: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PersonTracker',
    required: false,
    index: true,
  },
  deviceIMEI: {
    type: String,
    index: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
  gps: {
    latitude: Number,
    longitude: Number,
    accuracy: Number,
    altitude: Number,
    speed: Number,
    heading: Number,
    address: String,
  },
  location: {
    type: { type: String, default: 'Point' },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  obd2: {
    engineRPM: Number,
    speed: Number,
    throttlePosition: Number,
    engineLoad: Number,
    engineCoolantTemp: Number,
    intakeManifoldPressure: Number,
    fuelPressure: Number,
    odometer: Number,
    dtcs: [String],
  },
  fuel: {
    level: Number,
    consumption: Number,
    estimatedRange: Number,
  },
  temperature: {
    ambient: Number,
    internal: Number,
    cargo: Number,
  },
  accelerometer: {
    x: Number,
    y: Number,
    z: Number,
    totalForce: Number,
  },
  imu: {
    ax: Number, ay: Number, az: Number,
    gx: Number, gy: Number, gz: Number,
    gForce: Number,
    peakGForce: Number,
    roll: Number,
    pitch: Number,
    eventType: String,
  },
  // ── Campos unificados para persona y vehículo ─────────────────────────────
  speed: Number,
  heading: Number,
  altitude: Number,
  accuracy: Number,
  battery: {
    level: Number,
    isCharging: Boolean,
    voltage: Number,
  },
  driverScore: Number,
  transmissionMode: String,
  sentinelActive: Boolean,
  doorSensor: {
    frontLeftOpen: Boolean,
    frontRightOpen: Boolean,
    rearLeftOpen: Boolean,
    rearRightOpen: Boolean,
    trunkOpen: Boolean,
    hoodOpen: Boolean,
  },
  alarmSensor: {
    triggered: Boolean,
    type: String,
  },
  customData: mongoose.Schema.Types.Mixed,
  rawSignal: String,
}, {
  // No usar strict mode para compatibilidad con payloads mixtos
  strict: false,
});

// ── Índices compuestos de alto rendimiento ───────────────────────────────────
sensorDataSchema.index({ vehicle: 1, timestamp: -1 });
sensorDataSchema.index({ personTracker: 1, timestamp: -1 });
sensorDataSchema.index({ deviceIMEI: 1, timestamp: -1 });
sensorDataSchema.index({ timestamp: -1 });

// ── Índice geoespacial 2dsphere ───────────────────────────────────────────────
sensorDataSchema.index({ location: '2dsphere' }, { sparse: true });

// ── TTL: Auto-eliminar puntos de historial después de 90 días ────────────────
// Esto evita que la DB crezca indefinidamente.
// Los datos importantes se exportan antes de este límite.
sensorDataSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.models.SensorData || mongoose.model('SensorData', sensorDataSchema);
