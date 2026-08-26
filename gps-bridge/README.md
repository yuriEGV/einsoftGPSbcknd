# GPS Bridge — Servidor TCP para Trackers de Hardware GPS

Módulo que escucha conexiones TCP/UDP de trackers GPS físicos y reenvía los datos al backend de Einsoft GPS.

## Protocolos soportados

| Puerto | Protocolo | Dispositivos |
|--------|-----------|-------------|
| 5023   | GT06 / Concox (binario) | Coban TK915, JimiIoT, mayoría de trackers chinos |
| 5013   | H02 / Huabao (texto)    | Huabao, Smart Tags |
| 5002   | TK103 / GPS103 (texto)  | Coban TK103, GPS103, clones genéricos |
| 8090   | HTTP relay              | Dispositivos con configuración de URL |

## Instalación y uso

```bash
cd gps-bridge
npm install
node server.js
```

## Variables de entorno (.env)

```
EINSOFT_BACKEND_URL=https://einsoft-gp-sbcknd.vercel.app
PORT_GT06=5023
PORT_H02=5013
PORT_TK103=5002
PORT_HTTP=8090
```

## Para configurar el tracker de hardware

Envía SMS al tracker para apuntarlo a tu IP pública:

```
# Para GT06 (CX-XTAG11, TK915, etc.):
server123456 TU_IP_PUBLICA 5023

# Para TK103:
adminip TU_IP_PUBLICA 5002
```

Tu IP pública: https://whatismyip.com

## Correcciones aplicadas (v2)

- **GT06**: Fórmula de coordenadas corregida (`raw/600000`) — antes ubicaba en ~-18°S en vez de -33°S
- **TK103/H02**: Tramas Void (V) descartadas — ya no actualiza DB con coords (0,0) antes del fix GPS  
- **Todos**: Validación de rango de coordenadas (lat [-90,90], lng [-180,180])
- **Servidor**: Reintento automático en errores 5xx de Vercel (cold-start serverless)
