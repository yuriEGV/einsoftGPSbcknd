import React, { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { trackerEngine, TRANSMISSION_MODES, SENSOR_EVENT_TYPES } from './services/trackerEngine'
import UpdateNotificationModal from './components/UpdateNotificationModal'

// Map flyTo helper
function MapUpdater({ center }) {
  const map = useMap()
  useEffect(() => {
    if (center && center[0] && center[1]) {
      map.flyTo(center, 16, { duration: 1 })
    }
  }, [center, map])
  return null
}

const tacticalIcon = L.divIcon({
  html: `
    <div class="relative flex items-center justify-center">
      <div class="absolute w-10 h-10 rounded-full bg-cyan-500/30 animate-ping"></div>
      <div class="w-8 h-8 rounded-full bg-slate-950 border-2 border-cyan-400 flex items-center justify-center text-white text-xs font-black shadow-[0_0_15px_rgba(6,182,212,0.6)]">
        🛰️
      </div>
    </div>
  `,
  className: '',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -20],
})

export default function App() {
  const [isRunning, setIsRunning] = useState(false)
  const [isEmergency, setIsEmergency] = useState(false)
  const [sentinelActive, setSentinelActive] = useState(false)
  const [telemetry, setTelemetry] = useState(null)
  const [motion, setMotion] = useState(trackerEngine.lastMotion)
  const [driverStats, setDriverStats] = useState(trackerEngine.driverStats)
  const [eventLog, setEventLog] = useState([])
  const [blackboxCount, setBlackboxCount] = useState(0)
  const [isSyncingBlackbox, setIsSyncingBlackbox] = useState(false)
  const [packetsDelivered, setPacketsDelivered] = useState(0)
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [lastDeliveredTime, setLastDeliveredTime] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [activeTab, setActiveTab] = useState('sensors') // 'sensors', 'map', 'events'

  // Config State
  const [config, setConfig] = useState(trackerEngine.config)

  // Panic Countdown
  const [panicCountdown, setPanicCountdown] = useState(null)
  const countdownTimer = useRef(null)

  useEffect(() => {
    // Start Engine on mount
    trackerEngine.start()
    setIsRunning(true)
    setBlackboxCount(trackerEngine.blackboxQueue.length)
    setSentinelActive(trackerEngine.sentinelActive)

    const unsubscribe = trackerEngine.subscribe((event) => {
      if (event.type === 'service_state') {
        setIsRunning(event.isRunning)
      } else if (event.type === 'telemetry_sample') {
        setTelemetry(event.position)
        setMotion(event.motion)
        setDriverStats(event.driverStats)
      } else if (event.type === 'tactical_event') {
        setEventLog([...event.log])
      } else if (event.type === 'packet_delivered') {
        setPacketsDelivered((p) => p + 1)
        setLastDeliveredTime(new Date())
        setBlackboxCount(trackerEngine.blackboxQueue.length)
      } else if (event.type === 'blackbox_updated') {
        setBlackboxCount(event.count)
      } else if (event.type === 'blackbox_syncing') {
        setIsSyncingBlackbox(event.isSyncing)
      } else if (event.type === 'blackbox_flushed') {
        setBlackboxCount(0)
        setLastDeliveredTime(new Date())
      } else if (event.type === 'network_status') {
        setIsOnline(event.isOnline)
      } else if (event.type === 'emergency_state') {
        setIsEmergency(event.isEmergency)
      } else if (event.type === 'sentinel_state') {
        setSentinelActive(event.active)
      } else if (event.type === 'driver_score_updated') {
        setDriverStats({ ...event.stats })
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleToggleService = () => {
    if (isRunning) {
      trackerEngine.stop()
    } else {
      trackerEngine.start()
    }
  }

  const handleToggleSentinel = () => {
    const nextState = !sentinelActive
    trackerEngine.setSentinelMode(nextState)
  }

  // Panic Handlers
  const initiatePanic = () => {
    if (window.navigator?.vibrate) {
      window.navigator.vibrate([200, 100, 200, 100, 400])
    }
    setPanicCountdown(4)
  }

  useEffect(() => {
    if (panicCountdown === null) return
    if (panicCountdown > 0) {
      countdownTimer.current = setTimeout(() => {
        setPanicCountdown(panicCountdown - 1)
      }, 1000)
    } else if (panicCountdown === 0) {
      trackerEngine.setEmergency(true)
      setPanicCountdown(null)
    }
    return () => clearTimeout(countdownTimer.current)
  }, [panicCountdown])

  const handleSaveConfig = (e) => {
    e.preventDefault()
    trackerEngine.saveConfig(config)
    setShowSettings(false)
  }

  // Calculate Driver Score Color
  const score = driverStats?.score ?? 98
  const scoreColor = score >= 90 ? 'text-emerald-400' : score >= 75 ? 'text-amber-400' : 'text-red-400'
  const scoreBadgeBg = score >= 90 ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300' : score >= 75 ? 'bg-amber-950/60 border-amber-500/40 text-amber-300' : 'bg-red-950/60 border-red-500/40 text-red-300'

  // Presets
  const PRESET_PEOPLE = [
    { label: 'yuri', code: 'PER-139F17', id: '866140042278017' },
    { label: 'manuel', code: 'PER-MANUEL1', id: 'MOVIL-3550' },
    { label: 'gloria', code: 'PER-FC9B50', id: 'PER-FC9B50' },
    { label: 'sarem', code: 'PER-FAEFB9', id: '350673971668546' },
    { label: 'veronica', code: 'PER-5CA27E', id: 'PER-5CA27E' },
  ]

  // Default map center dynamically set to current telemetry position, fallback to Playa Ancha
  const mapCenter = telemetry?.latitude && telemetry?.longitude
    ? [telemetry.latitude, telemetry.longitude]
    : [-33.02957, -71.63435]

  return (
    <div className="min-h-screen bg-[#050811] text-slate-100 font-sans flex flex-col justify-between selection:bg-cyan-500 selection:text-black">
      {/* ── Top Tactical HUD Header ── */}
      <header className="bg-slate-950/90 border-b border-cyan-950/80 px-4 py-3 sticky top-0 z-40 backdrop-blur-md flex items-center justify-between shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-900 border border-cyan-400/40 flex items-center justify-center text-xl shadow-[0_0_15px_rgba(6,182,212,0.4)]">
            🎯
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-sm font-black tracking-wider text-white">EYE-NODE</h1>
              <span className="text-[10px] font-mono px-1.5 py-0.2 bg-cyan-950 border border-cyan-500/50 text-cyan-300 rounded font-bold">
                TRACKER 360
              </span>
            </div>
            <p className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
              <span>ID:</span>
              <span className="text-cyan-400 font-bold">{config.trackerCode || config.deviceId}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode Badge */}
          <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
            sentinelActive
              ? 'bg-amber-950/70 border-amber-500/50 text-amber-300 animate-pulse'
              : trackerEngine.currentMode === TRANSMISSION_MODES.FAST_TRACK
              ? 'bg-purple-950/70 border-purple-500/50 text-purple-300'
              : 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300'
          }`}>
            {sentinelActive ? '🛡️ CENTINELA' : trackerEngine.currentMode === TRANSMISSION_MODES.FAST_TRACK ? '⚡ RÁFAGA 3S' : '🛰️ ACTIVO 360'}
          </span>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition"
            title="Ajustes Tácticos y Sensores"
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* ── Main Tactical Content ── */}
      <main className="p-4 flex-1 flex flex-col gap-4 max-w-lg mx-auto w-full">
        {/* 1. Dedicated Hardware/Beacon Identity Card */}
        <div className="bg-slate-950/90 border border-cyan-900/60 rounded-2xl p-3.5 shadow-xl space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
              NODO GPS PROFESIONAL DEDICADO
            </span>
            <span className="text-xs font-mono font-black text-cyan-300 bg-cyan-950/80 px-2.5 py-0.5 rounded-lg border border-cyan-500/40">
              {config.trackerCode || config.deviceId || 'MOVIL-AUTO'}
            </span>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-300 bg-slate-900/90 px-3 py-2 rounded-xl border border-slate-800">
            <div className="flex items-center gap-2">
              <span className="text-base">📡</span>
              <span>
                Enlace a EINSoft GPS:{' '}
                <b className="text-emerald-400 font-mono">
                  {isOnline ? 'TRANSMISIÓN EN VIVO ACTIVA' : 'MODO OFFLINE (CAJA NEGRA)'}
                </b>
              </span>
            </div>
            <span className="text-[10px] text-cyan-400 font-mono">
              {telemetry?.speed ? `${Math.round(telemetry.speed)} km/h` : '0 km/h'}
            </span>
          </div>
        </div>

        {/* 2. Primary Tactical Controls: Sentinel Mode & Service Switch */}
        <div className="grid grid-cols-2 gap-3">
          {/* Service Switch */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3 shadow-xl flex flex-col justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estado del Nodo</span>
            <div className="flex items-center justify-between pt-2">
              <span className={`text-xs font-black flex items-center gap-1.5 ${isRunning ? 'text-emerald-400' : 'text-slate-500'}`}>
                <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'}`}></span>
                {isRunning ? 'EN LÍNEA' : 'DETENIDO'}
              </span>
              <button
                onClick={handleToggleService}
                className={`px-3 py-1.5 rounded-xl font-black text-[11px] transition-all shadow-md active:scale-95 ${
                  isRunning
                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950'
                }`}
              >
                {isRunning ? '⏹️ Pausar' : '▶️ Iniciar'}
              </button>
            </div>
          </div>

          {/* Sentinel / Anti-Tamper Switch */}
          <div className={`border rounded-2xl p-3 shadow-xl flex flex-col justify-between transition-all ${
            sentinelActive
              ? 'bg-amber-950/40 border-amber-500/60 shadow-[0_0_15px_rgba(245,158,11,0.2)]'
              : 'bg-slate-950/80 border-slate-800'
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">🛡️ Centinela</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded ${sentinelActive ? 'bg-amber-500 text-black' : 'bg-slate-800 text-slate-400'}`}>
                {sentinelActive ? 'ARMADO' : 'DESARMADO'}
              </span>
            </div>
            <div className="pt-2 flex items-center justify-between">
              <p className="text-[10px] text-slate-400 leading-tight">Alerta de manipulación</p>
              <button
                onClick={handleToggleSentinel}
                className={`px-3 py-1.5 rounded-xl font-black text-[11px] transition-all shadow-md active:scale-95 ${
                  sentinelActive
                    ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 font-extrabold'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
                }`}
              >
                {sentinelActive ? '✓ Armado' : 'Armar'}
              </button>
            </div>
          </div>
        </div>

        {/* 3. Navigation Tabs */}
        <div className="flex bg-slate-950 border border-slate-800 rounded-xl p-1 text-xs">
          <button
            onClick={() => setActiveTab('sensors')}
            className={`flex-1 py-1.5 rounded-lg font-bold transition flex items-center justify-center gap-1.5 ${
              activeTab === 'sensors' ? 'bg-cyan-600 text-white shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🧭</span> Sensores 360
          </button>
          <button
            onClick={() => setActiveTab('map')}
            className={`flex-1 py-1.5 rounded-lg font-bold transition flex items-center justify-center gap-1.5 ${
              activeTab === 'map' ? 'bg-cyan-600 text-white shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🗺️</span> Mapa Táctico
          </button>
          <button
            onClick={() => setActiveTab('events')}
            className={`flex-1 py-1.5 rounded-lg font-bold transition flex items-center justify-center gap-1.5 ${
              activeTab === 'events' ? 'bg-cyan-600 text-white shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>📋</span> Bitácora ({eventLog.length})
          </button>
        </div>

        {/* ── TAB 1: SENSOR FUSION HUB ── */}
        {activeTab === 'sensors' && (
          <div className="space-y-3 animate-in fade-in duration-200">
            {/* AI Driver Score Card */}
            <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border border-cyan-900/40 rounded-2xl p-4 shadow-xl flex items-center justify-between">
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  🧠 AI Comportamiento del Conductor
                </span>
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-black ${scoreColor}`}>
                    {score}<span className="text-sm font-bold text-slate-500">/100</span>
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${scoreBadgeBg}`}>
                    {score >= 90 ? '✓ Excelente' : score >= 75 ? '⚠ Moderado' : '🚨 Riesgoso'}
                  </span>
                </div>
                <div className="flex gap-3 text-[10px] text-slate-400 font-mono pt-1">
                  <span>🛑 Frenadas: {driverStats?.harshBrakingCount ?? 0}</span>
                  <span>⚡ Acel: {driverStats?.harshAccelCount ?? 0}</span>
                  <span>🏎️ Giros: {driverStats?.sharpTurnCount ?? 0}</span>
                </div>
              </div>

              {/* G-Force Instant Gauge */}
              <div className="text-right border-l border-slate-800 pl-4">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Fuerza G</span>
                <span className={`text-2xl font-black font-mono ${
                  motion.gForce > 2.0 ? 'text-red-400 animate-pulse' : motion.gForce > 1.3 ? 'text-amber-400' : 'text-cyan-400'
                }`}>
                  {motion.gForce.toFixed(2)}G
                </span>
                <span className="text-[9px] text-slate-500 font-mono block">Pico: {motion.peakGForce.toFixed(2)}G</span>
              </div>
            </div>

            {/* 6-Sensors 360 Grid */}
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              {/* GNSS 4-Band */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow">
                <span className="text-lg block">🛰️</span>
                <span className="text-[9px] font-bold text-slate-400 uppercase block">GNSS 4-Band</span>
                <span className="font-extrabold text-cyan-400 text-xs mt-0.5 block">
                  {telemetry?.accuracy ? `±${telemetry.accuracy}m` : 'Fijando...'}
                </span>
                <span className="text-[9px] text-slate-500 font-mono">
                  {trackerEngine.gnssFixType === 'GNSS_4BAND_RTK' ? 'RTK High' : 'A-GNSS'}
                </span>
              </div>

              {/* Velocidad */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow">
                <span className="text-lg block">🏃</span>
                <span className="text-[9px] font-bold text-slate-400 uppercase block">Velocidad</span>
                <span className="font-extrabold text-white text-base mt-0.5 block font-mono">
                  {telemetry?.speed || 0}
                </span>
                <span className="text-[9px] text-slate-500 font-mono">km/h</span>
              </div>

              {/* Inclinómetro Roll/Pitch */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow">
                <span className="text-lg block">📐</span>
                <span className="text-[9px] font-bold text-slate-400 uppercase block">Inclinación</span>
                <span className="font-extrabold text-indigo-300 text-xs mt-0.5 block font-mono">
                  {motion.roll}° / {motion.pitch}°
                </span>
                <span className="text-[9px] text-slate-500 font-mono">Roll / Pitch</span>
              </div>

              {/* Energía / Batería */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow">
                <span className="text-lg block">🔋</span>
                <span className="text-[9px] font-bold text-slate-400 uppercase block">Energía</span>
                <span className="font-extrabold text-emerald-400 text-xs mt-0.5 block font-mono">
                  100%
                </span>
                <span className="text-[9px] text-slate-500 font-mono">En Línea</span>
              </div>

              {/* Caja Negra Offline */}
              <div className={`border rounded-2xl p-3 shadow ${
                blackboxCount > 0 ? 'bg-amber-950/30 border-amber-500/40 text-amber-300' : 'bg-slate-950 border-slate-800'
              }`}>
                <span className="text-lg block">📦</span>
                <span className="text-[9px] font-bold text-slate-400 uppercase block">Caja Negra</span>
                <span className="font-extrabold text-xs mt-0.5 block font-mono">
                  {blackboxCount} pts
                </span>
                <span className="text-[9px] text-slate-500 font-mono">
                  {isSyncingBlackbox ? 'Sincronizando...' : 'En Buffer'}
                </span>
              </div>

              {/* Enlace IoT 4G / WiFi */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow">
                <span className="text-lg block">📶</span>
                <span className="text-[9px] font-bold text-slate-400 uppercase block">Enlace IoT</span>
                <span className={`font-extrabold text-xs mt-0.5 block ${isOnline ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isOnline ? 'Conectado' : 'Offline'}
                </span>
                <span className="text-[9px] text-slate-500 font-mono">{packetsDelivered} envíos</span>
              </div>
            </div>

            {/* Coordinates & Heading Strip */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex items-center justify-between text-[11px] font-mono">
              <span className="text-slate-400">
                📍 {telemetry?.latitude ? `${telemetry.latitude.toFixed(5)}, ${telemetry.longitude.toFixed(5)}` : 'Buscando satélites GNSS...'}
              </span>
              <span className="text-cyan-400 font-bold">
                Alt: {telemetry?.altitude || 0}m | Rumbo: {telemetry?.heading || 0}°
              </span>
            </div>
          </div>
        )}

        {/* ── TAB 2: TACTICAL MAP ── */}
        {activeTab === 'map' && (
          <div className="h-64 rounded-2xl overflow-hidden border border-slate-800 shadow-2xl relative animate-in fade-in duration-200">
            <MapContainer
              center={mapCenter}
              zoom={15}
              className="h-full w-full"
            >
              <MapUpdater center={mapCenter} />
              <TileLayer
                attribution='&copy; OpenStreetMap'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Marker position={mapCenter} icon={tacticalIcon}>
                <Popup>
                  <div className="p-1 text-xs">
                    <p className="font-bold text-slate-900">🛰️ {config.trackerCode || config.deviceId}</p>
                    <p className="text-slate-600">Vel: {telemetry?.speed || 0} km/h</p>
                    <p className="text-slate-600 font-mono text-[10px]">G-Force: {motion.gForce}G</p>
                  </div>
                </Popup>
              </Marker>
            </MapContainer>
          </div>
        )}

        {/* ── TAB 3: TACTICAL EVENT LOG ── */}
        {activeTab === 'events' && (
          <div className="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow-xl space-y-2 max-h-72 overflow-y-auto animate-in fade-in duration-200 font-mono text-xs">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block border-b border-slate-900 pb-1">
              📋 Bitácora de Telemetría Táctica
            </span>
            {eventLog.length === 0 ? (
              <p className="text-slate-600 text-center py-4">Sin eventos registrados aún.</p>
            ) : (
              eventLog.map((ev) => (
                <div key={ev.id} className="flex items-start justify-between py-1 border-b border-slate-900/60 text-[11px]">
                  <div className="space-y-0.5">
                    <span className={`font-bold ${
                      ev.severity === 'critical' ? 'text-red-400' : ev.severity === 'warning' ? 'text-amber-400' : 'text-cyan-400'
                    }`}>
                      {ev.message}
                    </span>
                  </div>
                  <span className="text-[9px] text-slate-600">
                    {new Date(ev.timestamp).toLocaleTimeString('es-CL')}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── Panic Active Banner or Giant Button ── */}
        {panicCountdown !== null && (
          <div className="p-4 bg-red-600 rounded-2xl text-center space-y-2 animate-bounce shadow-2xl">
            <p className="text-sm font-black uppercase tracking-wider">
              🚨 TRANSMITIENDO PÁNICO EN {panicCountdown}s...
            </p>
            <button
              onClick={() => setPanicCountdown(null)}
              className="px-4 py-1.5 bg-black text-white rounded-xl text-xs font-bold"
            >
              Cancelar
            </button>
          </div>
        )}

        {isEmergency && (
          <div className="p-4 bg-gradient-to-r from-red-600 to-rose-700 border-2 border-white rounded-2xl flex items-center justify-between text-white shadow-2xl animate-pulse">
            <div>
              <p className="font-black text-xs uppercase tracking-wide">🚨 MODO PÁNICO SOS ACTIVO</p>
              <p className="text-[10px] text-red-100">Transmitiendo ráfagas continuas de auxilio.</p>
            </div>
            <button
              onClick={() => trackerEngine.setEmergency(false)}
              className="px-3 py-1.5 bg-black hover:bg-slate-900 text-red-300 font-bold rounded-xl text-xs"
            >
              ✓ Finalizar
            </button>
          </div>
        )}

        {panicCountdown === null && !isEmergency && (
          <div className="flex justify-center py-2">
            <button
              onClick={initiatePanic}
              className="w-36 h-36 rounded-full bg-gradient-to-br from-red-500 via-red-600 to-red-800 text-white font-black text-lg tracking-wider shadow-[0_0_40px_rgba(239,68,68,0.5)] active:scale-95 transition-all flex flex-col items-center justify-center border-4 border-red-400 hover:shadow-[0_0_60px_rgba(239,68,68,0.8)]"
            >
              <span className="text-3xl mb-0.5">🆘</span>
              <span>PÁNICO</span>
              <span className="text-[9px] font-normal opacity-80">Presiona en emergencia</span>
            </button>
          </div>
        )}
      </main>

      {/* ── Settings Drawer / Modal ── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-end sm:items-center justify-center p-4">
          <div className="bg-slate-950 border border-cyan-950 rounded-3xl p-6 w-full max-w-sm shadow-2xl space-y-4 animate-in fade-in slide-in-from-bottom-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-black text-white flex items-center gap-2">
                ⚙️ Configuración EYE-NODE 360
              </h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveConfig} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 font-bold mb-1 uppercase text-[10px]">
                  URL del Servidor API
                </label>
                <input
                  type="text"
                  value={config.serverUrl}
                  onChange={(e) => setConfig({ ...config, serverUrl: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white outline-none focus:border-cyan-500 font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-400 font-bold mb-1 uppercase text-[10px]">
                  Identificador del Dispositivo / Hardware
                </label>
                <input
                  type="text"
                  value={config.deviceId}
                  onChange={(e) => setConfig({ ...config, deviceId: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white outline-none focus:border-cyan-500 font-mono font-bold text-cyan-300"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-400 font-bold mb-1 uppercase text-[10px]">
                  Código de Rastreo Personal (Opcional)
                </label>
                <input
                  type="text"
                  value={config.trackerCode}
                  onChange={(e) => setConfig({ ...config, trackerCode: e.target.value })}
                  placeholder="Ej: PER-MANUEL1"
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  className="w-full py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-xl shadow-lg transition"
                >
                  💾 Guardar Ajustes Tácticos
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="p-3 text-center text-[10px] text-slate-600 border-t border-slate-950 font-mono">
        EYE-NODE 360 • Plataforma de Telemetría Táctica e Inteligencia Móvil
      </footer>
    </div>
  )
}
