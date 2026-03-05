import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// Get all drivers in company
router.get('/drivers', authenticate, async (req, res) => {
  try {
    let filter = { role: 'driver' };
    if (req.user.company) {
      filter.company = req.user.company;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized: No company context' });
    }

    const drivers = await User.find(filter)
      .select('name email phone')
      .sort({ name: 1 });

    res.json(drivers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users in company
router.get('/', authenticate, async (req, res) => {
  try {
    let filter = {};
    if (req.user.company) {
      filter.company = req.user.company;
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized: No company context' });
    }

    const users = await User.find(filter)
      .populate('company', 'name')
      .select('-password')
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user profile
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

// Change password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update user
router.put('/:id', authenticate, authorize('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { name, email, role, status, companyId } = req.body;

    // Check ownership/permissions
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }

    const targetUser = await User.findOne(filter);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found or unauthorized' });
    }

    const updateFields = { name, email, role, status };
    if (req.user.role === 'admin' && companyId) {
      updateFields.company = companyId;
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true }
    ).select('-password');

    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete user
router.delete('/:id', authenticate, authorize('admin', 'fleet_manager'), async (req, res) => {
  try {
    let filter = { _id: req.params.id };
    if (req.user.role !== 'admin') {
      filter.company = req.user.company;
    }

    const targetUser = await User.findOne(filter);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found or unauthorized' });
    }

    // Prevent self-deletion
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Create user
router.post('/', authenticate, authorize('admin', 'fleet_manager'), async (req, res) => {
  try {
    const { name, email, password, role, companyId } = req.body;

    const user = new User({
      name,
      email: email.toLowerCase(),
      password: await bcrypt.hash(password, 10),
      role,
      company: req.user.company || companyId,
    });

    await user.save();
    res.status(201).json({ message: 'User created', userId: user._id });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ error: messages.join('. ') });
    }
    if (error.code === 11000) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
