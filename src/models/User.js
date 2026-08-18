import mongoose from 'mongoose';

/**
 * User — Usuario del sistema EINSoft GPS.
 *
 * Roles:
 *   superadmin      — Control total de la plataforma
 *   admin           — Administra una organización/flota
 *   operator        — Operador del centro de monitoreo GPS
 *   supervisor      — Supervisión y análisis
 *   driver          — Conductor de un vehículo asignado
 *   mobile_gps_user — Usuario celular GPS (persona en terreno, botón de pánico)
 *   client          — Cliente de consulta (solo lectura autorizada)
 *   auditor         — Auditor de solo lectura total
 */
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    match: /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
  },
  password: {
    type: String,
    required: true,
    minlength: 8,
  },
  phone: String,
  role: {
    type: String,
    enum: [
      'superadmin',
      'admin',
      'operator',
      'supervisor',
      'driver',
      'mobile_gps_user',
      'client',
      'auditor',
      // Legacy roles (migrated on first login)
      'fleet_manager',
      'independent',
    ],
    default: 'client',
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
  },

  // ── Campos para Usuario Celular GPS ────────────────────────────────────────
  // Identificación del dispositivo móvil
  imei: {
    type: String,
    sparse: true,
    index: true,
  },
  deviceId: {
    type: String,
    sparse: true,
  },
  osType: {
    type: String,
    enum: ['android', 'ios', 'other'],
  },
  // Estado GPS del dispositivo (actualizado por la app)
  lastBatteryLevel: Number,
  lastGpsAccuracy: Number,
  // Token de dispositivo revocable (para activación OTP)
  deviceToken: {
    type: String,
    sparse: true,
  },
  deviceTokenExpires: Date,
  deviceActivated: {
    type: Boolean,
    default: false,
  },

  // ── Seguridad ───────────────────────────────────────────────────────────────
  twoFactorEnabled: {
    type: Boolean,
    default: false,
  },
  twoFactorSecret: String,
  lastLogin: Date,
  loginAttempts: {
    type: Number,
    default: 0,
  },
  lockUntil: Date,
  profileImage: String,

  // Permisos adicionales asignados manualmente (complementan los del rol)
  permissions: [String],

  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended', 'pending_activation'],
    default: 'active',
  },

  // Vehículo asignado (para conductores)
  assignedVehicle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
  },

  // Rastreador de persona vinculado (para mobile_gps_user)
  personTracker: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PersonTracker',
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.index({ email: 1 });
userSchema.index({ company: 1 });
userSchema.index({ role: 1 });

export default mongoose.models.User || mongoose.model('User', userSchema);

