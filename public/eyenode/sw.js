/**
 * EYE-NODE 360 — Service Worker
 * 
 * Ejecuta en segundo plano, incluso con la pantalla apagada.
 * Responsabilidades:
 *  1. Background Sync: Envía puntos GPS guardados en IndexedDB al servidor
 *  2. Periodic Background Sync: Wakeup cada ~5 minutos para geolocalizar
 *  3. Push Notifications: Recibe comandos remotos (LOCATE_NOW, EMERGENCY)
 *  4. Cache: Mantiene la app disponible offline
 */

const CACHE_NAME = 'eyenode-cache-v3';
const SYNC_TAG = 'gps-background-sync';
const PERIODIC_TAG = 'gps-periodic-sync';

const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Limpiar caches viejos
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      ),
    ])
  );
});

// ─── Fetch (Offline Cache) ────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Solo cachear GET requests
  if (event.request.method !== 'GET') return;
  
  // No interceptar API calls
  if (event.request.url.includes('/api/') || 
      event.request.url.includes('vercel.app') ||
      event.request.url.includes('mongodb')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});

// ─── Background Sync: Enviar puntos GPS pendientes ────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncPendingGPSPoints());
  }
});

// ─── Periodic Background Sync: Despertar cada 5 minutos ──────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === PERIODIC_TAG) {
    event.waitUntil(handlePeriodicSync());
  }
});

// ─── Push Notifications: Comandos remotos ────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {}

  const title = payload.title || '📡 EYE-NODE GPS';
  const body = payload.body || 'Señal recibida del servidor.';
  const data = payload.data || {};

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'eyenode-push',
      data,
      actions: [
        { action: 'locate', title: '📍 Localizar Ahora' },
        { action: 'dismiss', title: 'Ignorar' },
      ],
    })
  );

  // Si es un comando LOCATE_NOW, notificar a todos los clientes activos
  if (data.command === 'LOCATE_NOW' || data.command === 'EMERGENCY_WAKEUP') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'REMOTE_COMMAND', command: data.command, cmdId: data.cmdId });
        });
      })
    );
  }
});

// ─── Notification Click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.action === 'locate') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        if (clients.length > 0) {
          clients[0].focus();
          clients[0].postMessage({ type: 'REMOTE_COMMAND', command: 'LOCATE_NOW' });
        } else {
          self.clients.openWindow('/');
        }
      })
    );
  }
});

// ─── Mensaje desde la página principal ────────────────────────────────────────
self.addEventListener('message', (event) => {
  const { type, data } = event.data || {};

  if (type === 'REGISTER_PERIODIC_SYNC') {
    registerPeriodicSync();
  } else if (type === 'FORCE_SYNC') {
    syncPendingGPSPoints();
  } else if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── Helper: Sync GPS Points ──────────────────────────────────────────────────
async function syncPendingGPSPoints() {
  try {
    // Leer puntos pendientes desde IndexedDB
    const db = await openIndexedDB();
    const pending = await getUnsyncedPoints(db);
    
    if (!pending || pending.length === 0) return;

    // Leer config del servidor
    const configStr = await getMetaValue(db, 'serverUrl');
    const serverUrl = configStr || 'https://einsoft-gp-sbcknd.vercel.app/api/telemetry';
    const batchUrl = serverUrl.replace(/\/report\/?$/, '').replace(/\/api\/telemetry\/?$/, '') + '/api/telemetry/batch';

    // Enviar en lotes de 50
    const batchSize = 50;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      try {
        const res = await fetch(batchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: batch }),
        });
        if (res.ok) {
          await markPointsAsSynced(db, batch.map(p => p.localId));
        }
      } catch (_) {
        // Si falla el lote, continuar con el siguiente
        break;
      }
    }
  } catch (err) {
    console.error('[SW] Error syncing GPS points:', err);
  }
}

// ─── Helper: Periodic Sync ─────────────────────────────────────────────────────
async function handlePeriodicSync() {
  // Notificar a todos los clientes activos para que transmitan GPS
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  
  if (clients.length > 0) {
    clients.forEach(client => {
      client.postMessage({ type: 'PERIODIC_GPS_TICK' });
    });
  }
  
  // También intentar sincronizar puntos pendientes
  await syncPendingGPSPoints();
}

// ─── Helper: Registrar Periodic Sync ─────────────────────────────────────────
async function registerPeriodicSync() {
  try {
    if ('periodicSync' in self.registration) {
      await self.registration.periodicSync.register(PERIODIC_TAG, {
        minInterval: 5 * 60 * 1000, // 5 minutos mínimo
      });
    }
  } catch (_) {}
}

// ─── IndexedDB helpers en el Service Worker ──────────────────────────────────
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('eyenode_gps_buffer_v3', 1);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('gps_points')) {
        const s = idb.createObjectStore('gps_points', { keyPath: 'id', autoIncrement: true });
        s.createIndex('isSynced', 'isSynced', { unique: false });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!idb.objectStoreNames.contains('meta')) {
        idb.createObjectStore('meta', { keyPath: 'key' });
      }
    };
  });
}

function getUnsyncedPoints(db) {
  return new Promise((resolve) => {
    const tx = db.transaction('gps_points', 'readonly');
    const store = tx.objectStore('gps_points');
    const pending = [];
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (!cursor.value.isSynced || cursor.value.isSynced === 0) {
          pending.push({ ...cursor.value, id: cursor.key });
        }
        cursor.continue();
      } else {
        resolve(pending);
      }
    };
    req.onerror = () => resolve([]);
  });
}

function markPointsAsSynced(db, ids) {
  return new Promise((resolve) => {
    const tx = db.transaction('gps_points', 'readwrite');
    const store = tx.objectStore('gps_points');
    let n = ids.length;
    if (n === 0) return resolve();
    ids.forEach(id => {
      const r = store.get(id);
      r.onsuccess = () => {
        if (r.result) { r.result.isSynced = 1; store.put(r.result); }
        if (--n === 0) resolve();
      };
      r.onerror = () => { if (--n === 0) resolve(); };
    });
  });
}

function getMetaValue(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('meta', 'readonly');
      const r = tx.objectStore('meta').get(key);
      r.onsuccess = () => resolve(r.result?.value || null);
      r.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
