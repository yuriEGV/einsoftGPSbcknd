/**
 * scope.js — Middleware centralizado de aislamiento de datos por rol
 *
 * Roles del sistema:
 *   superadmin      → Acceso global total. Ve y gestiona todo.
 *   admin           → Solo vehículos/conductores/alertas de su empresa.
 *   operator        → Ve toda la empresa. No puede eliminar.
 *   supervisor      → Ve toda la empresa. Solo lectura extendida.
 *   driver          → Solo su vehículo asignado. Botón de pánico.
 *   mobile_gps_user → Solo su posición propia. Botón de pánico.
 *   client          → Solo vehículos/dispositivos autorizados explícitamente.
 *   auditor         → Solo lectura de todo. Sin escritura.
 */

import mongoose from 'mongoose';

// ─── requireRole ──────────────────────────────────────────────────────────────
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      error: `Acceso denegado. Se requiere uno de los siguientes roles: ${roles.join(', ')}`,
    });
  }
  next();
};

// ─── requireReadWrite ─────────────────────────────────────────────────────────
// Bloquea métodos de escritura para roles de solo lectura
export const requireReadWrite = (req, res, next) => {
  const READ_ONLY_ROLES = ['auditor', 'client'];
  const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (READ_ONLY_ROLES.includes(req.user?.role) && writeMethods.includes(req.method)) {
    return res.status(403).json({ error: 'Este perfil no tiene permisos de escritura' });
  }
  next();
};

// ─── Company scope helper ─────────────────────────────────────────────────────
function companyFilter(user, extra = {}) {
  if (!user.company) return { ...extra, _id: new mongoose.Types.ObjectId() };
  return { ...extra, company: user.company };
}

// ─── getVehicleScope ──────────────────────────────────────────────────────────
export function getVehicleScope(user, vehicleId = null) {
  const base = vehicleId ? { _id: vehicleId } : {};

  switch (user.role) {
    case 'superadmin':
      return base;

    case 'admin':
    case 'operator':
    case 'supervisor':
      return companyFilter(user, base);

    case 'driver':
      // Solo el vehículo asignado
      return { ...base, driver: user.id };

    case 'mobile_gps_user':
      // No conduce vehículos — sin acceso
      return { ...base, _id: new mongoose.Types.ObjectId() };

    case 'client':
      // Solo vehículos a los que el cliente tiene acceso explícito
      // (manejado en la capa de negocio con allowedVehicles)
      return companyFilter(user, base);

    case 'auditor':
      // Auditor ve todo su company
      return user.company ? companyFilter(user, base) : base;

    default:
      return { ...base, _id: new mongoose.Types.ObjectId() };
  }
}

// ─── getAlertScope ────────────────────────────────────────────────────────────
export async function getAlertScope(user) {
  switch (user.role) {
    case 'superadmin':
      return {};

    case 'admin':
    case 'operator':
    case 'supervisor':
    case 'auditor':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'driver': {
      const Vehicle = mongoose.model('Vehicle');
      const vehicles = await Vehicle.find({ driver: user.id }).select('_id');
      return { vehicle: { $in: vehicles.map(v => v._id) } };
    }

    case 'mobile_gps_user':
      // Solo alertas propias (person tracker)
      return { personTracker: user.personTracker ?? new mongoose.Types.ObjectId() };

    case 'client':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    default:
      return { _id: new mongoose.Types.ObjectId() };
  }
}

// ─── getGeofenceScope ─────────────────────────────────────────────────────────
export function getGeofenceScope(user) {
  switch (user.role) {
    case 'superadmin':
      return {};

    case 'admin':
    case 'operator':
    case 'supervisor':
    case 'auditor':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'driver':
    case 'mobile_gps_user':
    case 'client':
      // Sin acceso a geocercas
      return null;

    default:
      return { _id: new mongoose.Types.ObjectId() };
  }
}

// ─── getUserScope ─────────────────────────────────────────────────────────────
export function getUserScope(user) {
  switch (user.role) {
    case 'superadmin':
      return {};

    case 'admin':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'operator':
    case 'supervisor':
      // Puede ver usuarios de la empresa (solo lectura de la lista)
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'auditor':
      return user.company ? { company: user.company } : {};

    case 'driver':
    case 'mobile_gps_user':
    case 'client':
      // Solo pueden ver su propio perfil (manejado en /profile)
      return null;

    default:
      return null;
  }
}

// ─── getPeopleTrackerScope ────────────────────────────────────────────────────
export function getPeopleTrackerScope(user) {
  switch (user.role) {
    case 'superadmin':
      return {};

    case 'admin':
    case 'operator':
    case 'supervisor':
    case 'auditor':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'mobile_gps_user':
      // Solo su propio tracker
      return user.personTracker
        ? { _id: user.personTracker }
        : { user: user.id };

    case 'driver':
    case 'client':
      return { _id: new mongoose.Types.ObjectId() };

    default:
      return { _id: new mongoose.Types.ObjectId() };
  }
}

