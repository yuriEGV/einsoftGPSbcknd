import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createRequire } from 'module';

dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ DB connected');

// Define minimal schemas inline to avoid import path issues on Windows
const pointSchema = new mongoose.Schema({
  type: { type: String, default: 'Point' },
  coordinates: [Number],
  address: String,
  timestamp: Date,
});

const PersonTracker = mongoose.models.PersonTracker || mongoose.model('PersonTracker', new mongoose.Schema({
  name: String,
  location: pointSchema,
  hasReportedLocation: Boolean,
  status: String,
  speed: Number,
}));

const Vehicle = mongoose.models.Vehicle || mongoose.model('Vehicle', new mongoose.Schema({
  licensePlate: String,
  location: pointSchema,
  status: String,
  speed: Number,
}));

// Clear Manuel's ocean coordinates
const manuel = await PersonTracker.findOneAndUpdate(
  { name: /manuel/i },
  { $unset: { location: 1 }, $set: { hasReportedLocation: false, status: 'offline', speed: 0 } },
  { new: true }
);
console.log('Manuel location after clear:', manuel?.location ?? 'NULL ✅ (no longer in ocean!)');
console.log('Manuel status:', manuel?.status);

// Clear TRGC11 ocean coordinates
const trgc11 = await Vehicle.findOneAndUpdate(
  { licensePlate: 'TRGC11' },
  { $unset: { location: 1 }, $set: { status: 'offline', speed: 0 } },
  { new: true }
);
console.log('TRGC11 location after clear:', trgc11?.location ?? 'NULL ✅');

await mongoose.disconnect();
console.log('\n🎉 DONE — Manuel ya no está en el mar!');
