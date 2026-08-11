import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole, getUserScope } from '../middleware/scope.js';

const router = express.Router();

// ─── GET /users/drivers — Conductores de la empresa (admin y fleet_manager) ───
router.get('/drivers', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
  try {
    let filter = { role: 'driver' };
    if (req.user.role === 'fleet_manager') {
      if (!req.user.company) return res.json([]);
      filter.company = req.user.company;
    }
    const drivers = await User.find(filter).select('name email phone').sort({ name: 1 });
    res.json(drivers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /users — Listado de usuarios (admin ve todos, fleet_manager ve su empresa) ──
router.get('/', authenticate, async (req, res) => {
  try {
    const scope = getUserScope(req.user);
    if (scope === null) {
      // Independiente y conductor no pueden listar usuarios
      return res.status(403).json({ error: 'Sin permisos para listar usuarios' });
    }

    const users = await User.find(scope)
      .populate('company', 'name')
      .select('-password')
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /users/profile — Perfil propio (cualquier rol autenticado) ────────────
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password').populate('company', 'name');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /users/profile — Editar perfil propio ────────────────────────────────
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, phone, profileImage } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { name, phone, profileImage },
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

// ─── POST /users/:id/reset-password — Admin resetea contraseña de otro usuario ─
router.post('/:id/reset-password', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
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

// ─── PUT /users/:id — Editar usuario (admin y fleet_manager en su scope) ─────
router.put('/:id', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { name, email, role, status, companyId } = req.body;

    // fleet_manager solo puede modificar usuarios de su empresa
    const scope = getUserScope(req.user);
    const filter = { ...scope, _id: req.params.id };
    const targetUser = await User.findOne(filter);
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado o sin permiso' });

    const updateFields = { name, email, role, status };
    // Solo admin puede mover un usuario a otra empresa
    if (req.user.role === 'admin' && companyId !== undefined) {
      updateFields.company = companyId || undefined;
    }

    // fleet_manager no puede promover a admin ni cambiar empresa
    if (req.user.role === 'fleet_manager') {
      if (role === 'admin') return res.status(403).json({ error: 'No puedes asignar rol de administrador' });
      delete updateFields.company;
    }

    const updatedUser = await User.findByIdAndUpdate(req.params.id, updateFields, { new: true }).select('-password');
    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /users/:id — Eliminar usuario (admin y fleet_manager en su scope) ─
router.delete('/:id', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    }

    const scope = getUserScope(req.user);
    const filter = { ...scope, _id: req.params.id };
    const targetUser = await User.findOne(filter);
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado o sin permiso' });

    // fleet_manager no puede eliminar admins
    if (req.user.role === 'fleet_manager' && targetUser.role === 'admin') {
      return res.status(403).json({ error: 'No puedes eliminar un administrador' });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /users — Crear usuario (admin y fleet_manager) ─────────────────────
router.post('/', authenticate, requireRole('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { name, email, password, role, companyId } = req.body;

    // Validar roles permitidos (sin viewer)
    const allowedRoles = ['admin', 'fleet_manager', 'independent', 'driver'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: `Rol inválido: ${role}` });
    }

    // fleet_manager no puede crear admins
    if (req.user.role === 'fleet_manager' && role === 'admin') {
      return res.status(403).json({ error: 'No tienes permiso para crear administradores' });
    }

    // Determinar empresa del nuevo usuario
    let company;
    if (role === 'independent') {
      company = undefined; // Independiente no pertenece a ninguna empresa
    } else if (req.user.role === 'fleet_manager') {
      company = req.user.company; // fleet_manager solo puede crear en su empresa
    } else {
      company = companyId || undefined; // admin puede asignar cualquier empresa
    }

    const user = new User({
      name,
      email: email.toLowerCase().trim(),
      password: await bcrypt.hash(password, 10),
      role,
      company,
    });

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

export default router;
