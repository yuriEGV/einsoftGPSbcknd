/**
 * Einsoft GPS — Professional TCP Bridge Server
 * =============================================
 * Receives raw binary/text data from GPS hardware devices
 * and forwards decoded data to the Einsoft GPS backend.
 *
 * Supported protocols:
 *   Port 5023 — GT06 / Concox (binary) — Most Chinese trackers
 *   Port 5013 — H02 / Huabao (text)   — Huabao, Smart Tags
 *   Port 5002 — TK103 / GPS103 (text) — Coban, generic clones
 *   Port 8090 — HTTP relay             — Devices with URL setting
 *
 * Usage: node server.js
 */

import net from 'net';
import http from 'http';
import https from 'https';
import dotenv from 'dotenv';
import parseGT06 from './protocols/gt06.js';
import parseH02  from './protocols/h02.js';
import parseTK103 from './protocols/tk103.js';

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────
const EINSOFT_BACKEND = process.env.EINSOFT_BACKEND_URL || 'https://einsoft-gp-sbcknd.vercel.app';
const API_ENDPOINT    = `${EINSOFT_BACKEND}/api/sensors/upload`;

const PORTS = {
  GT06:  parseInt(process.env.PORT_GT06)  || 5023,
  H02:   parseInt(process.env.PORT_H02)   || 5013,
  TK103: parseInt(process.env.PORT_TK103) || 5002,
  HTTP:  parseInt(process.env.PORT_HTTP)  || 8090,
};

// Track IMEI per TCP socket (devices send IMEI in a login packet, then GPS packets)
const socketImei = new Map();
let totalPackets = 0;
let totalForwarded = 0;
let totalErrors = 0;

// ─── Forward to Einsoft GPS Backend (with 1 retry on network error) ──────────
async function forwardToEinsoft(imei, payload, retryCount = 0) {
  if (!imei) {
    console.warn('⚠️  Skipping packet — IMEI not known yet');
    return;
  }

  const body = JSON.stringify({
    deviceIMEI: String(imei),
    ...payload,
  });

  const url = new URL(API_ENDPOINT);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve) => {
    const req = lib.request({
      hostname: url.hostname,
      path: url.pathname,
      port: isHttps ? 443 : (url.port || 80),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'EinsoftGPS-Bridge/2.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201 || res.statusCode === 200) {
          totalForwarded++;
          console.log(`✅ Forwarded [${imei}] → HTTP ${res.statusCode}`);
        } else if (res.statusCode === 404) {
          console.warn(`⚠️  IMEI ${imei} no está vinculado a ningún vehículo ni persona en Einsoft GPS`);
          console.warn('   → Ve a Vehículos o Rastreo Personal → Vincular Dispositivo y agrega este IMEI');
        } else if (res.statusCode >= 500 && retryCount === 0) {
          // 1 retry on server errors (cold-start serverless)
          console.warn(`⚠️  Backend 5xx — retrying in 3s [${imei}]`);
          setTimeout(() => forwardToEinsoft(imei, payload, 1).then(resolve), 3000);
          return;
        } else {
          totalErrors++;
          console.error(`❌ Backend error ${res.statusCode}: ${data.slice(0, 200)}`);
        }
        resolve();
      });
    });

    req.on('error', (e) => {
      totalErrors++;
      if (retryCount === 0) {
        console.warn(`⚠️  Network error — retrying in 5s [${imei}]: ${e.message}`);
        setTimeout(() => forwardToEinsoft(imei, payload, 1).then(resolve), 5000);
      } else {
        console.error(`❌ Network error (no more retries) [${imei}]: ${e.message}`);
        resolve();
      }
    });

    req.setTimeout(12000, () => {
      totalErrors++;
      req.destroy();
      console.error(`❌ Request timeout [${imei}]`);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

// ─── Process decoded packets ──────────────────────────────────────────────────
async function processPackets(packets) {
  for (const packet of packets) {
    if (!packet.imei) continue;
    totalPackets++;

    if (packet.type === 'gps') {
      // FIX: Double-check coords are valid before forwarding (parsers already filter, but defensive)
      const { latitude, longitude } = packet.gps || {};
      if (typeof latitude !== 'number' || typeof longitude !== 'number'
          || isNaN(latitude) || isNaN(longitude)
          || (latitude === 0 && longitude === 0)
          || latitude < -90 || latitude > 90
          || longitude < -180 || longitude > 180) {
        console.warn(`[Bridge] ⚠️  Dropping GPS packet from ${packet.imei}: invalid coords (${latitude}, ${longitude})`);
        continue;
      }
      await forwardToEinsoft(packet.imei, {
        gps: packet.gps,
        battery: packet.battery,
        alarmSensor: packet.alarmSensor,
      });
    } else if (packet.type === 'alarm') {
      await forwardToEinsoft(packet.imei, {
        alarmSensor: { sos: packet.alarmType === 'sos' },
      });
    }
    // invalidGps, heartbeat, login packets are not forwarded
  }
}

// ─── Generic TCP Server Factory ───────────────────────────────────────────────
function createTCPServer(protocolName, parser) {
  const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[${protocolName}] 🔌 New connection: ${clientId}`);

    let imei = null;
    let buffer = Buffer.alloc(0);

    socket.on('data', async (data) => {
      buffer = Buffer.concat([buffer, data]);

      try {
        const result = parser(buffer, imei);

        // Send ACK responses back to device (required to keep connection alive)
        for (const ack of result.acks) {
          socket.write(ack);
        }

        // Update IMEI if we learned it from a login packet
        if (result.imei && result.imei !== imei) {
          imei = result.imei;
          socketImei.set(socket, imei);
          console.log(`[${protocolName}] 🔑 IMEI registered: ${imei}`);
        }

        await processPackets(result.packets);

        // Clear buffer after successful processing
        buffer = Buffer.alloc(0);
      } catch (e) {
        console.error(`[${protocolName}] Parse error:`, e.message);
        // Don't clear buffer — might be incomplete packet, wait for more data
        // Clear if buffer gets too large (prevents memory leak)
        if (buffer.length > 4096) buffer = Buffer.alloc(0);
      }
    });

    socket.on('close', () => {
      socketImei.delete(socket);
      console.log(`[${protocolName}] 🔌 Disconnected: ${clientId} (${imei || 'no IMEI'})`);
    });

    socket.on('error', (e) => {
      if (e.code !== 'ECONNRESET') {
        console.error(`[${protocolName}] Socket error: ${e.message}`);
      }
    });

    socket.setTimeout(120000); // 2 min timeout
    socket.on('timeout', () => {
      console.log(`[${protocolName}] ⏱️  Timeout: ${clientId}`);
      socket.destroy();
    });
  });

  return server;
}

// ─── HTTP relay server (port 8090) ────────────────────────────────────────────
// Accepts the same format as /api/sensors/find-hub and forwards to backend
function createHTTPRelayServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Handle GET (query string devices)
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://localhost:${PORTS.HTTP}`);
      const imei = url.searchParams.get('imei') || url.searchParams.get('id');
      const lat  = parseFloat(url.searchParams.get('lat') || url.searchParams.get('latitude') || '');
      const lng  = parseFloat(url.searchParams.get('lng') || url.searchParams.get('lon') || url.searchParams.get('longitude') || '');
      const spd  = parseFloat(url.searchParams.get('speed') || '0');

      if (imei && !isNaN(lat) && !isNaN(lng)) {
        await forwardToEinsoft(imei, { gps: { latitude: lat, longitude: lng, speed: spd } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(400);
        res.end('Missing imei, lat, lng');
      }
      return;
    }

    // Handle POST (JSON body)
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const imei = data.imei || data.deviceIMEI || data.IMEI || data.device_id;
        const lat  = data.lat || data.latitude || data.gps?.lat || data.gps?.latitude;
        const lng  = data.lng || data.lon || data.longitude || data.gps?.lon || data.gps?.longitude;
        const spd  = data.speed || data.spd || data.gps?.speed || 0;

        if (imei && lat != null && lng != null) {
          await forwardToEinsoft(String(imei), {
            gps: { latitude: parseFloat(lat), longitude: parseFloat(lng), speed: parseFloat(spd) },
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing imei, lat, or lng' }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  });
}

// ─── Stats display ────────────────────────────────────────────────────────────
function printStats() {
  const mem = process.memoryUsage();
  const memMB = Math.round(mem.rss / 1024 / 1024);
  console.log(`\n📊 Stats | Received: ${totalPackets} | Forwarded: ${totalForwarded} | Errors: ${totalErrors} | Mem: ${memMB}MB`);
}

// ─── Start all servers ────────────────────────────────────────────────────────
async function start() {
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         Einsoft GPS — Professional TCP Bridge             ║');
  console.log('║         Servidor de Protocolos GPS Profesional            ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n🔗 Backend: ${EINSOFT_BACKEND}\n`);

  // GT06 server
  const gt06Server = createTCPServer('GT06', parseGT06);
  gt06Server.listen(PORTS.GT06, () => {
    console.log(`🟢 GT06  (Concox/JimiIoT)  → TCP port ${PORTS.GT06}`);
  });

  // H02 server
  const h02Server = createTCPServer('H02', parseH02);
  h02Server.listen(PORTS.H02, () => {
    console.log(`🟢 H02   (Huabao/Smart)    → TCP port ${PORTS.H02}`);
  });

  // TK103 server
  const tk103Server = createTCPServer('TK103', parseTK103);
  tk103Server.listen(PORTS.TK103, () => {
    console.log(`🟢 TK103 (Coban/GPS103)    → TCP port ${PORTS.TK103}`);
  });

  // HTTP relay
  const httpServer = createHTTPRelayServer();
  httpServer.listen(PORTS.HTTP, () => {
    console.log(`🟢 HTTP  (URL genérica)    → HTTP port ${PORTS.HTTP}`);
  });

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('📱 Para configurar tu Smart Tag CX-XTAG11:');
  console.log('   Envía SMS con: server123456 TU_IP_PUBLICA 5023');
  console.log('   (Reemplaza TU_IP_PUBLICA con tu IP — ver https://whatismyip.com)');
  console.log('─────────────────────────────────────────────────────────────\n');
  console.log('⏳ Esperando conexiones de dispositivos GPS...\n');

  // Print stats every 5 minutes
  setInterval(printStats, 5 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Cerrando servidores...');
    gt06Server.close();
    h02Server.close();
    tk103Server.close();
    httpServer.close();
    printStats();
    process.exit(0);
  });
}

start().catch(console.error);
