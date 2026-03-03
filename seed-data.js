import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Vehicle from './src/models/Vehicle.js';
import SensorData from './src/models/SensorData.js';
import Alert from './src/models/Alert.js';
import Geofence from './src/models/Geofence.js';
import User from './src/models/User.js';
import Company from './src/models/Company.js';
import bcrypt from 'bcryptjs';

dotenv.config();

// Main demo fleet: 10 vehicles
const TEST_VEHICLES = [
  {
    licensePlate: 'ANT001',
    vin: 'VIN001TEST',
    make: 'Tesla',
    model: 'Model S',
    year: 2023,
    color: 'White',
    assignedDriver: 'John Doe',
    location: {
      type: 'Point',
      coordinates: [-74.006, 40.7128],
      address: 'Times Square',
      city: 'New York',
      country: 'USA'
    },
    speed: 35,
    heading: 180,
    odometer: 5400,
    status: 'active',
  },
  {
    licensePlate: 'ANT002',
    vin: 'VIN002TEST',
    make: 'Ford',
    model: 'Transit',
    year: 2022,
    color: 'Gray',
    assignedDriver: 'Jane Smith',
    location: {
      type: 'Point',
      coordinates: [-74.012, 40.720],
      address: 'Madison Avenue',
      city: 'New York',
      country: 'USA'
    },
    speed: 28,
    heading: 90,
    odometer: 3200,
    status: 'active',
  },
  {
    licensePlate: 'ANT003',
    vin: 'VIN003TEST',
    make: 'Toyota',
    model: 'Hiace',
    year: 2021,
    color: 'Blue',
    assignedDriver: 'Mike Johnson',
    location: {
      type: 'Point',
      coordinates: [-74.018, 40.735],
      address: 'Central Park North',
      city: 'New York',
      country: 'USA'
    },
    speed: 42,
    heading: 270,
    odometer: 7800,
    status: 'active',
  },
  {
    licensePlate: 'ANT004',
    vin: 'VIN004TEST',
    make: 'Mercedes',
    model: 'Sprinter',
    year: 2023,
    color: 'Black',
    assignedDriver: 'Sarah Williams',
    location: {
      type: 'Point',
      coordinates: [-74.025, 40.712],
      address: 'Battery Park',
      city: 'New York',
      country: 'USA'
    },
    speed: 0,
    heading: 0,
    odometer: 9200,
    status: 'offline',
  },
  {
    licensePlate: 'ANT005',
    vin: 'VIN005TEST',
    make: 'Volkswagen',
    model: 'Caddy',
    year: 2022,
    color: 'White',
    assignedDriver: 'Robert Brown',
    location: {
      type: 'Point',
      coordinates: [-74.008, 40.745],
      address: 'Upper West Side',
      city: 'New York',
      country: 'USA'
    },
    speed: 18,
    heading: 45,
    odometer: 4500,
    status: 'active',
  },
  {
    licensePlate: 'ANT006',
    vin: 'VIN006TEST',
    make: 'Chevrolet',
    model: 'Express',
    year: 2020,
    color: 'Silver',
    assignedDriver: 'Emily Davis',
    location: {
      type: 'Point',
      coordinates: [-74.015, 40.709],
      address: 'Wall Street',
      city: 'New York',
      country: 'USA'
    },
    speed: 22,
    heading: 135,
    odometer: 6100,
    status: 'active',
  },
  {
    licensePlate: 'ANT007',
    vin: 'VIN007TEST',
    make: 'Nissan',
    model: 'NV200',
    year: 2021,
    color: 'Red',
    assignedDriver: 'Carlos Martinez',
    location: {
      type: 'Point',
      coordinates: [-74.001, 40.727],
      address: 'SoHo',
      city: 'New York',
      country: 'USA'
    },
    speed: 14,
    heading: 200,
    odometer: 3900,
    status: 'active',
  },
  {
    licensePlate: 'ANT008',
    vin: 'VIN008TEST',
    make: 'Renault',
    model: 'Kangoo',
    year: 2019,
    color: 'Yellow',
    assignedDriver: 'Laura Wilson',
    location: {
      type: 'Point',
      coordinates: [-73.99, 40.751],
      address: 'Midtown',
      city: 'New York',
      country: 'USA'
    },
    speed: 30,
    heading: 310,
    odometer: 10200,
    status: 'active',
  },
  {
    licensePlate: 'ANT009',
    vin: 'VIN009TEST',
    make: 'Peugeot',
    model: 'Partner',
    year: 2022,
    color: 'Blue',
    assignedDriver: 'Miguel Torres',
    location: {
      type: 'Point',
      coordinates: [-74.02, 40.735],
      address: 'Chelsea',
      city: 'New York',
      country: 'USA'
    },
    speed: 40,
    heading: 260,
    odometer: 2800,
    status: 'active',
  },
  {
    licensePlate: 'ANT010',
    vin: 'VIN010TEST',
    make: 'Fiat',
    model: 'Ducato',
    year: 2023,
    color: 'White',
    assignedDriver: 'Ana Gomez',
    location: {
      type: 'Point',
      coordinates: [-74.025, 40.745],
      address: 'Hudson Yards',
      city: 'New York',
      country: 'USA'
    },
    speed: 0,
    heading: 0,
    odometer: 1500,
    status: 'offline',
  },
];

// Smaller example fleet: 3 vehicles (different city)
const SMALL_FLEET_VEHICLES = [
  {
    licensePlate: 'SML001',
    vin: 'VIN011TEST',
    make: 'Toyota',
    model: 'Corolla',
    year: 2020,
    color: 'White',
    assignedDriver: 'Luis Hernandez',
    location: {
      type: 'Point',
      coordinates: [-99.1332, 19.4326],
      address: 'Centro Histórico',
      city: 'Ciudad de México',
      country: 'México'
    },
    speed: 25,
    heading: 90,
    odometer: 32000,
    status: 'active',
  },
  {
    licensePlate: 'SML002',
    vin: 'VIN012TEST',
    make: 'Volkswagen',
    model: 'Gol',
    year: 2019,
    color: 'Gray',
    assignedDriver: 'María López',
    location: {
      type: 'Point',
      coordinates: [-99.14, 19.44],
      address: 'Reforma',
      city: 'Ciudad de México',
      country: 'México'
    },
    speed: 18,
    heading: 45,
    odometer: 41000,
    status: 'active',
  },
  {
    licensePlate: 'SML003',
    vin: 'VIN013TEST',
    make: 'Nissan',
    model: 'Versa',
    year: 2021,
    color: 'Blue',
    assignedDriver: 'Pedro Castillo',
    location: {
      type: 'Point',
      coordinates: [-99.145, 19.43],
      address: 'Polanco',
      city: 'Ciudad de México',
      country: 'México'
    },
    speed: 0,
    heading: 0,
    odometer: 22000,
    status: 'offline',
  },
];

const TEST_SENSOR_DATA = [
  {
    values: {
      rpm: 2500,
      speed: 35,
      fuelLevel: 75,
      engineTemp: 92,
      dtcCodes: []
    },
    timestamp: new Date()
  },
  {
    values: {
      tankLevel: 75,
      consumption: 8.5,
      range: 450
    },
    timestamp: new Date()
  },
  {
    values: {
      ambient: 28,
      engine: 92,
      coolant: 88
    },
    timestamp: new Date()
  },
  {
    values: {
      xForce: 0.2,
      yForce: 0.1,
      zForce: 9.8
    },
    timestamp: new Date()
  },
];

const TEST_ALERTS = [
  {
    type: 'speeding',
    severity: 'medium',
    title: 'Speeding Detected',
    description: 'Vehicle exceeded speed limit by 15 km/h',
    status: 'acknowledged',
    createdAt: new Date(Date.now() - 3600000)
  },
  {
    type: 'hard_acceleration',
    severity: 'low',
    title: 'Hard Acceleration',
    description: 'Sudden acceleration detected',
    status: 'active',
    createdAt: new Date(Date.now() - 1800000)
  },
  {
    type: 'low_fuel',
    severity: 'medium',
    title: 'Low Fuel Level',
    description: 'Fuel level below 25%',
    status: 'active',
    createdAt: new Date(Date.now() - 900000)
  },
];

const TEST_GEOFENCES = [
  {
    name: 'New York City Zone',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-74.03, 40.71],
        [-74.01, 40.71],
        [-74.01, 40.72],
        [-74.03, 40.72],
        [-74.03, 40.71]
      ]]
    },
    center: {
      type: 'Point',
      coordinates: [-74.02, 40.715]
    },
    radius: 2000,
    alerts: {
      onEntry: true,
      onExit: true,
      notificationChannels: ['email', 'dashboard']
    }
  },
  {
    name: 'Central Park',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-73.98, 40.78],
        [-73.95, 40.78],
        [-73.95, 40.79],
        [-73.98, 40.79],
        [-73.98, 40.78]
      ]]
    },
    center: {
      type: 'Point',
      coordinates: [-73.965, 40.785]
    },
    radius: 2000,
    alerts: {
      onEntry: true,
      onExit: true,
      notificationChannels: ['dashboard']
    }
  },
  {
    name: 'Warehouse Zone',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-74.005, 40.750],
        [-73.995, 40.750],
        [-73.995, 40.760],
        [-74.005, 40.760],
        [-74.005, 40.750]
      ]]
    },
    center: {
      type: 'Point',
      coordinates: [-74.000, 40.755]
    },
    radius: 1000,
    alerts: {
      onEntry: true,
      onExit: true,
      notificationChannels: ['email', 'sms', 'dashboard']
    }
  },
];

async function seedData() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Clear existing test data
    console.log('🧹 Clearing existing test data...');
    await Vehicle.deleteMany({ licensePlate: { $regex: /^(ANT|SML)/ } });
    await SensorData.deleteMany({});
    await Alert.deleteMany({});
    await Geofence.deleteMany({ name: { $in: ['New York City Zone', 'Central Park', 'Warehouse Zone'] } });
    await Company.deleteMany({ name: { $in: ['Einsoft Test Company', 'Einsoft Small Fleet'] } });

    // Get admin user
    let adminUser = await User.findOne({ email: 'admin@einsoftgps.com' });
    if (!adminUser) {
      console.log('⚠️  Admin user not found, creating...');
      const hashedPassword = await bcrypt.hash('AdminPassword123!', 10);
      adminUser = await User.create({
        name: 'Admin User',
        email: 'admin@einsoftgps.com',
        password: hashedPassword,
        phone: '+1234567890',
        role: 'admin',
        isActive: true
      });
      console.log('✅ Admin user created');
    }

    // Create main test company (10-vehicle fleet)
    console.log('🏢 Creating main test company...');
    const mainCompany = await Company.create({
      name: 'Einsoft Test Company',
      email: 'test@einsoftgps.com',
      phone: '+1234567890',
      address: 'New York, NY',
      country: 'USA',
      admin: adminUser._id,
      subscriptionPlan: 'pro'
    });
    console.log('✅ Main company created');

    // Create smaller example company (3-vehicle fleet)
    console.log('🏢 Creating small demo company...');
    const smallCompany = await Company.create({
      name: 'Einsoft Small Fleet',
      email: 'smallfleet@einsoftgps.com',
      phone: '+5215555555555',
      address: 'Ciudad de México',
      country: 'México',
      admin: adminUser._id,
      subscriptionPlan: 'basic'
    });
    console.log('✅ Small company created');

    // Create vehicles for each company
    console.log('🚗 Creating test vehicles...');
    const mainFleetVehicles = TEST_VEHICLES.map(v => ({
      ...v,
      company: mainCompany._id
    }));
    const smallFleetVehicles = SMALL_FLEET_VEHICLES.map(v => ({
      ...v,
      company: smallCompany._id
    }));

    const createdVehicles = await Vehicle.insertMany([
      ...mainFleetVehicles,
      ...smallFleetVehicles,
    ]);
    console.log(`✅ Created ${createdVehicles.length} vehicles (main fleet: ${mainFleetVehicles.length}, small fleet: ${smallFleetVehicles.length})`);

    // Create sensor data for each vehicle
    console.log('📡 Creating sensor data...');
    const sensorDataToCreate = [];
    createdVehicles.forEach(vehicle => {
      TEST_SENSOR_DATA.forEach(sensorData => {
        sensorDataToCreate.push({
          ...sensorData,
          vehicle: vehicle._id
        });
      });
    });
    await SensorData.insertMany(sensorDataToCreate);
    console.log(`✅ Created ${sensorDataToCreate.length} sensor data entries`);

    // Create alerts for each vehicle
    console.log('🚨 Creating alerts...');
    const alertsToCreate = [];
    createdVehicles.forEach((vehicle, vehicleIndex) => {
      TEST_ALERTS.forEach((alert, alertIndex) => {
        alertsToCreate.push({
          ...alert,
          vehicle: vehicle._id,
          user: adminUser._id,
          createdAt: new Date(Date.now() - (vehicleIndex * 5 + alertIndex) * 3600000)
        });
      });
    });
    await Alert.insertMany(alertsToCreate);
    console.log(`✅ Created ${alertsToCreate.length} alerts`);

    // Asignar empresa principal al usuario admin si no la tiene
    if (!adminUser.company) {
      adminUser.company = mainCompany._id;
      await adminUser.save();
    }

    // Create geofences with company reference (main company)
    console.log('🗺️  Creating geofences...');
    const geofencesWithCompany = TEST_GEOFENCES.map(g => ({
      ...g,
      company: mainCompany._id
    }));
    const createdGeofences = await Geofence.insertMany(geofencesWithCompany);
    console.log(`✅ Created ${createdGeofences.length} geofences`);

    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║     ✅ TEST DATA SUCCESSFULLY POPULATED           ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    console.log('📊 Summary:');
    console.log(`   • Vehicles: ${createdVehicles.length}`);
    console.log(`   • Sensor Data: ${sensorDataToCreate.length}`);
    console.log(`   • Alerts: ${alertsToCreate.length}`);
    console.log(`   • Geofences: ${createdGeofences.length}`);
    console.log('\n🚀 Your dashboard is ready!');
    console.log('🔗 Access: http://localhost:3000');
    console.log('👤 Credentials: admin@einsoftgps.com / AdminPassword123!\n');

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Error seeding data:', error.message);
    process.exit(1);
  }
}

seedData();
