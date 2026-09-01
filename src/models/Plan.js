import mongoose from 'mongoose';

/**
 * Plan — Catalogo de planes GPS de EINSoft.
 * Cargados como seeds; no se crean desde el cliente.
 */
const planSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'CLP', uppercase: true },
  maxDevices: { type: Number, default: 1, min: 1 },
  durationDays: { type: Number, default: 30, min: 1 },
  features: [String],
  isActive: { type: Boolean, default: true },
  targetType: {
    type: String,
    enum: ['company', 'user', 'both'],
    default: 'both',
  },
  sortOrder: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

planSchema.index({ code: 1, isActive: 1 });

export default mongoose.models.Plan || mongoose.model('Plan', planSchema);
