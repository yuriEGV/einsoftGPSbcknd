import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { getEffectivePermissions, hasPermission } from '../config/permissions.js';

// ─── Migración automática de roles legacy ────────────────────────────────────
const LEGACY_ROLE_MAP = {
  fleet_manager: 'admin',
  independent:   'mobile_gps_user',
};

async function migrateLegacyRole(user) {
  const newRole = LEGACY_ROLE_MAP[user.role];
  if (newRole) {
    user.role = newRole;
    await user.save();
    console.log(`[auth] Migrated user ${user.email}: ${Object.keys(LEGACY_ROLE_MAP).find(k => LEGACY_ROLE_MAP[k] === newRole)} → ${newRole}`);
  }
}

// ─── authenticate ────────────────────────────────────────────────────────────
export const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User session invalid' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'User account is suspended' });
    }

    // Migrate legacy roles transparently on every request
    if (LEGACY_ROLE_MAP[user.role]) {
      await migrateLegacyRole(user);
    }

    req.userObj = user;

    // Attach verified company + role + effective permissions to req.user
    const effectivePerms = getEffectivePermissions(user.role, user.permissions || []);
    req.user = {
      ...decoded,
      id: user._id.toString(),
      role: user.role,
      company: (['mobile_gps_user', 'driver', 'client', 'auditor'].includes(user.role) && !user.company)
        ? null
        : user.company?.toString() ?? null,
      permissions: effectivePerms,
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ─── authorize (role-based, legacy) ──────────────────────────────────────────
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// ─── requirePermission ────────────────────────────────────────────────────────
/**
 * Middleware que verifica un permiso granular.
 * Uso: requirePermission('alerts.acknowledge')
 */
export const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const perms = req.user.permissions || getEffectivePermissions(req.user.role, []);
    if (!hasPermission(perms, permission)) {
      return res.status(403).json({
        error: `Acceso denegado. Se requiere permiso: ${permission}`,
        role: req.user.role,
      });
    }
    next();
  };
};

// ─── requireAnyPermission ────────────────────────────────────────────────────
/**
 * Middleware que verifica que el usuario tenga AL MENOS UNO de los permisos.
 * Uso: requireAnyPermission('alerts.acknowledge', 'alerts.resolve')
 */
export const requireAnyPermission = (...permissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const perms = req.user.permissions || getEffectivePermissions(req.user.role, []);
    const granted = permissions.some(p => hasPermission(perms, p));
    if (!granted) {
      return res.status(403).json({
        error: `Acceso denegado. Se requiere uno de: ${permissions.join(', ')}`,
        role: req.user.role,
      });
    }
    next();
  };
};

// ─── requireRole ─────────────────────────────────────────────────────────────
/**
 * Middleware que verifica que el usuario tenga uno de los roles listados.
 * Alias de authorize() para mayor claridad en las rutas.
 */
export const requireRole = (...roles) => authorize(...roles);

// ─── rateLimitByUser ─────────────────────────────────────────────────────────
export const rateLimitByUser = (req, res, next) => {
  // Implementar rate limiting por usuario (mejorable con Redis)
  next();
};

