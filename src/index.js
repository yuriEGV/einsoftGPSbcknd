import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
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
import './models/Company.js';
import './models/User.js';
import './models/Vehicle.js';
import './models/PersonTracker.js';
import './models/Alert.js';
import './models/PanicAlert.js';
import './models/BotUser.js';
import './models/DeviceCommand.js';
import './models/Geofence.js';
import './models/SensorData.js';
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
const allowedOrigins = [
  'https://einsoft-gp-sfrntnd.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow all requests with matching origin or without origin (mobile apps / curl)
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-CSRF-Token'],
}));

app.options('*', (req, res) => {
  const origin = req.headers.origin || 'https://einsoft-gp-sfrntnd.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-CSRF-Token');
  return res.status(200).end();
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

// Root redirect → Frontend app (avoids "Route not found" when browsing the backend URL directly)
app.get('/', (req, res) => {
  res.redirect(302, 'https://einsoft-gp-sfrntnd.vercel.app');
});

// Health Check (always responds 200 OK, even if DB is connecting)
app.get('/api/health', async (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'CONNECTED' : 'CONNECTING_OR_DISCONNECTED';
  res.json({
    status: 'UP',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    version: '2.0.0-eyenode360',
    vercel: process.env.VERCEL === '1'
  });
});

// App Version & In-App OTA Update Check
app.get('/api/app-version', (req, res) => {
  res.json({
    latestVersion: '2.0.0',
    versionCode: 200,
    releaseName: 'EYE-NODE // TRACKER 360',
    releaseDate: '2026-08-24',
    apkUrl: 'https://einsoft-gp-sbcknd.vercel.app/eyenode.apk',
    webUrl: 'https://einsoft-gp-sbcknd.vercel.app/eyenode',
    forceUpdate: false,
    minSupportedVersion: '1.0.0',
    features: [
      '🚀 Nuevo motor táctico EYE-NODE 360 con IMU 6-Ejes',
      '💥 Detección instantánea de choques e impactos de Fuerza G',
      '🛡️ Modo Centinela anti-manipulación y anti-robo en reposo',
      '🧠 Puntuación y comportamiento del conductor con IA en tiempo real',
      '📦 Caja Negra industrial offline con sincronización automática'
    ],
    instructions: 'Descarga el nuevo archivo APK o presiona actualizar para activar la telemetría 360.'
  });
});

// ─── EYE-NODE Mobile PWA Direct Backend Hosting ──────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const eyenodePath = path.join(__dirname, '../public/eyenode');

// Service worker special header for scoping
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(eyenodePath, 'sw.js'));
});

// Serve assets (js, css, icons)
app.use('/assets', express.static(path.join(eyenodePath, 'assets')));
app.use('/eyenode', express.static(eyenodePath));

// Route /eyenode or /tracker to EYE-NODE app index.html
app.get(['/eyenode', '/eyenode/*', '/tracker', '/tracker/*'], (req, res) => {
  res.sendFile(path.join(eyenodePath, 'index.html'));
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
