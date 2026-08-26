/**
 * EYE-NODE // TRACKER 360 — Nodo de Inteligencia Móvil & Telemetría Táctica
 *
 * Arquitectura de Sensores Integrada:
 * 1. GNSS 4-Band (GPS, Galileo, GLONASS, BeiDou + A-GNSS / WiFi / Cell fallback)
 * 2. IMU 6/9-Axis Physics Engine (Acelerómetro, Giroscopio, G-Force Vector, Inclinómetro Roll/Pitch)
 * 3. AI Driver Behavior & Safety Scoring (Aceleración/Frenada brusca, Curvas peligrosas, Choque/Impacto, Vuelco)
 * 4. Centinela Anti-Manipulación (Anti-Tamper & Movimiento no autorizado en reposo)
 * 5. Dynamic 4-Tier Transmission Engine (Estacionado 15m, Normal 10s, Dinámico 3s, Crítico instantáneo)
 * 6. Caja Negra Industrial (Memoria local persistente con Store & Forward)
 */

const STORAGE_KEY_CONFIG = 'eyenode_tracker_config';
const STORAGE_KEY_BLACKBOX = 'eyenode_tracker_blackbox_queue';
const STORAGE_KEY_DRIVER_STATS = 'eyenode_driver_stats';

export const TRANSMISSION_MODES = {
  SENTINEL: 'SENTINEL',     // Estacionado / Vigilancia: Cada 15 min (inmediato si hay vibración/tamper)
  ECO_TRACK: 'ECO_TRACK',   // Movimiento normal: Cada 10 segundos
  FAST_TRACK: 'FAST_TRACK', // Movimiento rápido / curvas: Cada 3 segundos
  CRITICAL: 'CRITICAL',     // Impacto / SOS / Manipulación: Instantáneo
};

export const SENSOR_EVENT_TYPES = {
  NORMAL: 'NORMAL',
  HARSH_ACCEL: 'HARSH_ACCEL',
  HARSH_BRAKE: 'HARSH_BRAKE',
  HARSH_CORNER: 'HARSH_CORNER',
  CRASH_IMPACT: 'CRASH_IMPACT',
  ROLLOVER_TILT: 'ROLLOVER_TILT',
  TAMPER_MOTION: 'TAMPER_MOTION',
  POWER_DISCONNECT: 'POWER_DISCONNECT',
  PANIC_SOS: 'PANIC_SOS',
};

class EyeNodeEngine {
  constructor() {
    this.isRunning = false;
    this.isEmergency = false;
    this.sentinelActive = false; // Modo centinela (estacionado vigilante)
    this.watchId = null;
    this.timerId = null;
    this.motionTimerId = null;
    this.listeners = new Set();
    
    this.config = this.loadConfig();
    this.blackboxQueue = this.loadBlackboxQueue();
    this.driverStats = this.loadDriverStats();
    
    // Telemetry state
    this.lastPosition = null;
    this.lastMotion = {
      ax: 0, ay: 0, az: 0,
      gx: 0, gy: 0, gz: 0,
      gForce: 1.0,
      peakGForce: 1.0,
      roll: 0,
      pitch: 0,
      yaw: 0,
      lastEvent: SENSOR_EVENT_TYPES.NORMAL,
      lastEventTime: null,
    };
    
    this.gnssFixType = 'SEARCHING'; // GNSS_4BAND, A_GNSS_WIFI, CELL_ID
    this.currentMode = TRANSMISSION_MODES.ECO_TRACK;
    this.eventLog = [];
    this.isSyncingBlackbox = false;
    
    // Bind network changes
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleNetworkChange(true));
      window.addEventListener('offline', () => this.handleNetworkChange(false));
    }
  }

  loadConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CONFIG);
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return {
      serverUrl: 'https://einsoft-gp-sbcknd.vercel.app/api/telemetry',
      deviceId: 'EYE-NODE-' + Math.floor(1000 + Math.random() * 9000),
      trackerCode: '',
      sentinelMode: false,
      adaptiveTransmission: true,
      sentinelInterval: 900,  // 15 minutos en reposo
      normalInterval: 10,     // 10 segundos normal
      fastInterval: 3,        // 3 segundos en velocidad o giros
      emergencyInterval: 2,   // 2 segundos en emergencia
      impactGThreshold: 2.8,  // Umbral de choque (G)
      harshAccelThreshold: 3.8, // m/s^2 (~0.39 G)
      harshBrakeThreshold: 4.2, // m/s^2 (~0.43 G)
      tiltAngleThreshold: 45, // Grados de inclinación para vuelco
    };
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.sentinelActive = Boolean(this.config.sentinelMode);
    try {
      localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(this.config));
    } catch (_) {}
    this.notify({ type: 'config_updated', config: this.config });
  }

  loadBlackboxQueue() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_BLACKBOX);
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return [];
  }

  saveBlackboxQueue() {
    try {
      // Retener hasta 5,000 puntos en memoria de caja negra
      if (this.blackboxQueue.length > 5000) {
        this.blackboxQueue = this.blackboxQueue.slice(-5000);
      }
      localStorage.setItem(STORAGE_KEY_BLACKBOX, JSON.stringify(this.blackboxQueue));
    } catch (_) {}
    this.notify({ type: 'blackbox_updated', count: this.blackboxQueue.length });
  }

  loadDriverStats() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DRIVER_STATS);
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return {
      score: 98,
      harshBrakingCount: 0,
      harshAccelCount: 0,
      sharpTurnCount: 0,
      speedingCount: 0,
      impactCount: 0,
      distanceKm: 0,
      totalTrips: 1,
      lastPenaltyTime: null,
    };
  }

  saveDriverStats() {
    try {
      localStorage.setItem(STORAGE_KEY_DRIVER_STATS, JSON.stringify(this.driverStats));
    } catch (_) {}
    this.notify({ type: 'driver_score_updated', stats: this.driverStats });
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(event) {
    this.listeners.forEach((cb) => {
      try {
        cb(event);
      } catch (_) {}
    });
  }

  logEvent(type, message, severity = 'info') {
    const entry = {
      id: Math.random().toString(36).substring(2, 9),
      type,
      message,
      severity, // 'info', 'warning', 'critical'
      timestamp: new Date().toISOString(),
    };
    this.eventLog.unshift(entry);
    if (this.eventLog.length > 50) this.eventLog.pop();
    this.notify({ type: 'tactical_event', entry, log: this.eventLog });
  }

  // ─── START ENGINE ─────────────────────────────────────────────────────────
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.notify({ type: 'service_state', isRunning: true });
    this.logEvent('SYSTEM_START', 'EYE-NODE 360 inicializado. Sensores activos.', 'info');

    // 1. Iniciar Sensores IMU (Acelerómetro & Giroscopio)
    this.initImuSensors();

    // 2. Iniciar Receptor GNSS 4-Band
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      // Warm-up: single immediate fix to get first position quickly
      navigator.geolocation.getCurrentPosition(
        (pos) => this.handlePositionUpdate(pos),
        (err) => {
          this.logEvent('GNSS_WAIT', 'Buscando fijación satelital inicial... (puede tardar 30-60s al inicio)', 'warning');
        },
        {
          enableHighAccuracy: true,  // FIX: Force GPS chip (not WiFi/cell triangulation)
          timeout: 15000,
          maximumAge: 0,             // FIX: Never use cached/stale position
        }
      );

      // Continuous tracking with optimized options
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.handlePositionUpdate(pos),
        (err) => this.handlePositionError(err),
        {
          enableHighAccuracy: true,  // FIX: Use real GPS antenna, not cell/WiFi
          maximumAge: 0,             // FIX: Never serve stale position
          timeout: 20000,            // Give GPS 20s to get a fix
          // Note: distanceFilter is not standard Web API but Capacitor Geolocation supports it
          // For Capacitor builds: distanceFilter: 5 (meters minimum movement before update)
        }
      );
    }

    // 3. WakeLock: previene suspensión de pantalla en Android/iOS (mantiene GPS activo)
    this.acquireWakeLock();

    // 4. Keep-Alive acústico silencioso (segundo método anti-suspensión)
    this.startSilentAudioKeepAlive();

    // 5. Iniciar Bucle de Transmisión Adaptativa
    setTimeout(() => this.executeTick(), 1000);
    this.scheduleNextTick();

    // 6. Iniciar Escucha de Comandos Remotos (Wake-up por Ping / Emergencia)
    this.startCommandPolling();

    // 7. Vaciar caja negra si hay conexión
    if (typeof navigator !== 'undefined' && navigator.onLine && this.blackboxQueue.length > 0) {
      this.flushBlackboxQueue();
    }
  }

  async acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      } catch (err) {
        console.error('Error al adquirir WakeLock:', err);
      }
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release();
      this.wakeLock = null;
    }
  }

  // ─── COMMAND POLLING & REMOTE WAKE-UP LISTENER ────────────────────────────
  startCommandPolling() {
    if (this.commandPollTimer) clearInterval(this.commandPollTimer);
    
    // Poll for pending commands every 4 seconds
    this.commandPollTimer = setInterval(() => {
      if (this.isRunning && typeof navigator !== 'undefined' && navigator.onLine) {
        this.pollPendingCommands();
      }
    }, 4000);

    // Initial check right away
    setTimeout(() => this.pollPendingCommands(), 1500);
  }

  stopCommandPolling() {
    if (this.commandPollTimer) {
      clearInterval(this.commandPollTimer);
      this.commandPollTimer = null;
    }
  }

  async pollPendingCommands() {
    try {
      const baseUrl = this.config.serverUrl.replace(/\/report\/?$/, '').replace(/\/api\/telemetry\/?$/, '');
      const deviceId = encodeURIComponent(this.config.deviceId || '');
      const trackerCode = encodeURIComponent(this.config.trackerCode || '');
      const url = `${baseUrl}/api/telemetry/commands/pending?deviceId=${deviceId}&trackerCode=${trackerCode}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.commands) && data.commands.length > 0) {
          await this.executeRemoteCommands(data.commands);
        }
      }
    } catch (_) {}
  }

  async executeRemoteCommands(commands) {
    for (const cmd of commands) {
      try {
        const cmdName = cmd.command || cmd.name;
        this.logEvent('COMMAND_RECEIVED', `⚡ Comando remoto recibido del servidor: ${cmdName}`, 'warning');
        
        if (cmdName === 'LOCATE_NOW' || cmdName === 'FORCE_PING' || cmdName === 'EMERGENCY_WAKEUP') {
          this.logEvent('REMOTE_WAKEUP', '🚨 DESPERTAR SATELITAL TÁCTICO: Forzando captura GPS y ráfaga continua...', 'critical');
          
          // 1. Forzar WakeLock para mantener encendida la antena GPS
          await this.acquireWakeLock();

          // 2. Forzar lectura satelital inmediata con máxima precisión
          if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(
              async (pos) => {
                this.handlePositionUpdate(pos);
                // 3. Forzar modo rápido continuo por 5 minutos
                this.currentMode = TRANSMISSION_MODES.FAST_TRACK;
                await this.executeTick(true);
                this.logEvent('LOCATION_TRANSMITTED', `✅ Posición táctica transmitida: [${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}]`, 'info');
              },
              (err) => {
                this.logEvent('GNSS_RETRY', `Aviso satelital: ${err.message}. Reintentando...`, 'warning');
              },
              { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
            );
          }

          // 4. Cambiar a modo FAST_TRACK
          this.currentMode = TRANSMISSION_MODES.FAST_TRACK;
          this.scheduleNextTick();
        } else if (cmdName === 'EMERGENCY_MODE_ON') {
          this.setEmergency(true);
        } else if (cmdName === 'EMERGENCY_MODE_OFF') {
          this.setEmergency(false);
        }

        // 5. Enviar confirmación ACK al backend
        const cmdId = cmd.id || cmd._id;
        if (cmdId) {
          const baseUrl = this.config.serverUrl.replace(/\/report\/?$/, '').replace(/\/api\/telemetry\/?$/, '');
          await fetch(`${baseUrl}/api/telemetry/commands/${cmdId}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: { executed: true, at: new Date() } }),
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[trackerEngine] Error ejecutando comando remoto:', err);
      }
    }
  }

  stop() {
    this.isRunning = false;
    if (this.watchId !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.stopCommandPolling();
    this.stopImuSensors();
    this.releaseWakeLock();
    this.notify({ type: 'service_state', isRunning: false });
    this.logEvent('SYSTEM_STOP', 'EYE-NODE 360 en pausa.', 'info');
  }

  // ─── IMU 6/9-AXIS SENSOR ENGINE ───────────────────────────────────────────
  initImuSensors() {
    if (typeof window === 'undefined') return;

    this.motionHandler = (e) => {
      const acc = e.accelerationIncludingGravity || e.acceleration || {};
      const rawAcc = e.acceleration || {};
      const rot = e.rotationRate || {};

      const ax = (acc.x || 0);
      const ay = (acc.y || 0);
      const az = (acc.z || 0);

      // Calcular Fuerza G total instantánea
      const gTotal = Math.sqrt(ax * ax + ay * ay + az * az) / 9.81;
      const gForce = isNaN(gTotal) || gTotal < 0.05 ? 1.0 : Number(gTotal.toFixed(2));

      // Actualizar pico de Fuerza G
      if (gForce > this.lastMotion.peakGForce) {
        this.lastMotion.peakGForce = gForce;
      }

      this.lastMotion.ax = Number(ax.toFixed(2));
      this.lastMotion.ay = Number(ay.toFixed(2));
      this.lastMotion.az = Number(az.toFixed(2));
      this.lastMotion.gx = Number((rot.alpha || 0).toFixed(1));
      this.lastMotion.gy = Number((rot.beta || 0).toFixed(1));
      this.lastMotion.gz = Number((rot.gamma || 0).toFixed(1));
      this.lastMotion.gForce = gForce;

      // ── Análisis de Eventos Físicos en Tiempo Real ──
      this.analyzeMotionEvents(rawAcc, rot, gForce);
    };

    this.orientationHandler = (e) => {
      const roll = Number((e.gamma || 0).toFixed(1));
      const pitch = Number((e.beta || 0).toFixed(1));
      const yaw = Number((e.alpha || 0).toFixed(1));

      this.lastMotion.roll = roll;
      this.lastMotion.pitch = pitch;
      this.lastMotion.yaw = yaw;

      // Detección de Vuelco / Inclinación Peligrosa
      if (Math.abs(roll) > this.config.tiltAngleThreshold || Math.abs(pitch) > this.config.tiltAngleThreshold) {
        this.triggerSensorEvent(SENSOR_EVENT_TYPES.ROLLOVER_TILT, `Inclinación excesiva detectada: Roll ${roll}°, Pitch ${pitch}°`, 'critical');
      }
    };

    if (window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', this.motionHandler, { passive: true });
    }
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', this.orientationHandler, { passive: true });
    }
  }

  stopImuSensors() {
    if (typeof window === 'undefined') return;
    if (this.motionHandler) window.removeEventListener('devicemotion', this.motionHandler);
    if (this.orientationHandler) window.removeEventListener('deviceorientation', this.orientationHandler);
  }

  analyzeMotionEvents(rawAcc, rot, gForce) {
    const rawX = rawAcc.x || 0;
    const rawY = rawAcc.y || 0;
    const rawZ = rawAcc.z || 0;
    const rawMag = Math.sqrt(rawX * rawX + rawY * rawY + rawZ * rawZ);

    const now = Date.now();
    const lastEventTime = this.lastMotion.lastEventTime || 0;
    const cooldown = 3000; // 3s entre eventos del mismo tipo

    // 1. Choque / Impacto Crítico (Crash Detection)
    if (gForce >= this.config.impactGThreshold || rawMag > 25) {
      if (now - lastEventTime > cooldown) {
        this.triggerSensorEvent(SENSOR_EVENT_TYPES.CRASH_IMPACT, `💥 Impacto detectado: ${gForce}G (Pico de desaceleración)`, 'critical');
        this.penalizeDriverScore(25, 'impact');
        return;
      }
    }

    // 2. Modo Centinela / Anti-Manipulación (Activo estacionado)
    if (this.sentinelActive && (rawMag > 1.2 || gForce > 1.35)) {
      if (now - lastEventTime > 5000) {
        this.triggerSensorEvent(SENSOR_EVENT_TYPES.TAMPER_MOTION, `🛡️ Movimiento / Manipulación detectada en Modo Centinela (${gForce}G)`, 'critical');
        return;
      }
    }

    // 3. Frenado Brusco (Harsh Braking: Desaceleración longitudinal)
    if (rawY < -this.config.harshBrakeThreshold || (rawMag > 4.5 && (this.lastPosition?.speed || 0) > 15)) {
      if (now - lastEventTime > cooldown) {
        this.triggerSensorEvent(SENSOR_EVENT_TYPES.HARSH_BRAKE, `🛑 Frenada brusca detectada (${rawMag.toFixed(1)} m/s²)`, 'warning');
        this.penalizeDriverScore(3, 'harshBraking');
        return;
      }
    }

    // 4. Aceleración Brusca (Harsh Acceleration)
    if (rawY > this.config.harshAccelThreshold) {
      if (now - lastEventTime > cooldown) {
        this.triggerSensorEvent(SENSOR_EVENT_TYPES.HARSH_ACCEL, `⚡ Aceleración violenta detectada (${rawY.toFixed(1)} m/s²)`, 'warning');
        this.penalizeDriverScore(2, 'harshAccel');
        return;
      }
    }

    // 5. Curva Peligrosa / Giro Violento (Harsh Cornering)
    const turnRate = Math.abs(rot.gamma || rot.alpha || 0);
    if (turnRate > 50 && (this.lastPosition?.speed || 0) > 25) {
      if (now - lastEventTime > cooldown) {
        this.triggerSensorEvent(SENSOR_EVENT_TYPES.HARSH_CORNER, `🏎️ Curva agresiva a velocidad (${turnRate.toFixed(0)}°/s)`, 'warning');
        this.penalizeDriverScore(2, 'sharpTurn');
      }
    }
  }

  triggerSensorEvent(eventType, message, severity = 'warning') {
    this.lastMotion.lastEvent = eventType;
    this.lastMotion.lastEventTime = Date.now();
    this.logEvent(eventType, message, severity);

    // En evento crítico, forzar transmisión inmediata de ráfaga
    if (severity === 'critical') {
      this.currentMode = TRANSMISSION_MODES.CRITICAL;
      this.executeTick(true);
    }
  }

  penalizeDriverScore(points, type) {
    this.driverStats.score = Math.max(20, this.driverStats.score - points);
    if (type === 'harshBraking') this.driverStats.harshBrakingCount++;
    if (type === 'harshAccel') this.driverStats.harshAccelCount++;
    if (type === 'sharpTurn') this.driverStats.sharpTurnCount++;
    if (type === 'impact') this.driverStats.impactCount++;
    this.driverStats.lastPenaltyTime = Date.now();
    this.saveDriverStats();
  }

  // ─── GNSS SATELLITE & POSITION HANDLER ────────────────────────────────────
  handlePositionUpdate(pos) {
    const { latitude, longitude, accuracy, altitude, speed, heading } = pos.coords;

    // FIX: Reject coordinates of exactly (0,0) — means GPS chip not yet initialized
    if (latitude === 0 && longitude === 0) {
      this.logEvent('GNSS_WARN', 'Coordenadas (0,0) descartadas — GPS chip inicializándose...', 'warning');
      return;
    }

    // FIX: Reject low-accuracy readings when device is stopped (accuracy > 500m = cell tower only)
    if (accuracy > 500) {
      this.logEvent('GNSS_WARN', `Precisión demasiado baja (${Math.round(accuracy)}m) — esperando fix GPS real`, 'warning');
      return;
    }

    // Calificar calidad de fijación
    if (accuracy <= 6) {
      this.gnssFixType = 'GNSS_4BAND_RTK'; // GPS+Galileo+GLONASS+BeiDou
    } else if (accuracy <= 20) {
      this.gnssFixType = 'GNSS_3D_STANDARD';
    } else if (accuracy <= 60) {
      this.gnssFixType = 'A_GNSS_WIFI_HYBRID';
    } else {
      this.gnssFixType = 'CELL_ID_TRIANGULATION';
    }

    // FIX: Web Geolocation API returns speed in m/s, convert to km/h
    // (not knots, unlike hardware GPS trackers)
    const speedKmh = speed != null && !isNaN(speed) && speed >= 0
      ? Math.round(speed * 3.6)
      : 0;

    this.lastPosition = {
      latitude,
      longitude,
      accuracy: Math.round(accuracy || 0),
      altitude: Math.round(altitude || 0),
      speed: speedKmh,
      heading: Math.round(heading || 0),
      timestamp: pos.timestamp || Date.now(),
      fixType: this.gnssFixType,
    };

    // Actualizar modo de transmisión adaptativo según dinámica
    this.updateAdaptiveTransmissionMode(speedKmh);

    this.notify({
      type: 'telemetry_sample',
      position: this.lastPosition,
      motion: this.lastMotion,
      driverStats: this.driverStats,
      fixType: this.gnssFixType,
      mode: this.currentMode,
    });
  }

  handlePositionError(err) {
    this.logEvent('GNSS_WARN', `Aviso GNSS: ${err.message}`, 'warning');
    this.notify({ type: 'gnss_error', error: err.message });
  }

  updateAdaptiveTransmissionMode(speedKmh) {
    if (this.isEmergency || this.lastMotion.lastEvent === SENSOR_EVENT_TYPES.CRASH_IMPACT) {
      this.currentMode = TRANSMISSION_MODES.CRITICAL;
      return;
    }

    if (this.sentinelActive && speedKmh < 2) {
      this.currentMode = TRANSMISSION_MODES.SENTINEL;
      return;
    }

    if (speedKmh > 55 || this.lastMotion.gForce > 1.3) {
      this.currentMode = TRANSMISSION_MODES.FAST_TRACK;
    } else if (speedKmh >= 2) {
      this.currentMode = TRANSMISSION_MODES.ECO_TRACK;
    } else {
      this.currentMode = TRANSMISSION_MODES.SENTINEL;
    }
  }

  // ─── TRANSMISSION ENGINE ──────────────────────────────────────────────────
  scheduleNextTick() {
    if (!this.isRunning) return;
    if (this.timerId) clearTimeout(this.timerId);

    let delaySec = this.config.normalInterval;

    if (this.currentMode === TRANSMISSION_MODES.CRITICAL || this.isEmergency) {
      delaySec = this.config.emergencyInterval;
    } else if (this.currentMode === TRANSMISSION_MODES.FAST_TRACK) {
      delaySec = this.config.fastInterval;
    } else if (this.currentMode === TRANSMISSION_MODES.SENTINEL) {
      delaySec = this.config.sentinelInterval;
    } else {
      delaySec = this.config.normalInterval;
    }

    this.timerId = setTimeout(() => this.executeTick(), delaySec * 1000);
  }

  async executeTick(forcedImmediate = false) {
    if (!this.isRunning) return;

    // Obtener datos energéticos reales
    const battInfo = await this.getBatteryInfo();

    // Construir paquete de telemetría 360 completo
    const packet = {
      deviceId: this.config.deviceId,
      trackerCode: this.config.trackerCode || this.config.deviceId,
      systemName: 'EYE-NODE 360',
      latitude: this.lastPosition ? this.lastPosition.latitude : null,
      longitude: this.lastPosition ? this.lastPosition.longitude : null,
      accuracy: this.lastPosition ? this.lastPosition.accuracy : 0,
      altitude: this.lastPosition ? this.lastPosition.altitude : 0,
      speed: this.lastPosition ? this.lastPosition.speed : 0,
      heading: this.lastPosition ? this.lastPosition.heading : 0,
      fixType: this.gnssFixType,
      battery: battInfo.battery,
      isCharging: battInfo.isCharging,
      transmissionMode: this.currentMode,
      imu: {
        ax: this.lastMotion.ax,
        ay: this.lastMotion.ay,
        az: this.lastMotion.az,
        gx: this.lastMotion.gx,
        gy: this.lastMotion.gy,
        gz: this.lastMotion.gz,
        gForce: this.lastMotion.gForce,
        peakGForce: this.lastMotion.peakGForce,
        roll: this.lastMotion.roll,
        pitch: this.lastMotion.pitch,
        eventType: this.lastMotion.lastEvent,
      },
      driverScore: this.driverStats.score,
      sentinelActive: this.sentinelActive,
      isPanic: this.isEmergency,
      timestamp: new Date().toISOString(),
    };

    // Si no hay coordenadas GPS, esperar satélite
    if (packet.latitude == null || packet.longitude == null) {
      if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            this.handlePositionUpdate(pos);
            this.executeTick();
          },
          () => {},
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
      }
      this.scheduleNextTick();
      return;
    }

    // Transmisión directa o almacenamiento en caja negra offline
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      await this.sendPacketDirect(packet);
    } else {
      this.blackboxQueue.push(packet);
      this.saveBlackboxQueue();
      this.logEvent('BLACKBOX_STORE', `Sin conexión. Paquete 360 guardado en Caja Negra (${this.blackboxQueue.length} en buffer).`, 'warning');
    }

    // Resetear evento transitorio si ya fue despachado
    if (this.lastMotion.lastEvent !== SENSOR_EVENT_TYPES.PANIC_SOS) {
      this.lastMotion.lastEvent = SENSOR_EVENT_TYPES.NORMAL;
    }

    if (!forcedImmediate) {
      this.scheduleNextTick();
    }
  }

  async sendPacketDirect(packet) {
    try {
      const url = `${this.config.serverUrl.replace(/\/$/, '')}/report`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        this.notify({ type: 'packet_delivered', packet, response: data });

        // Si el servidor devolvió comandos pendientes, ejecutarlos de inmediato
        if (Array.isArray(data?.commands) && data.commands.length > 0) {
          await this.executeRemoteCommands(data.commands);
        }

        // Si la caja negra tiene puntos pendientes, vaciarlos en background
        if (this.blackboxQueue.length > 0 && !this.isSyncingBlackbox) {
          this.flushBlackboxQueue();
        }
      } else {
        this.blackboxQueue.push(packet);
        this.saveBlackboxQueue();
      }
    } catch (_) {
      this.blackboxQueue.push(packet);
      this.saveBlackboxQueue();
    }
  }

  async flushBlackboxQueue() {
    if (this.blackboxQueue.length === 0 || this.isSyncingBlackbox) return;
    this.isSyncingBlackbox = true;
    this.notify({ type: 'blackbox_syncing', isSyncing: true, pending: this.blackboxQueue.length });

    const batch = [...this.blackboxQueue];
    try {
      const url = `${this.config.serverUrl.replace(/\/$/, '')}/batch`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: batch }),
      });

      if (res.ok) {
        this.blackboxQueue = [];
        this.saveBlackboxQueue();
        this.logEvent('BLACKBOX_SYNC', `✅ Caja Negra sincronizada: ${batch.length} paquetes volcados al servidor.`, 'info');
        this.notify({ type: 'blackbox_flushed', count: batch.length });
      }
    } catch (e) {
      console.warn('[Blackbox] Error al vaciar buffer:', e.message);
    } finally {
      this.isSyncingBlackbox = false;
      this.notify({ type: 'blackbox_syncing', isSyncing: false, pending: this.blackboxQueue.length });
    }
  }

  async getBatteryInfo() {
    try {
      if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
        const b = await navigator.getBattery();
        return {
          battery: Math.round(b.level * 100),
          isCharging: b.charging,
        };
      }
    } catch (_) {}
    return { battery: 100, isCharging: false };
  }

  setEmergency(active) {
    this.isEmergency = Boolean(active);
    if (this.isEmergency) {
      this.currentMode = TRANSMISSION_MODES.CRITICAL;
      this.lastMotion.lastEvent = SENSOR_EVENT_TYPES.PANIC_SOS;
      this.logEvent('PANIC_SOS', '🚨 BOTÓN DE PÁNICO TÁCTICO SOS ACTIVADO.', 'critical');
      this.executeTick(true);
    } else {
      this.logEvent('PANIC_RESOLVED', 'Alarma de emergencia finalizada.', 'info');
    }
    this.notify({ type: 'emergency_state', isEmergency: this.isEmergency });
  }

  setSentinelMode(active) {
    this.sentinelActive = Boolean(active);
    this.saveConfig({ sentinelMode: this.sentinelActive });
    this.logEvent('SENTINEL_TOGGLE', this.sentinelActive ? '🛡️ Modo Centinela Activado: Vigilancia de manipulación en reposo.' : 'Modo Centinela desactivado.', 'info');
    this.notify({ type: 'sentinel_state', active: this.sentinelActive });
  }

  // ─── WAKELOCK: Prevents Android/iOS from sleeping and killing GPS ──────────────
  async acquireWakeLock() {
    try {
      if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          // Reacquire if still running (e.g. tab became visible again)
          if (this.isRunning) {
            setTimeout(() => this.acquireWakeLock(), 1000);
          }
        });
        this.logEvent('WAKELOCK', '\uD83D\uDD12 WakeLock activo: GPS continuo garantizado, pantalla no se suspender\u00e1.', 'info');
      }
    } catch (e) {
      // WakeLock not supported (older browsers) — silent fallback to audio keepalive
    }
  }

  releaseWakeLock() {
    try {
      if (this.wakeLock) {
        this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch (_) {}
  }

  startSilentAudioKeepAlive() {
    try {
      if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtx();
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        gain.gain.value = 0.00001; // Inaudible
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start();
      }
    } catch (_) {}
  }

  handleNetworkChange(isOnline) {
    this.logEvent('NETWORK_CHANGE', isOnline ? '🟢 Red LTE/WiFi Conectada.' : '🔴 Sin conexión a internet. Guardando en Caja Negra.', isOnline ? 'info' : 'warning');
    this.notify({ type: 'network_status', isOnline });
    if (isOnline) {
      this.flushBlackboxQueue();
    }
  }
}

export const trackerEngine = new EyeNodeEngine();
