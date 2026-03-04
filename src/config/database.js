import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

let cachedConnection = null;

const connectDB = async () => {
  if (cachedConnection) {
    return cachedConnection;
  }

  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is not defined');
    }

    // Disable buffering so errors are thrown immediately if not connected
    mongoose.set('bufferCommands', false);

    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });

    console.log(`📊 MongoDB Connected: ${conn.connection.host}`);
    cachedConnection = conn;

    createGeoIndexes().catch(err => console.error('Index creation failed:', err.message));

    return conn;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    throw error;
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
