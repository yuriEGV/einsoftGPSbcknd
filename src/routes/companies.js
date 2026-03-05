import express from 'express';
import mongoose from 'mongoose';
import Company from '../models/Company.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// Helper middleware to ensure user is NOT assigned to a company (Super Admin check)
const superAdminOnly = (req, res, next) => {
  if (req.user.company) {
    return res.status(403).json({
      error: 'Acceso denegado. Los gestores de empresa no pueden administrar el catálogo global de clientes.'
    });
  }
  next();
};

// Listar empresas (solo super-admin) con conteo de vehículos
router.get('/', authenticate, authorize('admin'), superAdminOnly, async (req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 });
    const Vehicle = mongoose.model('Vehicle');

    // Enriquecer con conteo de vehículos
    const companiesWithStats = await Promise.all(companies.map(async (c) => {
      const vehicleCount = await Vehicle.countDocuments({ company: c._id });
      return { ...c.toObject(), vehicleCount };
    }));

    res.json(companiesWithStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener empresa por id (solo super-admin)
router.get('/:id', authenticate, authorize('admin'), superAdminOnly, async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res.json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear empresa (solo super-admin)
router.post('/', authenticate, authorize('admin'), superAdminOnly, async (req, res) => {
  // ... rest of the code stays same but with superAdminOnly protection
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

    const company = await Company.create({
      name,
      email,
      phone,
      address,
      city,
      country,
      subscriptionPlan,
    });

    res.status(201).json(company);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Actualizar empresa (solo super-admin)
router.put('/:id', authenticate, authorize('admin'), superAdminOnly, async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      req.body,
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

// Desactivar / eliminar empresa (soft delete) (solo super-admin)
router.delete('/:id', authenticate, authorize('admin'), superAdminOnly, async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true },
    );
    if (!company) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }
    res.json({ message: 'Empresa desactivada', company });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

