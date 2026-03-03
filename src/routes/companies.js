import express from 'express';
import Company from '../models/Company.js';
import User from '../models/User.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// Listar empresas (solo admin)
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 });
    res.json(companies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener empresa por id
router.get('/:id', authenticate, authorize('admin'), async (req, res) => {
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

// Crear empresa y, opcionalmente, usuario admin asociado
router.post('/', authenticate, authorize('admin'), async (req, res) => {
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

// Actualizar empresa
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
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

// Desactivar / eliminar empresa (soft delete)
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
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

