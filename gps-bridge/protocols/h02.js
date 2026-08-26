/**
 * H02 / Huabao Text Protocol Decoder — v2 FIXED
 * Used by: Huabao, some Smart Tags, TK series variants
 *
 * Packet structure (text, \r\n terminated):
 *   *HQ,IMEI,V1,HHMMSS,A,LAT,N,LNG,E,SPEED,COURSE,DDMMYY,RSSI,SAT,VOLTAGE,RESERVED#
 *
 * Example:
 *   *HQ,8613800138000,V1,131415,A,2234.0611,N,11408.6494,E,0.00,0,210124,0,8,4.2,000,0#
 *
 * FIXES APPLIED:
 *   1. nmeaToDec: use floor(value/100) for correct degree extraction (same as TK103 fix).
 *   2. Void (V) validity flag → skip updating position to prevent stale/ocean coordinates.
 *   3. Sanity bounds check on decoded coordinates.
 *   4. Timestamp built in UTC to avoid local timezone offset causing ±hours drift.
 *   5. Voltage field index corrected (H02 spec: RSSI=idx12, SAT=idx13, VOLTAGE=idx14).
 */

/**
 * Convert NMEA format (DDDMM.MMMM) to decimal degrees
 * FIX: Was using Math.floor(value/100) which is correct, but
 *      must explicitly handle the edge case where min >= 60 (malformed data).
 */
function nmeaToDec(value, hemisphere) {
  if (isNaN(value) || value === 0) return 0;
  const deg = Math.floor(value / 100);
  const min = value - deg * 100;
  // Guard: minutes must be in [0,60)
  if (min < 0 || min >= 60) return 0;
  let dec = deg + min / 60;
  if (hemisphere === 'S' || hemisphere === 'W') dec = -dec;
  return dec;
}

/**
 * Parse a single H02 line.
 * Returns null if not a valid H02 GPS packet.
 */
function parseH02Line(line) {
  // Strip *HQ, prefix and # suffix
  line = line.trim().replace(/^[\*\(]/, '').replace(/[\#\)]\s*$/, '');
  const parts = line.split(',');

  if (parts[0] !== 'HQ') return null;
  if (parts.length < 12) return null;

  const imei      = parts[1];
  const msgType   = parts[2]; // V1 = normal GPS, VP1 = alarm, etc.
  const timeStr   = parts[3]; // HHMMSS
  const validity  = (parts[4] || '').trim().toUpperCase(); // A=valid, V=invalid
  const latRaw    = parseFloat(parts[5]);
  const latHemi   = (parts[6] || '').toUpperCase();
  const lngRaw    = parseFloat(parts[7]);
  const lngHemi   = (parts[8] || '').toUpperCase();
  const speedKnots = parseFloat(parts[9]) || 0;
  const course    = parseFloat(parts[10]) || 0;
  const dateStr   = parts[11]; // DDMMYY

  // FIX: Discard Void (V) packets — GPS has no satellite lock
  if (validity !== 'A') {
    console.log(`[H02] ⚠️  Void fix (V) from ${imei} — discarding to prevent stale location`);
    return { type: 'invalidGps', imei };
  }

  if (isNaN(latRaw) || isNaN(lngRaw)) return null;

  const lat = nmeaToDec(latRaw, latHemi);
  const lng = nmeaToDec(lngRaw, lngHemi);

  // Sanity bounds check
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
    console.warn(`[H02] ⚠️  Invalid coords from ${imei}: lat=${lat}, lng=${lng} — skipping`);
    return null;
  }

  // FIX: Parse date/time in UTC to avoid timezone shift errors
  const day  = parseInt(dateStr.substring(0, 2), 10);
  const mon  = parseInt(dateStr.substring(2, 4), 10) - 1;
  const year = 2000 + parseInt(dateStr.substring(4, 6), 10);
  const hh   = parseInt(timeStr.substring(0, 2), 10);
  const mm   = parseInt(timeStr.substring(2, 4), 10);
  const ss   = parseInt(timeStr.substring(4, 6), 10);
  // H02 timestamps are UTC
  const timestamp = new Date(Date.UTC(year, mon, day, hh, mm, ss));

  // Speed: knots → km/h, capped at 300
  const speed = Math.min(Math.round(speedKnots * 1.852), 300);

  // FIX: Corrected field indices per H02 spec
  // idx 12 = RSSI, idx 13 = Satellites, idx 14 = Voltage (Battery)
  const rssi       = parts[12] ? parseInt(parts[12], 10) : undefined;
  const satellites = parts[13] ? parseInt(parts[13], 10) : undefined;
  const voltage    = parts[14] ? parseFloat(parts[14]) : undefined;

  // Alarm detection
  let alarmType = null;
  if (msgType === 'VP1' || msgType === 'ALRM') {
    const alarmCode = parts[15] || '';
    if (alarmCode.includes('01')) alarmType = 'sos';
    if (alarmCode.includes('02')) alarmType = 'powerOff';
    if (alarmCode.includes('03')) alarmType = 'shock';
  }

  const result = {
    type: 'gps',
    imei,
    gps: {
      latitude: lat,
      longitude: lng,
      speed,
      heading: course,
      satellites,
      rssi,
    },
    battery: voltage !== undefined ? { voltage } : undefined,
    alarmSensor: alarmType ? { sos: alarmType === 'sos' } : undefined,
    timestamp,
  };

  console.log(`[H02] 📍 GPS from ${imei}: lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}, speed=${speed}km/h, sat=${satellites}`);

  return result;
}

/**
 * Parse a buffer that may contain multiple H02 lines.
 */
function parseH02(data, existingImei) {
  const text = data.toString('ascii');
  const lines = text.split(/\r?\n/);
  const packets = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const packet = parseH02Line(line);
    // FIX: Only include valid GPS packets, not invalidGps
    if (packet && packet.type !== 'invalidGps') {
      packets.push(packet);
    }
  }

  return { packets, imei: packets[0]?.imei || existingImei, acks: [] };
}

export default parseH02;
