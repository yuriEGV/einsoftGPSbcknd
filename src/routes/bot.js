/**
 * bot.js — Rutas Express para el webhook de Telegram y administración del bot.
 *
 * Endpoints:
 *   POST /api/bot/webhook          — Recibe updates de Telegram (webhook)
 *   POST /api/bot/setup-webhook    — Registra el webhook con Telegram
 *   GET  /api/bot/status           — Estado del webhook y bot users
 *   POST /api/bot/users            — Crear/actualizar un bot user (admin)
 *   GET  /api/bot/users            — Listar bot users (admin)
 *   DELETE /api/bot/users/:tid     — Deshabilitar un bot user (admin)
 *   GET  /api/bot/panics           — Alertas de pánico activas
 *   POST /api/bot/panics/:id/ack   — Reconocer pánico
 *   POST /api/bot/panics/:id/resolve — Resolver pánico
 */
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { handleMessage, handleCallbackQuery } from '../services/botHandler.js';
import { setWebhook, getWebhookInfo, sendMessage } from '../services/telegramService.js';
import { acknowledgePanic, resolvePanic } from '../services/alertEngine.js';
import BotUser from '../models/BotUser.js';
import PanicAlert from '../models/PanicAlert.js';

const router = express.Router();

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'einsoft-gps-secret';

// ─── POST /api/bot/webhook — Telegram sends all updates here ─────────────────
router.post('/webhook', async (req, res) => {
  // Validate secret token header
  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (incomingSecret !== WEBHOOK_SECRET) {
    console.warn('[Bot] Invalid webhook secret:', incomingSecret);
    return res.status(403).end();
  }

  // Respond immediately so Telegram doesn't retry
  res.status(200).end();

  const update = req.body;

  // Dispatch async (don't await — webhook must return fast)
  setImmediate(async () => {
    try {
      if (update.message) {
        await handleMessage(update.message);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      }
    } catch (err) {
      console.error('[Bot] Webhook dispatch error:', err.message);
    }
  });
});

// ─── POST /api/bot/setup-webhook — Register webhook with Telegram ────────────
router.post('/setup-webhook', authenticate, async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || process.env.BACKEND_URL;
    if (!baseUrl) {
      return res.status(400).json({ error: 'Se requiere baseUrl o variable BACKEND_URL' });
    }

    const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/bot/webhook`;
    const result = await setWebhook(webhookUrl, WEBHOOK_SECRET);

    res.json({
      success: true,
      webhookUrl,
      telegramResponse: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bot/status ─────────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  try {
    const [webhookInfo, botUsers, activePanics] = await Promise.all([
      getWebhookInfo(),
      BotUser.find({}).select('telegramId telegramUsername role enabled lastActivity').lean(),
      PanicAlert.countDocuments({ status: 'ACTIVE' }),
    ]);

    res.json({
      webhook: webhookInfo?.result || null,
      botUsers,
      activePanics,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bot/users — Create or update a bot user ──────────────────────
router.post('/users', authenticate, async (req, res) => {
  try {
    const { telegramId, telegramUsername, role, enabled, allowedVehicles } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId es requerido' });

    const botUser = await BotUser.findOneAndUpdate(
      { telegramId: String(telegramId) },
      {
        telegramUsername: telegramUsername || '',
        role: role || 'viewer',
        enabled: enabled !== undefined ? enabled : true,
        allowedVehicles: allowedVehicles || [],
        company: req.user?.company || null,
      },
      { upsert: true, new: true }
    );

    // Notify the user via Telegram
    if (botUser.telegramId) {
      await sendMessage(
        botUser.telegramId,
        `✅ Tu acceso al <b>Bot EINSoft GPS</b> ha sido configurado.\n` +
        `Rol: <b>${role || 'viewer'}</b>\n\n` +
        `Escribe /start para comenzar.`
      );
    }

    res.json(botUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bot/users — List all bot users ─────────────────────────────────
router.get('/users', authenticate, async (req, res) => {
  try {
    const users = await BotUser.find({})
      .sort({ createdAt: -1 })
      .populate('userId', 'name email')
      .lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/bot/users/:tid — Disable a bot user ─────────────────────────
router.delete('/users/:tid', authenticate, async (req, res) => {
  try {
    const user = await BotUser.findOneAndUpdate(
      { telegramId: req.params.tid },
      { enabled: false },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'Bot user not found' });
    res.json({ message: 'Bot user deshabilitado', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bot/panics — Active panic alerts ───────────────────────────────
router.get('/panics', authenticate, async (req, res) => {
  try {
    const panics = await PanicAlert.find({ status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] } })
      .populate('vehicle', 'licensePlate make model')
      .populate('person', 'name phone')
      .sort({ triggeredAt: -1 })
      .lean();
    res.json(panics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bot/panics/:id/ack — Acknowledge panic ───────────────────────
router.post('/panics/:id/ack', authenticate, async (req, res) => {
  try {
    const by = req.user?.name || req.user?.email || 'Sistema';
    const panic = await acknowledgePanic(req.params.id, by);
    if (!panic) return res.status(404).json({ error: 'Panic alert not found' });
    res.json(panic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bot/panics/:id/resolve — Resolve panic ───────────────────────
router.post('/panics/:id/resolve', authenticate, async (req, res) => {
  try {
    const by = req.user?.name || req.user?.email || 'Sistema';
    const panic = await resolvePanic(req.params.id, by, req.body.notes || '');
    if (!panic) return res.status(404).json({ error: 'Panic alert not found' });
    res.json(panic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
