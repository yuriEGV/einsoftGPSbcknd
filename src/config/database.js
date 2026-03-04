import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

let cachedConnection = null;

const connectDB = async () => {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  // Promise for manual timeout
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('MongoDB Connection Timeout (8s)')), 8000)
  );

  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is not defined');
    }

    mongoose.set('bufferCommands', false);

    // Race connection vs timeout
    const connPromise = mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });

    const conn = await Promise.race([connPromise, timeout]);

    console.log(`📊 MongoDB Connected: ${conn.connection.host}`);
    cachedConnection = conn;

    createGeoIndexes().catch(err => console.error('Index creation failed:', err.message));

    return conn;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    cachedConnection = null;
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
