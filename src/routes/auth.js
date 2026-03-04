import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';
import connectDB from '../config/database.js';

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    await connectDB();
    const { name, email, password, phone, role = 'driver' } = req.body;

    if (await User.findOne({ email })) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email,
      password: hashedPassword,
      phone,
      role,
    });

    await user.save();

    res.status(201).json({
      message: 'User registered successfully',
      userId: user._id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;

    const user = await User.findOne({ email }).populate('company');
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    user.loginAttempts = 0;
    await user.save();

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }

    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role,
        company: user.company?._id,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    const refreshToken = jwt.sign(
      { id: user._id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }
    );

    res.json({
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        company: user.company?._id,
        companyName: user.company?.name,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Refresh Token
router.post('/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    const newToken = jwt.sign(
      { id: decoded.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.json({ token: newToken });
  } catch (error) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Enable 2FA
router.post('/2fa/enable', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const secret = Math.random().toString(36).substring(2, 15);

    user.twoFactorSecret = secret;
    await user.save();

    res.json({
      message: '2FA enabled',
      secret,
      message_info: 'Save this secret in your authenticator app',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify 2FA
router.post('/2fa/verify', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findById(req.user.id);

    if (user.twoFactorSecret === code) {
      user.twoFactorEnabled = true;
      await user.save();
      res.json({ message: '2FA verified and enabled' });
    } else {
      res.status(400).json({ error: 'Invalid 2FA code' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
