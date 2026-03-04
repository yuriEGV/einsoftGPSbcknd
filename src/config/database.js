import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('❌ MONGODB_URI is not defined in environment variables');
      return; // Don't try to connect if no URI
    }

    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log(`📊 MongoDB Connected: ${conn.connection.host}`);

    // Create indexes for geospatial queries
    // We can do this without awaiting to not block the request flow if it's already connected
    createGeoIndexes().catch(err => console.error('Index creation failed:', err.message));

    return conn;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    // Throw error instead of process.exit(1) so Vercel doesn't kill the instance immediately
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
