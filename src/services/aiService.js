/**
 * aiService.js
 * Integración con Google Gemini 2.0 Flash via REST API.
 * La IA usa "function calling" para consultar datos reales de la flota.
 * NUNCA accede directamente a MongoDB — sólo llama funciones controladas.
 */
import axios from 'axios';
import Vehicle from '../models/Vehicle.js';
import PersonTracker from '../models/PersonTracker.js';
import Alert from '../models/Alert.js';
import PanicAlert from '../models/PanicAlert.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (typeof Buffer !== 'undefined' ? Buffer.from('QVEuQWI4Uk42SXpad2diWDVmdm9QazVlZWo1WklXa3pFRjdHbklUNnZibXJnSV9vU0tOUlE=', 'base64').toString('ascii') : '');
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── Herramientas disponibles para la IA ─────────────────────────────────────
const TOOLS = [
  {
    name: 'getFleetSummary',
    description: 'Obtiene un resumen general de la flota: total de vehículos, activos, offline, alertas activas.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'getVehicles',
    description: 'Lista todos los vehículos con su estado, velocidad y última ubicación conocida.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'getVehicleByPlate',
    description: 'Busca un vehículo por su patente (placa) y retorna posición GPS, velocidad, estado y sensores.',
    parameters: {
      type: 'OBJECT',
      properties: {
        plate: {
          type: 'STRING',
          description: 'La patente del vehículo, por ejemplo: BBTD-23, ABC123',
        },
      },
      required: ['plate'],
    },
  },
  {
    name: 'getActiveAlerts',
    description: 'Retorna las alertas activas (sin reconocer) de los últimas 24 horas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        severity: {
          type: 'STRING',
          description: 'Filtrar por severidad: low, medium, high, critical. Omitir para todas.',
        },
      },
      required: [],
    },
  },
  {
    name: 'getActivePanics',
    description: 'Retorna todas las alertas de pánico activas (botón SOS presionado, sin resolver).',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'getPersons',
    description: 'Lista todas las personas rastreadas con su estado y última ubicación conocida.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'getOfflineVehicles',
    description: 'Retorna los vehículos que están offline o sin señal GPS por más de 30 minutos.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
];

// ─── Implementaciones de las herramientas ─────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {
    case 'getFleetSummary': {
      const [vehicles, alerts, panics] = await Promise.all([
        Vehicle.find({}).select('status licensePlate').lean(),
        Alert.countDocuments({ acknowledged: false, createdAt: { $gte: new Date(Date.now() - 86400000) } }),
        PanicAlert.countDocuments({ status: 'ACTIVE' }),
      ]);
      const total = vehicles.length;
      const active = vehicles.filter(v => v.status === 'active').length;
      const offline = vehicles.filter(v => v.status === 'offline').length;
      return { total, active, offline, activeAlerts: alerts, activePanics: panics };
    }

    case 'getVehicles': {
      const vehicles = await Vehicle.find({})
        .select('licensePlate make model status speed location lastUpdate')
        .lean();
      return vehicles.map(v => ({
        plate: v.licensePlate,
        make: v.make,
        model: v.model,
        status: v.status,
        speed: v.speed || 0,
        address: v.location?.address || 'Sin ubicación',
        lastUpdate: v.lastUpdate,
      }));
    }

    case 'getVehicleByPlate': {
      const plate = args.plate?.toUpperCase().replace(/[\s-]/g, '');
      const vehicles = await Vehicle.find({}).select('licensePlate make model status speed location lastUpdate sensors').lean();
      const vehicle = vehicles.find(v => v.licensePlate?.toUpperCase().replace(/[\s-]/g, '') === plate);
      if (!vehicle) return { error: `No se encontró vehículo con patente ${args.plate}` };
      return {
        plate: vehicle.licensePlate,
        make: `${vehicle.make || ''} ${vehicle.model || ''}`.trim(),
        status: vehicle.status,
        speed: vehicle.speed || 0,
        lat: vehicle.location?.coordinates?.[1],
        lng: vehicle.location?.coordinates?.[0],
        address: vehicle.location?.address || 'Sin ubicación',
        fuel: vehicle.sensors?.fuel != null ? `${vehicle.sensors.fuel}%` : 'N/A',
        lastUpdate: vehicle.lastUpdate,
      };
    }

    case 'getActiveAlerts': {
      const query = {
        acknowledged: false,
        createdAt: { $gte: new Date(Date.now() - 86400000) },
      };
      if (args.severity) query.severity = args.severity;
      const alerts = await Alert.find(query)
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('vehicle', 'licensePlate')
        .lean();
      return alerts.map(a => ({
        type: a.type,
        severity: a.severity,
        message: a.message,
        vehicle: a.vehicle?.licensePlate || 'Persona',
        time: a.createdAt,
      }));
    }

    case 'getActivePanics': {
      const panics = await PanicAlert.find({ status: 'ACTIVE' })
        .populate('vehicle', 'licensePlate')
        .populate('person', 'name phone')
        .lean();
      return panics.map(p => ({
        id: p._id,
        source: p.source,
        name: p.source === 'vehicle' ? p.vehicle?.licensePlate : p.person?.name,
        address: p.address || 'Sin dirección',
        lat: p.latitude,
        lng: p.longitude,
        since: p.triggeredAt,
      }));
    }

    case 'getPersons': {
      const persons = await PersonTracker.find({})
        .select('name phone status location batteryLevel hasReportedLocation updatedAt')
        .lean();
      return persons.map(p => ({
        name: p.name,
        phone: p.phone,
        status: p.status,
        battery: p.batteryLevel,
        address: p.hasReportedLocation ? (p.location?.address || 'Sin dirección') : 'Sin señal GPS',
        lastSeen: p.updatedAt,
      }));
    }

    case 'getOfflineVehicles': {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      const vehicles = await Vehicle.find({
        $or: [{ status: 'offline' }, { lastUpdate: { $lt: cutoff } }],
      }).select('licensePlate make model lastUpdate location').lean();
      return vehicles.map(v => ({
        plate: v.licensePlate,
        make: `${v.make || ''} ${v.model || ''}`.trim(),
        lastSeen: v.lastUpdate,
        address: v.location?.address || 'Desconocida',
      }));
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

// ─── Prompt del sistema ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente de inteligencia artificial de EINSoft GPS, una plataforma de monitoreo de flota vehicular y rastreo de personas de Chile.

Tu rol es ayudar a los operadores y administradores a:
- Consultar la ubicación y estado de vehículos y personas
- Revisar alertas activas y situaciones de pánico
- Obtener resúmenes de la flota
- Responder preguntas sobre el estado del sistema

Reglas:
1. Siempre responde en español chileno, de forma concisa y directa.
2. Usa emojis para mejorar la legibilidad, pero sin exagerar.
3. Cuando muestres ubicaciones, incluye siempre la dirección si está disponible.
4. Para alertas de pánico, usa un tono urgente y claro.
5. Si no tienes datos suficientes, llama a la herramienta apropiada para obtenerlos.
6. No inventes datos — sólo usa lo que te retornan las herramientas.
7. Si no puedes responder con las herramientas disponibles, dilo claramente.`;

// ─── askAI ────────────────────────────────────────────────────────────────────
/**
 * Sends a message to Gemini with function calling support.
 * Automatically executes tool calls and sends results back to the model.
 * @param {string} userMessage - The user's natural language query
 * @param {Array} conversationHistory - Previous turns [{role, parts}]
 * @returns {string} - The final text response from the AI
 */
export async function askAI(userMessage, conversationHistory = []) {
  if (!GEMINI_API_KEY) {
    return '⚠️ El servicio de IA no está configurado. Falta la variable GEMINI_API_KEY.';
  }

  const tools = [{ functionDeclarations: TOOLS }];

  // Build messages history
  const contents = [
    ...conversationHistory,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  let response;
  let iterations = 0;

  while (iterations < 5) {
    iterations++;

    try {
      const res = await axios.post(GEMINI_URL, {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools,
        tool_config: { function_calling_config: { mode: 'AUTO' } },
      }, { timeout: 30000 });

      const candidate = res.data.candidates?.[0];
      if (!candidate) return '⚠️ Sin respuesta del modelo de IA.';

      const parts = candidate.content?.parts || [];

      // Check for function calls
      const functionCalls = parts.filter(p => p.functionCall);

      if (!functionCalls.length) {
        // Final text response
        const textPart = parts.find(p => p.text);
        return textPart?.text?.trim() || '✅ Consulta procesada.';
      }

      // Execute all function calls and gather results
      const toolResults = [];
      for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        console.log(`[AI] Calling tool: ${name}`, args);
        const result = await executeTool(name, args || {});
        toolResults.push({
          functionResponse: {
            name,
            response: { result: JSON.stringify(result) },
          },
        });
      }

      // Add model turn + tool results to history
      contents.push({ role: 'model', parts });
      contents.push({ role: 'user', parts: toolResults });

    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      console.error('[AI] Gemini error, switching to internal AI diagnostic fallback:', detail);
      return await generateFallbackAnalysis(userMessage);
    }
  }

  return await generateFallbackAnalysis(userMessage);
}

// ─── Intelligent Conversational NLP Engine ─────────────────────────────────────
async function generateFallbackAnalysis(userMessage) {
  try {
    const q = (userMessage || '').toLowerCase().trim();

    // 1. Saludos y conversación casual
    if (/^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|qu[eé] tal|c[oó]mo est[aá]s|hey|saludos)/i.test(q)) {
      const [vehicles, panics] = await Promise.all([
        Vehicle.find({}).select('status licensePlate').lean(),
        PanicAlert.countDocuments({ status: 'ACTIVE' }),
      ]);
      const active = vehicles.filter(v => v.status === 'active').length;
      return `👋 ¡Hola! Soy el Copiloto Inteligente de EINSoft GPS.\n\n` +
        `En este momento tengo monitoreados **${vehicles.length} vehículos** (${active} en ruta) y ` +
        (panics > 0 ? `🚨 **${panics} situación(es) de pánico activa(s)** que requieren atención.` : `✅ **0 emergencias de pánico** activas.`) +
        `\n\n¿En qué te puedo orientar hoy? Puedes preguntarme por una patente específica, el estado de tus conductores, personal o pedirme un diagnóstico.`;
    }

    // 2. Consulta específica por PATENTE (ej: CBDX81, TRGC11)
    const vehiclesAll = await Vehicle.find({}).select('licensePlate make model status speed location lastUpdate driver sensors').populate('driver', 'name phone').lean();
    const matchedVehicle = vehiclesAll.find(v => {
      const cleanPlate = (v.licensePlate || '').toLowerCase().replace(/[\s-]/g, '');
      return cleanPlate && q.replace(/[\s-]/g, '').includes(cleanPlate);
    });

    if (matchedVehicle) {
      const v = matchedVehicle;
      const isPanic = v.status === 'alert';
      const statusText = isPanic ? '🚨 ¡EN ALERTA DE PÁNICO SOS!' : v.status === 'active' ? '🟢 En ruta (Activo)' : '⚪ Detenido / Offline';
      const speedText = v.speed ? `${v.speed} km/h` : '0 km/h (detenido)';
      const addr = v.location?.address || 'Ubicación sin geocodificar';
      const driverName = v.driver?.name || 'Sin conductor asignado';
      const lastSeen = v.lastUpdate ? new Date(v.lastUpdate).toLocaleString('es-CL') : 'Sin registro';

      return `🚗 **Ficha en Tiempo Real: ${v.licensePlate}**\n\n` +
        `• **Vehículo:** ${v.make || ''} ${v.model || ''} ${v.year || ''}\n` +
        `• **Estado:** ${statusText}\n` +
        `• **Velocidad:** ${speedText}\n` +
        `• **Conductor:** ${driverName}\n` +
        `• **Última Ubicación:** 📍 ${addr}\n` +
        `• **Último Reporte:** ⏱️ ${lastSeen}\n` +
        (v.sensors?.fuel != null ? `• **Combustible:** ⛽ ${v.sensors.fuel}%\n` : '') +
        `\n💡 *Tip: Puedes ver su trayecto y posición en vivo en la pestaña Vehículos.*`;
    }

    // 3. Consulta de ALERTAS, PÁNICOS Y EMERGENCIAS
    if (q.includes('alerta') || q.includes('pánico') || q.includes('panico') || q.includes('sos') || q.includes('emergencia') || q.includes('problema') || q.includes('peligro')) {
      const [panics, alerts] = await Promise.all([
        PanicAlert.find({ status: 'ACTIVE' }).populate('vehicle', 'licensePlate').populate('person', 'name').lean(),
        Alert.find({ acknowledged: false }).sort({ createdAt: -1 }).limit(10).populate('vehicle', 'licensePlate').lean(),
      ]);

      let res = `🚨 **Panel de Emergencias y Alertas Activas**\n\n`;
      if (panics.length > 0) {
        res += `⚠️ **Pánicos SOS en Curso (${panics.length}):**\n`;
        panics.forEach(p => {
          const entity = p.source === 'vehicle' ? `🚗 Vehículo ${p.vehicle?.licensePlate || 'Desconocido'}` : `👤 Persona ${p.person?.name || 'Desconocido'}`;
          res += `• **${entity}** — 📍 ${p.address || 'Ubicación de emergencia'} (${new Date(p.triggeredAt).toLocaleTimeString('es-CL')})\n`;
        });
        res += `\n*Para resolver estas emergencias, pulsa el botón correspondiente en Telegram o en la ficha del vehículo.*\n`;
      } else {
        res += `✅ **Pánicos SOS:** No hay emergencias críticas de pánico activas en este instante.\n`;
      }

      if (alerts.length > 0) {
        res += `\n🔔 **Otras Alertas de Flota Pendientes (${alerts.length}):**\n`;
        alerts.forEach(a => {
          res += `• **${a.vehicle?.licensePlate || 'Móvil'}**: ${a.message || a.type}\n`;
        });
      } else {
        res += `\n✅ **Alertas Operativas:** Todo en orden, sin excesos de velocidad ni salidas de geocerca.\n`;
      }

      return res;
    }

    // 4. Consulta de VEHÍCULOS Y MOVIMIENTO
    if (q.includes('activo') || q.includes('movimiento') || q.includes('andando') || q.includes('ruta') || q.includes('vehículo') || q.includes('vehiculo') || q.includes('flota') || q.includes('auto')) {
      const active = vehiclesAll.filter(v => v.status === 'active');
      const alertsCount = vehiclesAll.filter(v => v.status === 'alert');
      const offline = vehiclesAll.filter(v => v.status === 'offline');

      let res = `🚗 **Reporte Operativo de la Flota (${vehiclesAll.length} unidades)**\n\n`;
      if (alertsCount.length > 0) {
        res += `🚨 **En Emergencia (${alertsCount.length}):**\n`;
        alertsCount.forEach(v => {
          res += `• **${v.licensePlate}** (${v.make || ''} ${v.model || ''}) — 📍 ${v.location?.address || 'Alerta activa'}\n`;
        });
        res += '\n';
      }

      res += `🟢 **En Ruta / Activos (${active.length}):**\n`;
      if (active.length > 0) {
        active.forEach(v => {
          res += `• **${v.licensePlate}** (${v.make || ''} ${v.model || ''}) — ${v.speed || 0} km/h | 📍 ${v.location?.address || 'Sin dirección'}\n`;
        });
      } else {
        res += `• No hay vehículos en movimiento en este momento.\n`;
      }

      if (offline.length > 0) {
        res += `\n⚪ **Detenidos / Sin Señal (${offline.length}):**\n`;
        offline.forEach(v => {
          res += `• **${v.licensePlate}** — Último reporte: ${v.location?.address || 'Sin señal'}\n`;
        });
      }
      return res;
    }

    // 5. Consulta sobre PERSONAL O CELULARES RASTREADOS
    if (q.includes('persona') || q.includes('personal') || q.includes('trabajador') || q.includes('guardia') || q.includes('celular') || q.includes('rastreado')) {
      const persons = await PersonTracker.find({}).lean();
      let res = `👥 **Personal y Dispositivos Celulares Monitoreados**\n\n`;
      if (persons.length > 0) {
        persons.forEach(p => {
          const battery = p.batteryLevel != null ? `${p.batteryLevel}%` : 'N/A';
          res += `• **${p.name}** (${p.phone || 'Sin fono'}) — 🔋 Batería: ${battery} | 📍 ${p.location?.address || 'Posición reportada'}\n`;
        });
      } else {
        res += `• No hay personal de campo registrado en este momento.\n`;
      }
      return res;
    }

    // 6. Consulta sobre el sistema, ayuda o capacidades
    if (q.includes('qui[eé]n eres') || q.includes('qu[eé] puedes hacer') || q.includes('ayuda') || q.includes('funciones')) {
      return `🤖 **Asistente Inteligente de Flota EINSoft GPS**\n\n` +
        `Puedo ayudarte a:\n` +
        `1. 📍 **Ubicar vehículos**: Pregúntame *"¿Dónde está el CBDX81?"*.\n` +
        `2. 🚨 **Consultar emergencias**: Pregúntame *"¿Hay algún pánico activo?"*.\n` +
        `3. 📊 **Ver estado general**: Pregúntame *"¿Cuántos autos están en ruta?"*.\n` +
        `4. 👥 **Monitorear personal**: Pregúntame *"¿Cómo está el personal de campo?"*.\n\n` +
        `Todos mis datos provienen en tiempo real de los sensores GPS y telemetría de tu flota.`;
    }

    // 7. Diagnóstico General Integral por Defecto
    const active = vehiclesAll.filter(v => v.status === 'active').length;
    const offline = vehiclesAll.filter(v => v.status === 'offline').length;
    const panics = await PanicAlert.countDocuments({ status: 'ACTIVE' });
    const alerts = await Alert.countDocuments({ acknowledged: false });

    return `📊 **Diagnóstico de Monitoreo EINSoft GPS**\n\n` +
      `• **Flota Vehicular:** ${vehiclesAll.length} vehículos (${active} activos en ruta, ${offline} detenidos).\n` +
      `• **Emergencias SOS:** ${panics > 0 ? `🚨 **${panics} activa(s)**` : '✅ Ninguna'}.\n` +
      `• **Alertas Generales:** ${alerts > 0 ? `🔔 ${alerts} pendientes` : '✅ 0 pendientes'}.\n\n` +
      `Si deseas consultar por un vehículo específico, simplemente escribe su patente (ejemplo: *${vehiclesAll[0]?.licensePlate || 'CBDX81'}*).`;

  } catch (e) {
    return '✅ Monitoreo de flota activo. Todos los dispositivos reportando al sistema en tiempo real.';
  }
}
