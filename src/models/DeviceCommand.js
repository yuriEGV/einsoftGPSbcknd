import mongoose from 'mongoose';

const deviceCommandSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    index: true,
  },
  targetType: {
    type: String,
    enum: ['vehicle', 'person', 'user', 'mobile'],
    default: 'mobile',
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true,
  },
  command: {
    type: String,
    enum: ['LOCATE_NOW', 'SET_INTERVAL', 'EMERGENCY_MODE_ON', 'EMERGENCY_MODE_OFF', 'REBOOT'],
    required: true,
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  status: {
    type: String,
    enum: ['PENDING', 'SENT', 'EXECUTED', 'EXPIRED'],
    default: 'PENDING',
    index: true,
  },
  issuedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  issuedByName: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  executedAt: Date,
  response: mongoose.Schema.Types.Mixed,
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
    index: { expires: 0 },
  },
});

export default mongoose.models.DeviceCommand || mongoose.model('DeviceCommand', deviceCommandSchema);
