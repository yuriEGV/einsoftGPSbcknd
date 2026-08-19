/**
 * deviceState.js — Cálculo dinámico de estado de conexión en tiempo real
 *
 * Estados:
 *   🟢 ONLINE  : Reportó hace <= 30 segundos (enlace activo y fluido)
 *   🟡 STALE   : Reportó hace entre 31 segundos y 3 minutos (retraso/latencia)
 *   🔴 OFFLINE : No reporta hace más de 3 minutos (desconectado/apagado/sin cobertura)
 */

export function computeConnectionState(lastSeenDate) {
  if (!lastSeenDate) {
    return {
      status: 'offline',
      secondsAgo: Infinity,
      label: 'Sin conexión',
      badgeColor: 'bg-gray-100 text-gray-600',
      dotColor: '#ef4444',
      isLive: false,
    };
  }

  const lastSeenMs = new Date(lastSeenDate).getTime();
  const nowMs = Date.now();
  const diffSeconds = Math.max(0, Math.round((nowMs - lastSeenMs) / 1000));

  if (diffSeconds <= 30) {
    return {
      status: 'online',
      secondsAgo: diffSeconds,
      label: diffSeconds < 5 ? 'En vivo' : `Hace ${diffSeconds}s`,
      badgeColor: 'bg-emerald-100 text-emerald-800',
      dotColor: '#10b981',
      isLive: true,
    };
  }

  if (diffSeconds <= 180) {
    // Entre 30s y 3 minutos
    const mins = Math.floor(diffSeconds / 60);
    const secs = diffSeconds % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return {
      status: 'stale',
      secondsAgo: diffSeconds,
      label: `Sin actualización reciente (${timeStr})`,
      badgeColor: 'bg-amber-100 text-amber-800',
      dotColor: '#f59e0b',
      isLive: false,
    };
  }

  // Más de 3 minutos
  const mins = Math.round(diffSeconds / 60);
  const hrs = Math.floor(mins / 60);
  const timeStr = hrs >= 1 ? `Hace ${hrs}h` : `Hace ${mins} min`;

  return {
    status: 'offline',
    secondsAgo: diffSeconds,
    label: `Desconectado (${timeStr})`,
    badgeColor: 'bg-red-100 text-red-800',
    dotColor: '#ef4444',
    isLive: false,
  };
}
