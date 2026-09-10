import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function serveApk(req, res, preferredFilename = 'einsoft-gps.apk', downloadName = 'einsoft-gps-v2.1.0.apk') {
  // Search possible paths for the APK
  const candidates = [
    path.join(process.cwd(), 'public', preferredFilename),
    path.join(process.cwd(), preferredFilename),
    path.join(__dirname, '../../public', preferredFilename),
    path.join(__dirname, '../../public/einsoft-gps.apk'),
    path.join(__dirname, '../../public/eyenode.apk'),
    path.join(__dirname, '../../../frontend/public', preferredFilename),
    path.join(__dirname, '../../../frontend/public/einsoft-gps.apk'),
    path.join(__dirname, '../../../frontend/public/eyenode.apk'),
  ];

  let resolvedPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      resolvedPath = p;
      break;
    }
  }

  if (!resolvedPath) {
    return res.status(404).json({ error: 'Archivo APK no encontrado en el servidor. Por favor contacte soporte.' });
  }

  const stat = fs.statSync(resolvedPath);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const stream = fs.createReadStream(resolvedPath);
  stream.pipe(res);
}

// ─── GET /api/download/apk ───────────────────────────────────────────────────
router.get('/apk', (req, res) => {
  serveApk(req, res, 'einsoft-gps.apk', 'einsoft-gps-v2.1.0.apk');
});

// ─── GET /api/download/einsoft-gps.apk ───────────────────────────────────────
router.get('/einsoft-gps.apk', (req, res) => {
  serveApk(req, res, 'einsoft-gps.apk', 'einsoft-gps-v2.1.0.apk');
});

// ─── GET /api/download/eyenode.apk ───────────────────────────────────────────
router.get('/eyenode.apk', (req, res) => {
  serveApk(req, res, 'eyenode.apk', 'eyenode-v2.1.0.apk');
});

export default router;
