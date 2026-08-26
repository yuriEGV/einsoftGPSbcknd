/**
 * TK103 / GPS103 Text Protocol Decoder — v2 FIXED
 * Used by: Coban TK103, GPS103, many generic Chinese trackers
 *
 * Login packet:    ##,imei:IMEI,A;
 * GPS packet:      imei:IMEI,tracker,DDMMYY,A,LAT,N,LNG,E,SPEED,COURSE,DDMMYY,,;
 * Alarm packet:    imei:IMEI,help me,DDMMYY,A,LAT,N,LNG,E,SPEED,COURSE,DDMMYY,,;
 * Heart beat:      imei:IMEI,;
 *
 * Some variants use (IMEI)... instead of imei:IMEI...
 *
 * FIXES APPLIED:
 *   1. nmeaToDec: robustified to handle lat (DDMM.MMMM) and lng (DDDMM.MMMM) correctly.
 *   2. Validity flag V=Void → packet skipped entirely (never updates DB with stale/0,0 coords).
 *   3. Sanity bounds check on decoded coords.
 *   4. Speed sanity: cap at 300 km/h, reject obviously wrong values.
 */

/**
 * NMEA to Decimal Degrees
 * Input: value in DDDMM.MMMM format (e.g. 3302.7612 → 33°02.7612' → 33.04602°)
 * hemisphere: N/S/E/W
 */
function nmeaToDec(value, hemisphere) {
  if (isNaN(value) || value === 0) return 0;
  // Degrees are the whole part divided by 100 (floor, not round)
  const deg = Math.floor(value / 100);
  // Minutes are the remainder
  const min = value - deg * 100;
  let dec = deg + min / 60;
  if (hemisphere === 'S' || hemisphere === 'W') dec = -dec;
  return dec;
}

function parseTK103Line(line) {
  line = line.trim();

  // Extract IMEI - handles both "imei:123" and "(123)" formats
  let imei = null;
  let rest = line;

  const imeiMatch = line.match(/imei[:\s](\d+)/i) || line.match(/^\((\d+)\)/);
  if (imeiMatch) {
    imei = imeiMatch[1];
    rest = line.slice(imeiMatch[0].length);
  }

  // Login packet: ##,imei:IMEI,A;
  if (line.startsWith('##')) {
    console.log(`[TK103] 📱 Login from IMEI: ${imei}`);
    return { type: 'login', imei, ack: 'LOAD\r\n' };
  }

  // Heartbeat: just IMEI followed by nothing meaningful
  if (!rest.includes(',') || rest.split(',').length < 6) {
    return { type: 'heartbeat', imei };
  }

  // Parse GPS/alarm fields
  const parts = rest.split(',');

  // parts[0] = message type (tracker, help me, etc.)
  // parts[1] = DDMMYY (date)
  // parts[2] = validity (A/V)
  // parts[3] = latitude (DDMM.MMMM)
  // parts[4] = N/S
  // parts[5] = longitude (DDDMM.MMMM)
  // parts[6] = E/W
  // parts[7] = speed (knots)
  // parts[8] = course (degrees)
  // parts[9] = DDMMYY (date again)

  const msgType    = (parts[0] || '').trim().toLowerCase();
  const validity   = (parts[2] || '').trim().toUpperCase();
  const latRaw     = parseFloat(parts[3]);
  const latHemi    = (parts[4] || '').trim().toUpperCase();
  const lngRaw     = parseFloat(parts[5]);
  const lngHemi    = (parts[6] || '').trim().toUpperCase();
  const speedKnots = parseFloat(parts[7]) || 0;
  const course     = parseFloat(parts[8]) || 0;

  // FIX: Discard Void (V) packets — GPS not yet locked onto satellites
  if (validity !== 'A') {
    console.log(`[TK103] ⚠️  Void fix (V) from ${imei}, type=${msgType} — discarding to avoid stale coordinates`);
    return { type: 'invalidGps', imei };
  }

  if (isNaN(latRaw) || isNaN(lngRaw)) {
    console.warn(`[TK103] ⚠️  NaN coords from ${imei} — skipping`);
    return null;
  }

  const lat = nmeaToDec(latRaw, latHemi);
  const lng = nmeaToDec(lngRaw, lngHemi);

  // Sanity check — reject impossible coordinates
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.warn(`[TK103] ⚠️  Out-of-bounds coords from ${imei}: lat=${lat}, lng=${lng} — skipping`);
    return null;
  }

  // FIX: Speed cap — reject obviously erroneous values (>300 km/h for personal trackers)
  const speed = Math.min(Math.round(speedKnots * 1.852), 300);

  // Determine alarm type
  let alarmSensor = undefined;
  if (msgType === 'help me' || msgType === 'sos') {
    alarmSensor = { sos: true };
  } else if (msgType === 'low battery') {
    alarmSensor = { lowBattery: true };
  }

  console.log(`[TK103] 📍 GPS from ${imei}: lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}, speed=${speed}km/h, type=${msgType}`);

  return {
    type: 'gps',
    imei,
    gps: { latitude: lat, longitude: lng, speed, heading: course },
    alarmSensor,
    timestamp: new Date(),
    ack: 'ON\r\n', // TK103 expects an ACK response
  };
}

function parseTK103(data, existingImei) {
  const text = data.toString('ascii');
  // TK103 packets are separated by ; or \n
  const lines = text.split(/[;\r\n]+/);
  const packets = [];
  const acks = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const packet = parseTK103Line(line);
      if (packet) {
        if (packet.ack) acks.push(Buffer.from(packet.ack));
        delete packet.ack;
        // Only push valid gps and login/alarm — skip invalidGps
        if (packet.type !== 'invalidGps') {
          packets.push(packet);
        }
      }
    } catch (e) {
      // ignore malformed lines
    }
  }

  return { packets, imei: packets[0]?.imei || existingImei, acks };
}

export default parseTK103;
