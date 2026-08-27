import express from 'express';
import mongoose from 'mongoose';
import Company from '../models/Company.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Helper middleware: permite a superadmin y administradores gestionar empresas
const adminOrSuperadmin = (req, res, next) => {
  if (req.user?.role === 'superadmin' || req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({
    error: 'Acceso denegado. Se requieren permisos de administrador para gestionar el catálogo de clientes.'
  });
};

// ─── GET / — Listar empresas con conteo de vehículos ───────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    let filter = {};
    const role = req.user?.role;
    const userCompany = req.user?.company;

    // Superadmin o Admin global ve todas las empresas
    if (role === 'superadmin' || (role === 'admin' && !userCompany)) {
      filter = {};
    } else if (userCompany) {
      // Gestor asignado a una empresa ve su propia empresa
      filter = { _id: userCompany };
    } else {
      return res.json([]);
    }

    const companies = await Company.find(filter).sort({ createdAt: -1 });
    const Vehicle = mongoose.model('Vehicle');

    // Enriquecer con conteo de vehículos
    const companiesWithStats = await Promise.all(companies.map(async (c) => {
      const vehicleCount = await Vehicle.countDocuments({ company: c._id }).catch(() => 0);
      return { ...c.toObject(), vehicleCount };
    }));

    res.json(companiesWithStats);
  } catch (error) {
    console.error('Error GET /api/companies:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /:id — Obtener empresa por ID ─────────────────────────────────────────
router.get('/:id', authenticate, adminOrSuperadmin, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin' && req.user.company && req.user.company.toString() !== req.params.id) {
      return res.status(403).json({ error: 'No tienes permiso para consultar esta empresa' });
    }

    const company = await Company.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST / — Crear cliente o empresa ─────────────────────────────────────────
router.post('/', authenticate, adminOrSuperadmin, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      address,
      city,
      country,
      subscriptionPlan,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'El nombre del cliente o empresa es obligatorio' });
    }

    // Verificar si ya existe una empresa con ese nombre
    const existing = await Company.findOne({ name: new RegExp('^' + name.trim() + '$', 'i') });
    if (existing) {
      return res.status(400).json({ error: 'Ya existe una empresa o cliente con este nombre' });
    }

    const company = await Company.create({
      name: name.trim(),
      email: email ? email.trim() : undefined,
      phone: phone ? phone.trim() : undefined,
      address: address ? address.trim() : undefined,
      city: city ? city.trim() : undefined,
      country: country ? country.trim() : undefined,
      subscriptionPlan: subscriptionPlan || 'basic',
      admin: req.user.id,
      isActive: true,
    });

    res.status(201).json(company);
  } catch (error) {
    console.error('Error POST /api/companies:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Ya existe una empresa o cliente con este nombre' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /:id — Actualizar empresa ────────────────────────────────────────────
router.put('/:id', authenticate, adminOrSuperadmin, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin' && req.user.company && req.user.company.toString() !== req.params.id) {
      return res.status(403).json({ error: 'No tienes permiso para modificar esta empresa' });
    }

    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true },
    );
    if (!company) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /:id — Desactivar / eliminar empresa (soft delete) ────────────────
router.delete('/:id', authenticate, adminOrSuperadmin, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin' && req.user.company && req.user.company.toString() !== req.params.id) {
      return res.status(403).json({ error: 'No tienes permiso para desactivar esta empresa' });
    }

    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { isActive: false, updatedAt: new Date() },
      { new: true },
    );
    if (!company) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res.json({ message: 'Empresa desactivada correctamente', company });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
