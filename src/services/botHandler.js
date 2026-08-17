/**
 * botHandler.js
 * Procesa todos los mensajes del bot de Telegram.
 * Rutas: /start, /vehiculos, /ubicacion, /estado, /alertas, /panico,
 *         /personas, /resumen, /detenidos, /sin_gps, /ayuda
 * Todo lo que no sea un comando conocido se envía a la IA.
 */
import BotUser from '../models/BotUser.js';
import Vehicle from '../models/Vehicle.js';
import PersonTracker from '../models/PersonTracker.js';
import Alert from '../models/Alert.js';
import PanicAlert from '../models/PanicAlert.js';
import {
  sendMessage,
  sendLocation,
  answerCallbackQuery,
  editMessageText,
} from './telegramService.js';
import { askAI } from './aiService.js';
import { acknowledgePanic, resolvePanic } from './alertEngine.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(date) {
  if (!date) return 'Nunca';
  return new Date(date).toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusEmoji(status) {
  const map = { active: '🟢', inactive: '🟡', offline: '🔴', alert: '🚨' };
  return map[status] || '⚫';
}

// ─── Authorization middleware ─────────────────────────────────────────────────
async function getOrCreateBotUser(telegramId, from) {
  let botUser = await BotUser.findOne({ telegramId: String(telegramId) });
  if (!botUser) {
    // Auto-register as viewer. Admin must elevate role manually.
    botUser = await BotUser.create({
      telegramId: String(telegramId),
      telegramUsername: from.username || '',
      telegramFirstName: from.first_name || '',
      role: 'viewer',
      enabled: true,
    });
    console.log(`[Bot] Auto-registered new viewer: @${from.username || telegramId}`);
  }
  if (!botUser.enabled) return null;

  // Update last activity
  botUser.lastActivity = new Date();
  await botUser.save();
  return botUser;
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleStart(chatId, botUser, from) {
  const name = from.first_name || 'Operador';
  const roleMap = {
    superadmin: '👑 Super Admin',
    admin: '🛡️ Administrador',
    operator: '🔧 Operador',
    driver: '🚗 Conductor',
    viewer: '👁️ Observador',
  };
  const role = roleMap[botUser.role] || botUser.role;

  await sendMessage(chatId,
    `👋 ¡Hola, <b>${name}</b>!\n\n` +
    `Soy el asistente de <b>EINSoft GPS</b>.\n` +
    `Tu rol: ${role}\n\n` +
    `<b>Comandos disponibles:</b>\n` +
    `/resumen — Resumen general de la flota\n` +
    `/vehiculos — Listar todos los vehículos\n` +
    `/ubicacion PATENTE — Ubicar un vehículo\n` +
    `/alertas — Alertas activas\n` +
    `/panico — Alertas de pánico activas\n` +
    `/personas — Personas rastreadas\n` +
    `/sin_gps — Vehículos sin señal\n` +
    `/ayuda — Esta ayuda\n\n` +
    `💬 También puedes <b>escribirme en lenguaje natural</b>:\n` +
    `<i>"¿Dónde está el auto ABC-123?"</i>\n` +
    `<i>"¿Hay alertas críticas ahora?"</i>`
  );
}

async function handleResumen(chatId) {
  const [vehicles, alerts, panics] = await Promise.all([
    Vehicle.find({}).select('status').lean(),
    Alert.countDocuments({ acknowledged: false, createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    PanicAlert.countDocuments({ status: 'ACTIVE' }),
  ]);

  const total = vehicles.length;
  const active = vehicles.filter(v => v.status === 'active').length;
  const offline = vehicles.filter(v => v.status === 'offline').length;
  const other = total - active - offline;

  await sendMessage(chatId,
    `📊 <b>Resumen de Flota EINSoft GPS</b>\n\n` +
    `🚗 <b>Total vehículos:</b> ${total}\n` +
    `🟢 <b>Activos:</b> ${active}\n` +
    `🔴 <b>Offline:</b> ${offline}\n` +
    `🟡 <b>Otros:</b> ${other}\n\n` +
    `🔔 <b>Alertas no reconocidas (24h):</b> ${alerts}\n` +
    `🚨 <b>Pánicos activos:</b> ${panics || 0}`
  );
}

async function handleVehiculos(chatId) {
  const vehicles = await Vehicle.find({})
    .select('licensePlate make model status speed location lastUpdate')
    .lean();

  if (!vehicles.length) {
    return sendMessage(chatId, '⚠️ No hay vehículos registrados en el sistema.');
  }

  let text = `🚗 <b>Vehículos (${vehicles.length})</b>\n\n`;
  for (const v of vehicles) {
    const emoji = statusEmoji(v.status);
    const speed = v.speed ? ` · ${v.speed} km/h` : '';
    const addr = v.location?.address || 'Sin ubicación';
    text += `${emoji} <b>${v.licensePlate}</b> — ${v.make || ''} ${v.model || ''}${speed}\n`;
    text += `   📍 ${addr}\n`;
    text += `   ⏱️ ${fmt(v.lastUpdate)}\n\n`;
  }

  await sendMessage(chatId, text.trim());
}

async function handleUbicacion(chatId, args) {
  const plate = args.join(' ').toUpperCase().replace(/[\s-]/g, '');
  if (!plate) {
    return sendMessage(chatId, '⚠️ Uso: /ubicacion PATENTE\nEjemplo: /ubicacion ABC123');
  }

  const vehicles = await Vehicle.find({}).select('licensePlate make model status speed location lastUpdate').lean();
  const vehicle = vehicles.find(v => v.licensePlate?.toUpperCase().replace(/[\s-]/g, '') === plate);

  if (!vehicle) {
    return sendMessage(chatId, `❌ No encontré ningún vehículo con patente <b>${plate}</b>.`);
  }

  const coords = vehicle.location?.coordinates;
  const lat = coords?.[1];
  const lng = coords?.[0];
  const hasCoords = lat && lng && (lat !== 0 || lng !== 0);

  await sendMessage(chatId,
    `🚗 <b>${vehicle.licensePlate}</b> — ${vehicle.make || ''} ${vehicle.model || ''}\n\n` +
    `${statusEmoji(vehicle.status)} <b>Estado:</b> ${vehicle.status}\n` +
    `💨 <b>Velocidad:</b> ${vehicle.speed || 0} km/h\n` +
    `📍 <b>Ubicación:</b> ${vehicle.location?.address || 'Sin dirección'}\n` +
    `⏱️ <b>Última actualización:</b> ${fmt(vehicle.lastUpdate)}`
  );

  if (hasCoords) {
    await sendLocation(chatId, lat, lng);
  }
}

async function handleAlertas(chatId) {
  const alerts = await Alert.find({
    acknowledged: false,
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate('vehicle', 'licensePlate')
    .lean();

  if (!alerts.length) {
    return sendMessage(chatId, '✅ No hay alertas activas en las últimas 24 horas.');
  }

  const severityEmoji = { low: '🔵', medium: '🟡', high: '🟠', critical: '🔴' };
  let text = `🔔 <b>Alertas activas (últimas 24h)</b>\n\n`;

  for (const a of alerts) {
    const emoji = severityEmoji[a.severity] || '⚫';
    text += `${emoji} ${a.message || a.type}\n`;
    if (a.vehicle?.licensePlate) text += `   🚗 ${a.vehicle.licensePlate}\n`;
    text += `   ⏱️ ${fmt(a.createdAt)}\n\n`;
  }

  await sendMessage(chatId, text.trim());
}

async function handlePanico(chatId) {
  const panics = await PanicAlert.find({ status: 'ACTIVE' })
    .populate('vehicle', 'licensePlate make model')
    .populate('person', 'name phone')
    .lean();

  if (!panics.length) {
    return sendMessage(chatId, '✅ No hay alertas de pánico activas actualmente.');
  }

  for (const p of panics) {
    const name = p.source === 'vehicle'
      ? `🚗 ${p.vehicle?.licensePlate || 'Vehículo desconocido'}`
      : `👤 ${p.person?.name || 'Persona desconocida'}`;

    const text =
      `🚨 <b>PÁNICO ACTIVO</b>\n\n` +
      `${name}\n` +
      `📍 ${p.address || 'Sin dirección'}\n` +
      `⏰ Desde: ${fmt(p.triggeredAt)}\n`;

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Reconocer', callback_data: `panic_ack:${p._id}` },
        { text: '✔️ Resolver', callback_data: `panic_resolve:${p._id}` },
      ]],
    };

    await sendMessage(chatId, text, { reply_markup: keyboard });

    if (p.latitude && p.longitude) {
      await sendLocation(chatId, p.latitude, p.longitude);
    }
  }
}

async function handlePersonas(chatId) {
  const persons = await PersonTracker.find({})
    .select('name phone status batteryLevel hasReportedLocation location updatedAt')
    .lean();

  if (!persons.length) {
    return sendMessage(chatId, '⚠️ No hay personas registradas para rastrear.');
  }

  let text = `👥 <b>Personas Rastreadas (${persons.length})</b>\n\n`;
  for (const p of persons) {
    const statusMap = { normal: '🟢', panic: '🚨', offline: '🔴' };
    const emoji = statusMap[p.status] || '⚫';
    const addr = p.hasReportedLocation
      ? (p.location?.address || 'Coordenadas disponibles')
      : 'Sin señal GPS';
    const bat = p.batteryLevel != null ? ` 🔋${p.batteryLevel}%` : '';

    text += `${emoji} <b>${p.name}</b>`;
    if (p.phone) text += ` · 📱 ${p.phone}`;
    text += `${bat}\n`;
    text += `   📍 ${addr}\n`;
    text += `   ⏱️ ${fmt(p.updatedAt)}\n\n`;
  }

  await sendMessage(chatId, text.trim());
}

async function handleSinGps(chatId) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const vehicles = await Vehicle.find({
    $or: [{ status: 'offline' }, { lastUpdate: { $lt: cutoff } }],
  }).select('licensePlate make model lastUpdate location').lean();

  if (!vehicles.length) {
    return sendMessage(chatId, '✅ Todos los vehículos tienen señal GPS reciente.');
  }

  let text = `📡 <b>Vehículos sin señal (${vehicles.length})</b>\n\n`;
  for (const v of vehicles) {
    text += `🔴 <b>${v.licensePlate}</b> — ${v.make || ''} ${v.model || ''}\n`;
    text += `   📍 ${v.location?.address || 'Última ubicación desconocida'}\n`;
    text += `   ⏱️ Última señal: ${fmt(v.lastUpdate)}\n\n`;
  }

  await sendMessage(chatId, text.trim());
}

async function handleAyuda(chatId) {
  await sendMessage(chatId,
    `📖 <b>Comandos EINSoft GPS Bot</b>\n\n` +
    `/start — Bienvenida y menú\n` +
    `/resumen — Resumen general de la flota\n` +
    `/vehiculos — Lista de vehículos\n` +
    `/ubicacion PATENTE — Ubicación de un vehículo\n` +
    `/alertas — Alertas sin reconocer (24h)\n` +
    `/panico — Alertas SOS activas\n` +
    `/personas — Personas rastreadas\n` +
    `/sin_gps — Vehículos offline o sin señal\n` +
    `/ayuda — Este menú\n\n` +
    `💬 <b>IA Conversacional:</b>\n` +
    `Escribe cualquier pregunta en lenguaje natural y la IA la responderá:\n` +
    `<i>"¿Cuántos vehículos están activos?"</i>\n` +
    `<i>"¿Dónde está el camión BBTD-23?"</i>\n` +
    `<i>"Muéstrame las alertas críticas"</i>`
  );
}

// ─── Callback Query Handler (inline buttons) ──────────────────────────────────
export async function handleCallbackQuery(callbackQuery) {
  const { id: callbackId, data, message, from } = callbackQuery;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  if (!data || !chatId) return;

  const [action, panicId] = data.split(':');

  if (action === 'panic_ack') {
    await acknowledgePanic(panicId, from.username || from.first_name);
    await answerCallbackQuery(callbackId, '✅ Alerta reconocida');
    await editMessageText(chatId, messageId,
      message.text + `\n\n✅ <b>Reconocida por @${from.username || from.first_name}</b> a las ${fmt(new Date())}`
    );
  } else if (action === 'panic_resolve') {
    await resolvePanic(panicId, from.username || from.first_name);
    await answerCallbackQuery(callbackId, '✔️ Alerta resuelta');
    await editMessageText(chatId, messageId,
      message.text + `\n\n✔️ <b>Resuelta por @${from.username || from.first_name}</b> a las ${fmt(new Date())}`
    );
  } else {
    await answerCallbackQuery(callbackId, 'Acción desconocida');
  }
}

// ─── Main message dispatcher ─────────────────────────────────────────────────
export async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const text = (message.text || '').trim();

  if (!text) return;

  // Authorization
  const botUser = await getOrCreateBotUser(chatId, from);
  if (!botUser) {
    return sendMessage(chatId, '🚫 Tu cuenta de bot está deshabilitada. Contacta al administrador.');
  }

  // Parse command
  const [rawCmd, ...args] = text.split(' ');
  const cmd = rawCmd.toLowerCase().split('@')[0]; // Handle /cmd@botname format

  try {
    switch (cmd) {
      case '/start':       return handleStart(chatId, botUser, from);
      case '/resumen':     return handleResumen(chatId);
      case '/vehiculos':   return handleVehiculos(chatId);
      case '/ubicacion':   return handleUbicacion(chatId, args);
      case '/estado':      return handleUbicacion(chatId, args); // alias
      case '/alertas':     return handleAlertas(chatId);
      case '/panico':      return handlePanico(chatId);
      case '/personas':    return handlePersonas(chatId);
      case '/sin_gps':     return handleSinGps(chatId);
      case '/ayuda':
      case '/help':        return handleAyuda(chatId);
      default: {
        // Everything else → AI
        await sendMessage(chatId, '🤔 Consultando con la IA...', { disable_notification: true });
        const aiResponse = await askAI(text);
        return sendMessage(chatId, aiResponse);
      }
    }
  } catch (err) {
    console.error('[botHandler] error:', err.message);
    await sendMessage(chatId, `⚠️ Error interno: ${err.message}`);
  }
}
