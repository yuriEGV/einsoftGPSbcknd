/**
 * telegramService.js
 * Wrapper sobre la Telegram Bot API (HTTP — sin librería externa).
 * Usa sólo `axios` que ya está instalado en el proyecto.
 */
import axios from 'axios';

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '8505291976:AAFiWVvgvRH69GJPmI-dYpod0liNMA1QJjM';
}

function getBaseUrl() {
  return `https://api.telegram.org/bot${getBotToken()}`;
}

// ─── Core sender ─────────────────────────────────────────────────────────────
async function apiCall(method, data = {}) {
  try {
    const res = await axios.post(`${getBaseUrl()}/${method}`, data, { timeout: 10000 });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    console.error(`[Telegram] ${method} error: ${detail}`);
    return null;
  }
}

// ─── sendMessage ─────────────────────────────────────────────────────────────
export async function sendMessage(chatId, text, extra = {}) {
  return apiCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

// ─── sendLocation ─────────────────────────────────────────────────────────────
export async function sendLocation(chatId, latitude, longitude, extra = {}) {
  return apiCall('sendLocation', { chat_id: chatId, latitude, longitude, ...extra });
}

// ─── editMessageText ─────────────────────────────────────────────────────────
export async function editMessageText(chatId, messageId, text, extra = {}) {
  return apiCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

// ─── answerCallbackQuery ─────────────────────────────────────────────────────
export async function answerCallbackQuery(callbackQueryId, text = '') {
  return apiCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// ─── setWebhook ─────────────────────────────────────────────────────────────
export async function setWebhook(url, secretToken) {
  return apiCall('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

// ─── deleteWebhook ──────────────────────────────────────────────────────────
export async function deleteWebhook() {
  return apiCall('deleteWebhook', { drop_pending_updates: true });
}

// ─── getWebhookInfo ─────────────────────────────────────────────────────────
export async function getWebhookInfo() {
  return apiCall('getWebhookInfo');
}

// ─── broadcastPanic ─────────────────────────────────────────────────────────
// Send panic alert to ALL admin/operator bot users
export async function broadcastPanic(chatIds, panicData) {
  const {
    sourceName, sourceType, latitude, longitude,
    address, speed, triggeredAt
  } = panicData;

  const platformUrl = sourceType === 'person'
    ? 'https://einsoft-gp-sfrntnd.vercel.app/people-tracker'
    : 'https://einsoft-gp-sfrntnd.vercel.app/dashboard';

  let timeStr = '';
  try {
    timeStr = new Date(triggeredAt || Date.now()).toLocaleString('es-CL', {
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
    });
  } catch (_) {
    timeStr = new Date().toISOString();
  }

  const hasCoords = latitude != null && longitude != null && (latitude !== 0 || longitude !== 0);

  const text = `🚨 <b>ALERTA DE PÁNICO SOS — EINSOFT GPS</b> 🚨\n\n` +
    `📌 <b>${sourceType === 'vehicle' ? '🚗 Vehículo' : '👤 Persona'}:</b> ${sourceName}\n` +
    `📍 <b>Ubicación:</b> ${address || 'Playa Ancha, Valparaíso'}\n` +
    (hasCoords ? `🌐 <b>Coordenadas GPS:</b> <code>${latitude.toFixed(5)}, ${longitude.toFixed(5)}</code>\n` : '') +
    (speed > 0 ? `💨 <b>Velocidad:</b> ${speed} km/h\n` : '') +
    `⏰ <b>Hora:</b> ${timeStr}\n\n` +
    `🛡️ <i>Alerta generada en tiempo real por el sistema EINSoft GPS.</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '✅ Reconocer Alerta', callback_data: `panic_ack:${panicData.panicId}` },
        { text: '✔️ Resolver', callback_data: `panic_resolve:${panicData.panicId}` },
      ],
      [
        { text: '🌐 Abrir en EINSoft GPS', url: platformUrl },
      ]
    ],
  };

  const results = [];
  for (const chatId of chatIds) {
    // 1. Enviar mensaje de alerta con botones
    const res = await sendMessage(chatId, text, { reply_markup: inlineKeyboard });
    results.push(res);

    // 2. Si hay coordenadas válidas, enviar el mapa nativo de Telegram inmediatamente
    if (hasCoords) {
      await sendLocation(chatId, latitude, longitude).catch(err => {
        console.warn('[Telegram] sendLocation fallback:', err.message);
      });
    }
  }
  return results;
}
