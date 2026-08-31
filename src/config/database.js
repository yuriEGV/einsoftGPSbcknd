import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Global cache para Serverless (Vercel / AWS Lambda)
 * Evita que cada invocación de función Lambda cree una nueva conexión a MongoDB.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
  // 1. Si ya está conectado y listo, reutilizar conexión existente
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  // 2. Si ya hay una promesa de conexión en progreso, esperarla
  if (cached.promise) {
    cached.conn = await cached.promise;
    return cached.conn;
  }

  const uri = process.env.MONGODB_URI?.trim();

  if (!uri) {
    console.error('❌ MONGODB_URI no está definida en las variables de entorno');
    throw new Error('MONGODB_URI no está definida');
  }

  console.log('🔄 Conectando a MongoDB (Pool optimizado para Serverless)...');

  /**
   * Configuración de Pool Estricta para no saturar el límite de 500 conexiones de Atlas M0:
   * - maxPoolSize: 4 conexiones máx por función Lambda (antes eran 100 por defecto)
   * - minPoolSize: 0 (permite cerrar todas las conexiones si la función está inactiva)
   * - maxIdleTimeMS: 20000 (cierra conexiones inactivas tras 20 segundos)
   * - maxConnecting: 2
   */
  const opts = {
    maxPoolSize: 4,
    minPoolSize: 0,
    maxIdleTimeMS: 20000,
    maxConnecting: 2,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 7000,
    socketTimeoutMS: 25000,
    waitQueueTimeoutMS: 8000,
    bufferCommands: false, // Falla rápido en lugar de colgarse si no hay conexión
  };

  cached.promise = mongoose.connect(uri, opts).then((m) => {
    console.log('📊 MongoDB conectado exitosamente (Einsoft GPS Prioridad)');
    return m;
  }).catch((error) => {
    console.error(`❌ Error de conexión MongoDB: ${error.message}`);
    cached.promise = null;
    cached.conn = null;
    throw error;
  });

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (err) {
    cached.promise = null;
    cached.conn = null;
    throw err;
  }
};

// Eventos de monitoreo de conexión
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB desconectado (liberando recursos del pool)');
  if (cached) {
    cached.conn = null;
    cached.promise = null;
  }
});

mongoose.connection.on('error', (error) => {
  console.error('❌ MongoDB error:', error.message);
});

export default connectDB;
