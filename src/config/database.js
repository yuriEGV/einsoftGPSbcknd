import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

let isConnecting = false;

const connectDB = async () => {
  // If already connected, return the connection
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  // If currently connecting, wait for it to finish
  if (isConnecting) {
    while (mongoose.connection.readyState === 2) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return mongoose.connection;
  }

  try {
    isConnecting = true;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not defined');

    // Disable buffering because in serverless we want immediate failure over hanging
    mongoose.set('bufferCommands', false);

    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });

    console.log('📊 MongoDB Connected');

    // Non-blocking index creation
    createGeoIndexes().catch(err => console.error('Index creation failed:', err.message));

    return mongoose.connection;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    throw error;
  } finally {
    isConnecting = false;
  }
};

const createGeoIndexes = async () => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      console.warn('⚠️ Database object not available for index creation');
      return;
    }

    // Geofence 2dsphere index
    await db.collection('geofences').createIndex({ 'geometry': '2dsphere' });

    // Vehicle location 2dsphere index
    await db.collection('vehicles').createIndex({ 'location': '2dsphere' });

    console.log('✅ Geospatial indexes created');
  } catch (error) {
    console.warn('⚠️  Geospatial index creation warning:', error.message);
  }
};

export default connectDB;
