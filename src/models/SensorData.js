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
  },
  obd2: {
    engineRPM: Number,
    speed: Number,
    throttlePosition: Number,
    engineLoad: Number,
    engineCoolantTemp: Number,
    intakeManioldPressure: Number,
    fuelPressure: Number,
    odometer: Number,
    dtcs: [String], // Diagnostic Trouble Codes
  },
  fuel: {
    level: Number, // 0-100%
    consumption: Number, // liters/100km
    estimatedRange: Number, // km remaining
  },
  temperature: {
    ambient: Number,
    internal: Number,
    cargo: Number, // For temperature-sensitive cargo
  },
  accelerometer: {
    x: Number, // Forward/backward acceleration (G)
    y: Number, // Left/right acceleration (G)
    z: Number, // Vertical acceleration (G)
    totalForce: Number, // Total G-force
  },
  imu: {
    ax: Number,
    ay: Number,
    az: Number,
    gx: Number,
    gy: Number,
    gz: Number,
    gForce: Number,
    peakGForce: Number,
    roll: Number,
    pitch: Number,
    eventType: String,
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
  battery: {
    voltage: Number,
    charging: Boolean,
    percentage: Number,
  },
  alarmSensor: {
    triggered: Boolean,
    type: String, // motion, door, vibration
  },
  customData: mongoose.Schema.Types.Mixed, // For extensibility

  // Computed/processed fields
  rawSignal: String, // Store raw GPS trace if needed
});

sensorDataSchema.index({ vehicle: 1, timestamp: -1 });
sensorDataSchema.index({ deviceIMEI: 1, timestamp: -1 });
sensorDataSchema.index({ timestamp: -1 });

export default mongoose.models.SensorData || mongoose.model('SensorData', sensorDataSchema);
