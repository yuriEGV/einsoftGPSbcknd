import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import connectDB from './config/database.js';
import { setupSocket } from './socket/index.js';
import authRoutes from './routes/auth.js';
import vehicleRoutes from './routes/vehicles.js';
import sensorRoutes from './routes/sensors.js';
import geofenceRoutes from './routes/geofences.js';
import alertRoutes from './routes/alerts.js';
import reportRoutes from './routes/reports.js';
import userRoutes from './routes/users.js';
import companyRoutes from './routes/companies.js';
import peopleTrackerRoutes from './routes/peopleTrackers.js';
import botRoutes from './routes/bot.js';
import telemetryRoutes from './routes/telemetry.js';
import mongoose from 'mongoose';
import './models/Alert.js'; // Ensure Alert model is registered early
import './models/PersonTracker.js';
import './models/PanicAlert.js';
import './models/BotUser.js';
import './models/DeviceCommand.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/logger.js';

dotenv.config();

const app = express();
const server = http.createServer(app);

let io = null;
if (process.env.VERCEL !== '1') {
  try {
    io = new Server(server, {
      cors: {
        origin: process.env.SOCKET_IO_CORS_ORIGIN || 'http://localhost:3000',
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });
    setupSocket(io);
  } catch (e) {
    console.warn('Socket.IO init warning:', e.message);
  }
}
app.set('io', io);

// Universal CORS Header Middleware for Vercel
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-CSRF-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Attach Socket.io to Request object
app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(requestLogger);

// Health Check (always responds 200 OK, even if DB is connecting)
app.get('/api/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'CONNECTED' : 'CONNECTING_OR_DISCONNECTED';
  res.json({
    status: 'UP',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    vercel: process.env.VERCEL === '1'
  });
});

// Middleware for DB connection - Ensures DB is ready for all API routes
const dbMiddleware = async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('❌ DB Middleware Error:', error.message);
    res.status(500).json({ error: 'Error de conexión con la base de datos', details: error.message });
  }
};

// Apply DB Middleware to all /api routes except health check
app.use('/api', dbMiddleware);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/sensors', sensorRoutes);
app.use('/api/geofences', geofenceRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/people-trackers', peopleTrackerRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/telemetry', telemetryRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error Handler
app.use(errorHandler);

// Safely handle Socket.io requests in serverless mode
app.all('/socket.io/*', (req, res) => {
  if (io && io.engine) {
    io.engine.handleRequest(req, res);
  } else {
    res.status(200).json({ status: 'Socket.io disabled in Vercel serverless — HTTP polling active' });
  }
});

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`✅ Einsoft GPS Backend running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready for real-time updates`);
  });
}

export { app, server, io };
export default app;
