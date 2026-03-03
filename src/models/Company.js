import mongoose from 'mongoose';

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  email: String,
  phone: String,
  address: String,
  city: String,
  country: String,
  website: String,
  logo: String,
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  subscriptionPlan: {
    type: String,
    enum: ['free', 'basic', 'pro', 'enterprise'],
    default: 'basic',
  },
  isActive: {
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

export default mongoose.model('Company', companySchema);
