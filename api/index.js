import app from '../src/index.js';

export default function handler(req, res) {
  try {
    return app(req, res);
  } catch (err) {
    console.error('Vercel Serverless Handler Error:', err);
    res.status(500).json({
      error: 'Vercel Serverless Execution Error',
      message: err.message,
    });
  }
}
