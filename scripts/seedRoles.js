import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const MONGO_URI = 'mongodb+srv://yguajardov:maquina123@comercioelectronico.c6vj7t7.mongodb.net/EinsoftGPS?appName=EinstoreGPS';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const User = mongoose.connection.db.collection('users');
  const Vehicle = mongoose.connection.db.collection('vehicles');
  const Company = mongoose.connection.db.collection('companies');

  const company = await Company.findOne({});
  const companyId = company ? company._id : null;

  // 1. Upgrade primary admins to superadmin
  await User.updateOne({ email: 'admin@einsoftgps.com' }, { $set: { role: 'superadmin' } });
  await User.updateOne({ email: 'sarem.vargas@gmail.com' }, { $set: { role: 'superadmin' } });
  await User.updateOne({ email: 'sarem@einsoftgps.com' }, { $set: { role: 'superadmin' } });

  // 2. Demo accounts for all 8 roles (Password: password123)
  const demoUsers = [
    { name: 'Super Admin', email: 'superadmin@einsoftgps.com', password: 'password123', role: 'superadmin' },
    { name: 'Admin Flota', email: 'admin.flota@einsoftgps.com', password: 'password123', role: 'admin', company: companyId },
    { name: 'Operador Monitoreo', email: 'operador@einsoftgps.com', password: 'password123', role: 'operator', company: companyId },
    { name: 'Supervisor Flota', email: 'supervisor@einsoftgps.com', password: 'password123', role: 'supervisor', company: companyId },
    { name: 'Conductor Asignado', email: 'conductor@einsoftgps.com', password: 'password123', role: 'driver', company: companyId },
    { name: 'Usuario Celular GPS', email: 'celular@einsoftgps.com', password: 'password123', role: 'mobile_gps_user' },
    { name: 'Cliente Consulta', email: 'cliente@einsoftgps.com', password: 'password123', role: 'client', company: companyId },
    { name: 'Auditor Externo', email: 'auditor@einsoftgps.com', password: 'password123', role: 'auditor' },
  ];

  for (const u of demoUsers) {
    const hash = await bcrypt.hash(u.password, 10);
    await User.updateOne(
      { email: u.email },
      { $set: { name: u.name, password: hash, role: u.role, company: u.company || null, status: 'active', updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // 3. Link driver to vehicle CBDX81
  const driverUser = await User.findOne({ email: 'conductor@einsoftgps.com' });
  if (driverUser) {
    await Vehicle.updateOne({ licensePlate: 'CBDX81' }, { $set: { driver: driverUser._id } });
  }

  console.log('✅ Demo accounts and vehicles successfully seeded and linked!');
  await mongoose.disconnect();
}

run().catch(console.error);
