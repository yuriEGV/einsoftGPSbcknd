import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/einsoft-gps';
    
    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log(`📊 MongoDB Connected: ${conn.connection.host}`);

    // Create indexes for geospatial queries
    await createGeoIndexes();

    return conn;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

const createGeoIndexes = async () => {
  try {
    const db = mongoose.connection.db;
    
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
