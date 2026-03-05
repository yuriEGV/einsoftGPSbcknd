import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    const user = await User.findById(decoded.id);
    if (!user || user.status === 'suspended') {
      return res.status(401).json({ error: 'User not found or suspended' });
    }

    req.userObj = user;

    // Asegurarnos de que siempre haya company en req.user para los filtros
    if (!req.user.company && user.company) {
      req.user.company = user.company;
    }
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

export const rateLimitByUser = (req, res, next) => {
  // Implement rate limiting per user
  // This can be enhanced with Redis
  next();
};
