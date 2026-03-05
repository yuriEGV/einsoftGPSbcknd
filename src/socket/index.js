import Vehicle from '../models/Vehicle.js';
import Alert from '../models/Alert.js';
import SensorData from '../models/SensorData.js';
import Geofence from '../models/Geofence.js';

export const setupSocket = (io) => {
  const vehicleNamespace = io.of('/vehicles');

  vehicleNamespace.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    // User joins a specific vehicle room for real-time updates
    socket.on('subscribe_vehicle', (vehicleId) => {
      socket.join(`vehicle:${vehicleId}`);
      console.log(`📍 User subscribed to vehicle ${vehicleId}`);
    });

    socket.on('unsubscribe_vehicle', (vehicleId) => {
      socket.leave(`vehicle:${vehicleId}`);
      console.log(`📍 User unsubscribed from vehicle ${vehicleId}`);
    });

    // Subscribe to company fleet updates
    socket.on('subscribe_company', (companyId) => {
      socket.join(`company:${companyId}`);
      console.log(`🏢 User subscribed to company ${companyId}`);
    });

    // Join a global room for admins to receive critical alerts from ANY vehicle
    socket.on('subscribe_global_alerts', () => {
      // In a real app, verify role here via JWT
      socket.join('global:admins');
      console.log('🛡️ Admin subscribed to global alerts');
    });

    socket.on('disconnect', () => {
      console.log('🔌 Client disconnected:', socket.id);
    });
  });

  return vehicleNamespace;
};

// Broadcast vehicle location update
export const broadcastVehicleUpdate = (io, vehicleId, data) => {
  io.of('/vehicles').to(`vehicle:${vehicleId}`).emit('location_update', {
    vehicleId,
    ...data,
    timestamp: new Date(),
  });
};

// Broadcast to entire company
export const broadcastCompanyUpdate = (io, companyId, data) => {
  if (!companyId) return;
  io.of('/vehicles').to(`company:${companyId}`).emit('fleet_update', {
    companyId,
    ...data,
  });
};

// Broadcast alert to users watching vehicle, company, and global admins
export const broadcastAlert = (io, vehicleId, companyId, alert) => {
  const alertData = {
    vehicleId,
    companyId,
    type: alert.type,
    severity: alert.severity,
    message: alert.message,
    location: alert.location,
    timestamp: new Date(),
  };

  // 1. To users specifically watching this vehicle
  io.of('/vehicles').to(`vehicle:${vehicleId}`).emit('alert', alertData);

  // 2. To the entire company fleet dashboard
  if (companyId) {
    io.of('/vehicles').to(`company:${companyId}`).emit('fleet_alert', alertData);
  }

  // 3. To global admins (Critical/Panic)
  if (alert.severity === 'critical' || alert.type === 'panic') {
    io.of('/vehicles').to('global:admins').emit('admin_alert', alertData);
  }
};
