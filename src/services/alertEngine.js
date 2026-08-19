/**
 * alertEngine.js
 * Motor de alertas automáticas EINSoft GPS.
 * Analiza cada nueva posición GPS y dispara alertas en Telegram + DB.
 */
import Alert from '../models/Alert.js';
import PanicAlert from '../models/PanicAlert.js';
import BotUser from '../models/BotUser.js';
import { broadcastPanic } from './telegramService.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function msSince(date) {
  return date ? Date.now() - new Date(date).getTime() : Infinity;
}

/**
 * Notifica a todos los BotUsers activos con rol admin/operator sobre una PanicAlert.
 * Guarda los messageIds en el documento de pánico.
 */
export async function notifyPanic(panicDoc, sourceName, sourceType) {
  try {
    const botUsers = await BotUser.find({ enabled: true }).lean();
    let chatIds = botUsers.map(a => a.telegramId).filter(Boolean);

    // Guaranteed fallback admin chat IDs so Telegram SOS is never lost
    const DEFAULT_ADMIN_CHATS = ['8929965445'];
    for (const d of DEFAULT_ADMIN_CHATS) {
      if (!chatIds.includes(d)) chatIds.push(d);
    }

    if (!chatIds.length) {
      console.warn('[alertEngine] notifyPanic: No Telegram chat IDs configured.');
      return;
    }

    console.log(`[alertEngine] 🚨 Transmitiendo PÁNICO a ${chatIds.length} destinatarios Telegram:`, chatIds);

    const results = await broadcastPanic(chatIds, {
      panicId: panicDoc._id.toString(),
      sourceName,
      sourceType,
      latitude: panicDoc.latitude,
      longitude: panicDoc.longitude,
      address: panicDoc.address,
      speed: panicDoc.speed,
      triggeredAt: panicDoc.triggeredAt,
    });

    await PanicAlert.findByIdAndUpdate(panicDoc._id, {
      telegramNotified: true,
      telegramChatIds: chatIds,
    });
  } catch (err) {
    console.error('[alertEngine] notifyPanic error:', err.message);
  }
}

// ─── analyzeVehicle ───────────────────────────────────────────────────────────
/**
 * Called after every sensor upload. Checks panic, speed, offline.
 * @param {Object} vehicle — Vehicle document (from DB)
 * @param {Object} payload — { gps, battery, alarmSensor }
 * @param {Object} io — Socket.IO instance (optional)
 */
export async function analyzeVehicle(vehicle, payload, io) {
  const { gps, battery, alarmSensor } = payload;
  const now = new Date();

  try {
    // ── 1. Panic button ────────────────────────────────────────────────────────
    if (alarmSensor?.panicButton || alarmSensor?.sos) {
      const existingPanic = await PanicAlert.findOne({
        vehicle: vehicle._id,
        status: 'ACTIVE',
      });

      if (!existingPanic) {
        const panicDoc = await PanicAlert.create({
          source: 'vehicle',
          vehicle: vehicle._id,
          company: vehicle.company,
          latitude: gps?.latitude || vehicle.location?.coordinates?.[1],
          longitude: gps?.longitude || vehicle.location?.coordinates?.[0],
          address: vehicle.location?.address || 'Sin dirección',
          speed: gps?.speed || vehicle.speed || 0,
          status: 'ACTIVE',
          triggeredAt: now,
        });

        console.log(`[alertEngine] 🚨 PÁNICO vehículo ${vehicle.licensePlate}`);
        await notifyPanic(panicDoc, vehicle.licensePlate, 'vehicle');
      }
    }

    // ── 2. Speed > 120 km/h ────────────────────────────────────────────────────
    if (gps?.speed > 120) {
      // Alert is also created in sensors.js — only notify Telegram here
      const admins = await BotUser.find({
        enabled: true,
        role: { $in: ['superadmin', 'admin', 'operator'] },
      }).lean();

      for (const admin of admins) {
        const { sendMessage } = await import('./telegramService.js');
        await sendMessage(
          admin.telegramId,
          `⚡ <b>EXCESO DE VELOCIDAD</b>\n🚗 ${vehicle.licensePlate}\n💨 ${Math.round(gps.speed)} km/h\n📍 ${vehicle.location?.address || 'Sin dir.'}`
        );
      }
    }

    // ── 3. GPS offline > 30 min ───────────────────────────────────────────────
    const lastUpdate = vehicle.lastUpdate || vehicle.updatedAt;
    if (msSince(lastUpdate) > 30 * 60 * 1000 && vehicle.status !== 'offline') {
      // This check is more of a scheduled job. Here we only mark it.
      console.log(`[alertEngine] ⚠️ Vehículo ${vehicle.licensePlate} sin señal > 30 min`);
    }
  } catch (err) {
    console.error('[alertEngine] analyzeVehicle error:', err.message);
  }
}

// ─── analyzePerson ─────────────────────────────────────────────────────────────
/**
 * Called after every person location update or panic trigger.
 * @param {Object} person — PersonTracker document
 * @param {Boolean} isPanic — whether this is a panic event
 */
export async function analyzePerson(person, isPanic = false) {
  try {
    if (!isPanic) return;

    const coords = person.location?.coordinates || [0, 0];
    const panicDoc = await PanicAlert.create({
      source: 'person',
      person: person._id,
      company: person.company,
      latitude: coords[1],
      longitude: coords[0],
      address: person.location?.address || 'Sin dirección',
      speed: person.speed || 0,
      status: 'ACTIVE',
      triggeredAt: new Date(),
    });

    console.log(`[alertEngine] 🚨 PÁNICO persona ${person.name}`);
    await notifyPanic(panicDoc, person.name, 'person');
  } catch (err) {
    console.error('[alertEngine] analyzePerson error:', err.message);
  }
}

// ─── acknowledgePanic ─────────────────────────────────────────────────────────
export async function acknowledgePanic(panicId, acknowledgedBy) {
  const panic = await PanicAlert.findByIdAndUpdate(panicId, {
    status: 'ACKNOWLEDGED',
    acknowledgedBy,
    acknowledgedAt: new Date(),
  }, { new: true });

  if (panic?.vehicle) {
    await Alert.updateMany(
      { vehicle: panic.vehicle, type: 'panic', acknowledged: false },
      { acknowledged: true, acknowledgedAt: new Date(), acknowledgeNotes: `Reconocido por ${acknowledgedBy}` }
    );
  }
  return panic;
}

// ─── resolvePanic ─────────────────────────────────────────────────────────────
export async function resolvePanic(panicId, resolvedBy, notes = '') {
  const panic = await PanicAlert.findByIdAndUpdate(panicId, {
    status: 'RESOLVED',
    acknowledgedBy: resolvedBy,
    resolvedAt: new Date(),
    notes,
  }, { new: true });

  if (panic?.vehicle) {
    await Vehicle.findByIdAndUpdate(panic.vehicle, { status: 'active' });
    await Alert.updateMany(
      { vehicle: panic.vehicle, type: 'panic' },
      { acknowledged: true, acknowledgedAt: new Date(), acknowledgeNotes: `Resuelto por ${resolvedBy}` }
    );
  }
  return panic;
}
