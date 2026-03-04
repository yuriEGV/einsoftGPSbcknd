import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import Company from '../src/models/Company.js';
import User from '../src/models/User.js';
import Vehicle from '../src/models/Vehicle.js';
import Geofence from '../src/models/Geofence.js';

dotenv.config();

const seed = async () => {
    try {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGODB_URI is not defined');

        await mongoose.connect(uri.trim());
        console.log('Connected to MongoDB for seeding...');

        // Clear existing data (optional, but good for clean seeds)
        await Company.deleteMany({});
        await User.deleteMany({});
        await Vehicle.deleteMany({});
        await Geofence.deleteMany({});

        // 1. Create Company
        const company = await Company.create({
            name: 'Einsoft Logistics Demo',
            address: 'Avenida Providencia 123, Santiago, Chile',
            timezone: 'America/Santiago',
            plan: 'pro'
        });

        // 2. Create Admin User
        const hashedPassword = await bcrypt.hash('admin123', 10);
        const admin = await User.create({
            name: 'Yuri Admin',
            email: 'admin@einsoftgps.com',
            password: hashedPassword,
            role: 'admin',
            company: company._id,
            status: 'active'
        });

        // 3. Create Geofence (Circle around a central point in Santiago)
        const geofence = await Geofence.create({
            name: 'Zona Centro Santiago',
            description: 'Área operativa principal',
            company: company._id,
            geometry: {
                type: 'Point',
                coordinates: [-70.6506, -33.4372]
            },
            radius: 2000, // 2km
            alerts: {
                onEntry: true,
                onExit: true,
                notificationChannels: ['dashboard']
            }
        });

        // 4. Create Vehicles
        const vehiclesData = [
            {
                licensePlate: 'ABCD-12',
                make: 'Toyota',
                model: 'Hilux',
                year: 2023,
                deviceIMEI: 'SIMULATOR_001',
                simCardNumber: '56912345678',
                deviceModel: 'GT06',
                company: company._id,
                status: 'active',
                speed: 45,
                location: {
                    type: 'Point',
                    coordinates: [-70.6506, -33.4372],
                    address: 'Santiago Centro',
                    timestamp: new Date()
                }
            },
            {
                licensePlate: 'EFGH-34',
                make: 'Mercedes-Benz',
                model: 'Sprinter',
                year: 2022,
                deviceIMEI: 'SIMULATOR_002',
                simCardNumber: '56987654321',
                deviceModel: 'Coban 303',
                company: company._id,
                status: 'active',
                speed: 0,
                location: {
                    type: 'Point',
                    coordinates: [-70.6000, -33.4000],
                    address: 'Las Condes',
                    timestamp: new Date()
                }
            }
        ];

        const vehicles = await Vehicle.create(vehiclesData);

        // Link vehicles to geofence
        geofence.assignedVehicles = vehicles.map(v => v._id);
        await geofence.save();

        console.log(`
    ✅ SEED COMPLETED SUCCESSFULLY
    ------------------------------
    Company: ${company.name}
    Admin: ${admin.email} (pass: admin123)
    Vehicles: ${vehicles.length}
    Geofences: ${geofence.name}
    ------------------------------
    `);

        process.exit(0);
    } catch (error) {
        console.error('❌ SEED FAILED:', error);
        process.exit(1);
    }
};

seed();
