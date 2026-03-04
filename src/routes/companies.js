// Listar empresas (solo admin) con conteo de vehículos
router.get('/', authenticate, authorize('admin'), async (req, res) => {
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

