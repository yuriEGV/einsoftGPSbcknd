import winston from 'winston';
import { existsSync, mkdirSync } from 'fs';

// Vercel sets VERCEL=1 automatically. In serverless the filesystem is read-only,
// so we must skip file transports entirely and only log to console.
const isServerless = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

if (!isServerless) {
  if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
  transports.push(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports,
});

export const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });

  next();
};

export default logger;
