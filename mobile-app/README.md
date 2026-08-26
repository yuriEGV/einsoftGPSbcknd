# EYE-NODE 360 — Aplicación Móvil de Rastreo GPS

App PWA/Capacitor para convertir cualquier celular Android en un rastreador GPS profesional.

## Características

- 📍 **GPS 4-band** con calificación de precisión (GNSS_4BAND_RTK, A_GNSS_WIFI, CELL_ID)
- 🔋 **WakeLock API** — previene suspensión del GPS en Android con pantalla apagada
- 🚨 **Botón de Pánico SOS** — transmisión instantánea con alerta al panel de control
- 📦 **Caja Negra offline** — guarda hasta 5,000 puntos sin conexión y sincroniza al volver online
- 🏎️ **IMU 6-axis** — detección de impactos, frenadas bruscas y curvas peligrosas
- 🔄 **Transmisión adaptativa** — cada 15min estacionado, 10s normal, 3s en movimiento rápido

## Instalación

```bash
cd mobile-app
npm install
npm run dev       # desarrollo
npm run build     # producción
```

## Variables de entorno

```
VITE_API_URL=https://einsoft-gp-sbcknd.vercel.app/api/telemetry
```

## Correcciones aplicadas (v2)

- **WakeLock API**: Activado — mantiene GPS vivo con pantalla apagada
- **Coords (0,0) descartadas**: No envía al servidor hasta tener fix GPS real
- **Precisión > 500m filtrada**: Ignora señal solo de antenas celulares
- **Velocidad m/s → km/h**: Conversión correcta de la API Geolocation del browser
- **enableHighAccuracy: true**: Fuerza chip GPS real (no triangulación por WiFi/celdas)
- **maximumAge: 0**: Nunca sirve posición cacheada/antigua
