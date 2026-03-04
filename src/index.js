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
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/logger.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.SOCKET_IO_CORS_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: ['https://einsoft-gp-sfrntnd.vercel.app', 'http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(requestLogger);

// Database Connection
connectDB();

// Socket.io Setup — only works in persistent server mode (not Vercel serverless)
if (process.env.VERCEL !== '1') {
  setupSocket(io);
}

// Basic Root Route
app.get('/', (req, res) => {
  res.json({
    message: 'Einsoft GPS API Backend is running',
    healthCheck: '/api/health',
    status: 'Operational'
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/sensors', sensorRoutes);
app.use('/api/geofences', geofenceRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/companies', companyRoutes);

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error Handler
app.use(errorHandler);

// In Vercel serverless, Vercel handles the HTTP listener itself.
// server.listen() must NOT be called; just export the app handler.
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`✅ Einsoft GPS Backend running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready for real-time updates`);
  });
}

export { app, server, io };
export default app;
