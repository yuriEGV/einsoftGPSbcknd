import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getUserScope } from '../middleware/scope.js';

const router = express.Router();

// ─── GET /users/drivers — Conductores de la empresa ──────────────────────────
router.get('/drivers', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    const scope = getUserScope(req.user) || {};
    const drivers = await User.find({ ...scope, role: 'driver' })
      .select('name email phone assignedVehicle').sort({ name: 1 });
    res.json(drivers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /users — Listado de usuarios ────────────────────────────────────────
router.get('/', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    const scope = getUserScope(req.user);
    if (scope === null) {
      return res.status(403).json({ error: 'Sin permisos para listar usuarios' });
    }

    const users = await User.find(scope)
      .populate('company', 'name')
      .select('-password -twoFactorSecret -deviceToken')
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /users/profile — Perfil propio (cualquier rol autenticado) ──────────
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password -twoFactorSecret -deviceToken')
      .populate('company', 'name');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /users/profile — Editar perfil propio ───────────────────────────────
router.put('/profile', authenticate, requirePermission('profile.own.update'), async (req, res) => {
  try {
    const { name, phone, profileImage } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { name, phone, profileImage, updatedAt: new Date() },
      { new: true }
    ).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /users/change-password — Cambiar contraseña propia ─────────────────
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /users/:id/reset-password — Admin resetea contraseña de otro usuario
router.post('/:id/reset-password', authenticate, requirePermission('users.update'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const scope = getUserScope(req.user);
    const filter = { ...scope, _id: req.params.id };
    const targetUser = await User.findOne(filter);
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado o sin permiso' });

    targetUser.password = await bcrypt.hash(newPassword, 10);
    await targetUser.save();
    res.json({ message: 'Contraseña restablecida correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /users/:id — Editar usuario ─────────────────────────────────────────
router.put('/:id', authenticate, requirePermission('users.update'), async (req, res) => {
  try {
    const { name, email, role, status, companyId, phone, imei } = req.body;

    const scope = getUserScope(req.user);
    const filter = { ...scope, _id: req.params.id };
    const targetUser = await User.findOne(filter);
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado o sin permiso' });

    const updateFields = { name, email, role, status, phone, imei, updatedAt: new Date() };

    // Solo superadmin puede mover un usuario a otra empresa
    if (req.user.role === 'superadmin' && companyId !== undefined) {
      updateFields.company = companyId || undefined;
    }

    // admin no puede promover a superadmin
    if (req.user.role === 'admin') {
      if (role === 'superadmin') return res.status(403).json({ error: 'No puedes asignar rol de superadministrador' });
      delete updateFields.company;
    }

    const updatedUser = await User.findByIdAndUpdate(req.params.id, updateFields, { new: true }).select('-password');

    // Sincronizar IMEI con PersonTracker si existe
    if (imei) {
      const PersonTracker = mongoose.model('PersonTracker');
      if (PersonTracker) {
        await PersonTracker.updateMany(
          { $or: [{ user: updatedUser._id }, { name: updatedUser.name }, { phone: updatedUser.phone }] },
          { $set: { deviceId: imei, lastSeen: new Date() } }
        ).catch(() => {});
      }
    }

    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /users/:id — Eliminar usuario ────────────────────────────────────
router.delete('/:id', authenticate, requirePermission('users.delete'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    }

    const scope = getUserScope(req.user);
    const filter = { ...scope, _id: req.params.id };
    const targetUser = await User.findOne(filter);
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado o sin permiso' });

    // admin no puede eliminar superadmins
    if (req.user.role === 'admin' && targetUser.role === 'superadmin') {
      return res.status(403).json({ error: 'No puedes eliminar un superadministrador' });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /users — Crear usuario ─────────────────────────────────────────────
router.post('/', authenticate, requirePermission('users.create'), async (req, res) => {
  try {
    const { name, email, password, role, companyId, phone, imei, deviceId } = req.body;

    // Roles válidos para creación
    const allowedRoles = [
      'admin', 'operator', 'supervisor', 'driver',
      'mobile_gps_user', 'client', 'auditor',
    ];
    // Solo superadmin puede crear otros superadmins
    if (role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Solo el superadministrador puede crear otros superadministradores' });
    }
    if (!allowedRoles.includes(role) && role !== 'superadmin') {
      return res.status(400).json({ error: `Rol inválido: ${role}` });
    }

    // admin solo puede crear en su empresa
    let company;
    if (req.user.role === 'admin') {
      company = req.user.company;
    } else {
      company = companyId || undefined;
    }

    const userData = {
      name,
      email: email.toLowerCase().trim(),
      password: await bcrypt.hash(password || Math.random().toString(36).slice(-10), 10),
      role,
      company,
      phone,
      imei: imei || deviceId || undefined,
    };

    const user = new User(userData);
    await user.save();
    res.status(201).json({ message: 'Usuario creado correctamente', userId: user._id });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors).map(e => e.message).join('. ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /users/roles — Retorna los roles disponibles ─────────────────────────
router.get('/roles', authenticate, requirePermission('users.view'), async (req, res) => {
  const roleLabels = {
    superadmin:      'Superadministrador',
    admin:           'Administrador',
    operator:        'Operador GPS',
    supervisor:      'Supervisor',
    driver:          'Conductor',
    mobile_gps_user: 'Usuario Celular GPS',
    client:          'Cliente / Consulta',
    auditor:         'Auditor',
  };

  // Roles que puede crear el usuario actual
  const creatableRoles = {
    superadmin: Object.keys(roleLabels),
    admin:      ['operator', 'supervisor', 'driver', 'mobile_gps_user', 'client', 'auditor'],
    operator:   [],
    supervisor: [],
  };

  const available = creatableRoles[req.user.role] || [];
  res.json(available.map(r => ({ value: r, label: roleLabels[r] })));
});

export default router;
