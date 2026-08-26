import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ DB Connected');

const PersonTracker = mongoose.models.PersonTracker || mongoose.model('PersonTracker', new mongoose.Schema({
  name: String,
  phone: String,
  deviceId: String,
  trackerCode: String,
  aliases: [String],
  roleDescription: String,
  assignedVehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  hasReportedLocation: Boolean,
  status: String,
}));

const people = await PersonTracker.find();
console.log(`Encontradas ${people.length} personas. Actualizando alias y configuración multi-dispositivo...`);

for (const p of people) {
  const cleanPhoneDigits = p.phone ? p.phone.replace(/\D/g, '') : '';
  const aliasesList = Array.from(new Set([
    p.trackerCode,
    p.deviceId || null,
    p.phone || null,
    cleanPhoneDigits.length >= 7 ? cleanPhoneDigits : null,
    cleanPhoneDigits.length >= 8 ? cleanPhoneDigits.slice(-8) : null,
    p.name ? p.name.trim() : null,
    p.name ? p.name.trim().toLowerCase() : null,
    ...(p.aliases || [])
  ].filter(Boolean)));

  p.aliases = aliasesList;
  if (!p.deviceId) p.deviceId = p.trackerCode;
  await p.save();

  console.log(`✅ ${p.name.padEnd(12)} | Code: ${p.trackerCode.padEnd(12)} | DeviceId: ${p.deviceId.padEnd(18)} | Aliases: ${aliasesList.join(', ')}`);
}

await mongoose.disconnect();
console.log('🎉 Todas las personas existentes han sido actualizadas con soporte completo de despertar y multi-alias!');
