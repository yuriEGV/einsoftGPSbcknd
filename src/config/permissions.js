/**
 * permissions.js — Mapa centralizado de permisos por rol.
 *
 * Cada rol tiene un arreglo de permisos. El permiso '*' significa acceso total.
 * Los permisos con sufijo '.own' significan "solo los propios recursos".
 *
 * Roles del sistema:
 *   superadmin      — Control total de la plataforma
 *   admin           — Administra una organización/flota completa
 *   operator        — Operador del centro de monitoreo GPS
 *   supervisor      — Supervisión y análisis de flota
 *   driver          — Conductor de vehículo asignado
 *   mobile_gps_user — Usuario celular GPS (persona en terreno)
 *   client          — Cliente de consulta (solo lectura autorizada)
 *   auditor         — Auditor de solo lectura total
 */

// ─── Permisos disponibles ─────────────────────────────────────────────────────
export const PERMISSIONS = {
  // Usuarios
  USERS_VIEW:           'users.view',
  USERS_CREATE:         'users.create',
  USERS_UPDATE:         'users.update',
  USERS_DELETE:         'users.delete',

  // Vehículos
  VEHICLES_VIEW:        'vehicles.view',
  VEHICLES_CREATE:      'vehicles.create',
  VEHICLES_UPDATE:      'vehicles.update',
  VEHICLES_DELETE:      'vehicles.delete',

  // Dispositivos GPS
  DEVICES_VIEW:         'devices.view',
  DEVICES_CREATE:       'devices.create',
  DEVICES_UPDATE:       'devices.update',
  DEVICES_DELETE:       'devices.delete',

  // Ubicaciones
  LOCATIONS_VIEW:       'locations.view',
  LOCATIONS_HISTORY:    'locations.history',
  LOCATIONS_OWN:        'locations.own',       // Solo ver la propia

  // Alertas
  ALERTS_VIEW:          'alerts.view',
  ALERTS_ACKNOWLEDGE:   'alerts.acknowledge',
  ALERTS_RESOLVE:       'alerts.resolve',

  // Pánico SOS
  PANIC_CREATE:         'panic.create',
  PANIC_VIEW:           'panic.view',
  PANIC_ACKNOWLEDGE:    'panic.acknowledge',
  PANIC_RESOLVE:        'panic.resolve',

  // Geocercas
  GEOFENCES_VIEW:       'geofences.view',
  GEOFENCES_CREATE:     'geofences.create',
  GEOFENCES_UPDATE:     'geofences.update',
  GEOFENCES_DELETE:     'geofences.delete',

  // Reportes
  REPORTS_VIEW:         'reports.view',
  REPORTS_EXPORT:       'reports.export',

  // Auditoría
  AUDIT_VIEW:           'audit.view',

  // Propios (para driver y mobile_gps_user)
  DEVICE_OWN_VIEW:      'device.own.view',
  NOTIFICATIONS_OWN:    'notifications.own',
  PROFILE_OWN_UPDATE:   'profile.own.update',

  // Acceso total
  ALL:                  '*',
};

// ─── Permisos por Rol ─────────────────────────────────────────────────────────
export const ROLE_PERMISSIONS = {
  superadmin: [PERMISSIONS.ALL],

  admin: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.USERS_DELETE,
    PERMISSIONS.VEHICLES_VIEW,
    PERMISSIONS.VEHICLES_CREATE,
    PERMISSIONS.VEHICLES_UPDATE,
    PERMISSIONS.VEHICLES_DELETE,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.DEVICES_CREATE,
    PERMISSIONS.DEVICES_UPDATE,
    PERMISSIONS.DEVICES_DELETE,
    PERMISSIONS.LOCATIONS_VIEW,
    PERMISSIONS.LOCATIONS_HISTORY,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.ALERTS_ACKNOWLEDGE,
    PERMISSIONS.ALERTS_RESOLVE,
    PERMISSIONS.PANIC_VIEW,
    PERMISSIONS.PANIC_ACKNOWLEDGE,
    PERMISSIONS.PANIC_RESOLVE,
    PERMISSIONS.GEOFENCES_VIEW,
    PERMISSIONS.GEOFENCES_CREATE,
    PERMISSIONS.GEOFENCES_UPDATE,
    PERMISSIONS.GEOFENCES_DELETE,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
    PERMISSIONS.AUDIT_VIEW,
  ],

  operator: [
    PERMISSIONS.VEHICLES_VIEW,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.LOCATIONS_VIEW,
    PERMISSIONS.LOCATIONS_HISTORY,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.ALERTS_ACKNOWLEDGE,
    PERMISSIONS.ALERTS_RESOLVE,
    PERMISSIONS.PANIC_VIEW,
    PERMISSIONS.PANIC_ACKNOWLEDGE,
    PERMISSIONS.PANIC_RESOLVE,
    PERMISSIONS.GEOFENCES_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],

  supervisor: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.VEHICLES_VIEW,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.LOCATIONS_VIEW,
    PERMISSIONS.LOCATIONS_HISTORY,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.PANIC_VIEW,
    PERMISSIONS.PANIC_ACKNOWLEDGE,
    PERMISSIONS.PANIC_RESOLVE,
    PERMISSIONS.GEOFENCES_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.REPORTS_EXPORT,
  ],

  driver: [
    PERMISSIONS.LOCATIONS_OWN,
    PERMISSIONS.PANIC_CREATE,
    PERMISSIONS.PANIC_VIEW,
    PERMISSIONS.DEVICE_OWN_VIEW,
    PERMISSIONS.NOTIFICATIONS_OWN,
    PERMISSIONS.PROFILE_OWN_UPDATE,
  ],

  mobile_gps_user: [
    PERMISSIONS.LOCATIONS_OWN,
    PERMISSIONS.PANIC_CREATE,
    PERMISSIONS.PANIC_VIEW,
    PERMISSIONS.DEVICE_OWN_VIEW,
    PERMISSIONS.NOTIFICATIONS_OWN,
    PERMISSIONS.PROFILE_OWN_UPDATE,
  ],

  client: [
    PERMISSIONS.VEHICLES_VIEW,
    PERMISSIONS.LOCATIONS_VIEW,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],

  auditor: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.VEHICLES_VIEW,
    PERMISSIONS.DEVICES_VIEW,
    PERMISSIONS.LOCATIONS_VIEW,
    PERMISSIONS.LOCATIONS_HISTORY,
    PERMISSIONS.ALERTS_VIEW,
    PERMISSIONS.PANIC_VIEW,
    PERMISSIONS.GEOFENCES_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.AUDIT_VIEW,
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Retorna la lista efectiva de permisos para un rol,
 * incluyendo permisos extra asignados manualmente al usuario.
 */
export function getEffectivePermissions(role, extraPermissions = []) {
  const base = ROLE_PERMISSIONS[role] || [];
  return [...new Set([...base, ...extraPermissions])];
}

/**
 * Comprueba si una lista de permisos incluye el permiso requerido.
 * Soporta wildcard '*' (acceso total) y prefijos como 'vehicles.*'.
 */
export function hasPermission(effectivePermissions, required) {
  if (!required) return true;
  if (effectivePermissions.includes(PERMISSIONS.ALL)) return true;

  // Comprobar permiso exacto
  if (effectivePermissions.includes(required)) return true;

  // Comprobar wildcard de categoría (ej: 'vehicles.*' cubre 'vehicles.view')
  const [category] = required.split('.');
  if (effectivePermissions.includes(`${category}.*`)) return true;

  return false;
}

/**
 * Roles con acceso de escritura general (para validaciones rápidas)
 */
export const WRITE_ROLES = ['superadmin', 'admin'];

/**
 * Roles con acceso de solo lectura total (para validaciones rápidas)
 */
export const READ_ONLY_ROLES = ['auditor', 'client'];
