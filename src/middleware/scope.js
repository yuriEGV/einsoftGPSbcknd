/**
 * scope.js — Middleware centralizado de aislamiento de datos por rol
 *
 * Roles del sistema:
 *   admin        → Acceso global total. Ve y gestiona todo.
 *   fleet_manager → Solo vehículos/conductores/alertas de su empresa.
 *   independent  → Solo sus propios vehículos (owner/driver). Plan familiar.
 *   driver       → Solo el vehículo asignado. Botón de pánico únicamente.
 */

import mongoose from 'mongoose';

// ─── requireRole ──────────────────────────────────────────────────────────────
// Middleware guard: rechaza con 403 si el usuario no tiene uno de los roles permitidos.
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
// Bloquea métodos de escritura (POST, PUT, PATCH, DELETE) para drivers
export const requireReadWrite = (req, res, next) => {
  const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (req.user?.role === 'driver' && writeMethods.includes(req.method)) {
    return res.status(403).json({ error: 'Conductores no tienen permisos de escritura' });
  }
  next();
};

// ─── getVehicleScope ──────────────────────────────────────────────────────────
// Retorna el filtro MongoDB apropiado para consultas de vehículos según el rol.
// vehicleId es opcional — si se pasa, lo añade al filtro.
export function getVehicleScope(user, vehicleId = null) {
  const base = vehicleId ? { _id: vehicleId } : {};

  switch (user.role) {
    case 'admin':
      // Ve absolutamente todo
      return base;

    case 'fleet_manager':
      // Solo vehículos de su empresa
      if (!user.company) return { ...base, _id: new mongoose.Types.ObjectId() }; // empresa requerida
      return { ...base, company: user.company };

    case 'independent':
      // Solo vehículos propios (dueño o conductor asignado)
      return {
        ...base,
        $or: [
          { owner: user.id },
          { driver: user.id },
        ],
      };

    case 'driver':
      // Solo el/los vehículos asignados a este conductor
      return { ...base, driver: user.id };

    default:
      // Rol desconocido: sin acceso
      return { ...base, _id: new mongoose.Types.ObjectId() };
  }
}

// ─── getAlertScope ────────────────────────────────────────────────────────────
// Retorna el filtro MongoDB apropiado para consultas de alertas según el rol.
// Requiere 'Vehicle' model para independientes.
export async function getAlertScope(user) {
  switch (user.role) {
    case 'admin':
      return {};

    case 'fleet_manager':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'independent': {
      const Vehicle = mongoose.model('Vehicle');
      const vehicles = await Vehicle.find({
        $or: [{ owner: user.id }, { driver: user.id }],
      }).select('_id');
      return { vehicle: { $in: vehicles.map(v => v._id) } };
    }

    case 'driver': {
      const Vehicle = mongoose.model('Vehicle');
      const vehicles = await Vehicle.find({ driver: user.id }).select('_id');
      return { vehicle: { $in: vehicles.map(v => v._id) } };
    }

    default:
      return { _id: new mongoose.Types.ObjectId() };
  }
}

// ─── getGeofenceScope ─────────────────────────────────────────────────────────
// Retorna el filtro MongoDB para geocercas según el rol.
export function getGeofenceScope(user) {
  switch (user.role) {
    case 'admin':
      return {};

    case 'fleet_manager':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company };

    case 'independent':
      // Solo geocercas creadas por este usuario
      return { creator: user.id };

    case 'driver':
      // Sin acceso a geocercas
      return null; // Caller debe retornar 403

    default:
      return { _id: new mongoose.Types.ObjectId() };
  }
}

// ─── getUserScope ─────────────────────────────────────────────────────────────
// Retorna el filtro MongoDB para consultas de usuarios según el rol.
export function getUserScope(user) {
  switch (user.role) {
    case 'admin':
      return {}; // Ve todos los usuarios del sistema

    case 'fleet_manager':
      if (!user.company) return { _id: new mongoose.Types.ObjectId() };
      return { company: user.company }; // Solo usuarios de su empresa

    case 'independent':
    case 'driver':
      // Solo pueden ver su propio perfil (manejado en /profile)
      return null; // Caller debe retornar 403 para listados

    default:
      return null;
  }
}
