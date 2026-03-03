import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import User from './src/models/User.js';

dotenv.config();

async function createAdmin() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const email = 'admin@einsoftgps.com';
    const password = 'AdminPassword123!';

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email });
    if (existingAdmin) {
      console.log('✅ Admin user already exists');
      await mongoose.disconnect();
      return;
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = new User({
      name: 'Admin User',
      email: email,
      password: hashedPassword,
      phone: '+56912345678',
      role: 'admin',
      twoFactorEnabled: false,
      isActive: true,
    });

    await admin.save();
    console.log('✅ Admin user created successfully!');
    console.log('Email:', email);
    console.log('Password:', password);
    console.log('Role: admin');

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    process.exit(1);
  }
}

createAdmin();
