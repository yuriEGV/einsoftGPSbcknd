/**
 * GT06 / Concox Binary Protocol Decoder — v2 FIXED
 * Used by: Concox, JimiIoT, and most Chinese GPS trackers
 *
 * Packet structure:
 *   Start:    0x78 0x78 (2 bytes)
 *   Length:   1 byte
 *   Protocol: 1 byte (0x01=Login, 0x10=GPS, 0x13=Heartbeat, 0x16=Alarm)
 *   Payload:  variable
 *   Serial:   2 bytes
 *   CRC:      2 bytes  (CRC-16/X-25)
 *   End:      0x0D 0x0A
 *
 * FIXES APPLIED:
 *   1. GPS coordinate units: GT06 sends raw value in units of 1/10000 arc-minutes
 *      Correct formula: deg = floor(raw / 600000); min = (raw % 600000) / 10000
 *   2. Hemisphere bits: bit12=gpsFixed, bit11=east(1=E,0=W), bit10=north(1=N,0=S)
 *      Some docs invert bit10/11 — corrected for southern/western hemisphere.
 *   3. Only forward packets with gpsFixed === 1 (valid satellite fix).
 *   4. CRC validation before parsing to reject corrupt packets.
 */

const PROTOCOL = {
  LOGIN:       0x01,
  GPS:         0x10,
  GPS_OFFROAD: 0x11,
  STATUS:      0x13,
  ALARM:       0x16,
  GPS_LBS:     0x17,
  HEARTBEAT:   0x23,
  WIFI:        0x2C,
};

// CRC-16/X-25 (Polynomial 0x1021, Initial 0xFFFF)
function crc16(buffer) {
  let crc = 0xFFFF;
  for (const byte of buffer) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return crc & 0xFFFF;
}

function parseBCD(buffer, offset, length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    const byte = buffer[offset + i];
    result += ((byte >> 4) & 0xF).toString() + (byte & 0xF).toString();
  }
  return result;
}

/**
 * FIX: GT06 coordinate format is DD_MM.MMMM packed as integer:
 *   raw = (degrees * 600000) + (minutes * 10000)
 *   → degrees = floor(raw / 600000)
 *   → minutes = (raw % 600000) / 10000
 *   → decimal = degrees + minutes / 60
 *
 * The old formula (raw / 1000000) was WRONG and would place
 * a tracker in southern Chile at ~-18° instead of ~-33°.
 */
function gt06CoordToDec(raw) {
  const deg = Math.floor(raw / 600000);
  const min = (raw % 600000) / 10000;
  return deg + min / 60;
}

/**
 * Build the ACK response packet for the device
 */
function buildAck(protocolNumber, serialNumber) {
  const buf = Buffer.alloc(10);
  buf[0] = 0x78;
  buf[1] = 0x78;
  buf[2] = 0x05; // length
  buf[3] = protocolNumber;
  buf[4] = (serialNumber >> 8) & 0xFF;
  buf[5] = serialNumber & 0xFF;
  const crc = crc16(buf.slice(2, 6));
  buf[6] = (crc >> 8) & 0xFF;
  buf[7] = crc & 0xFF;
  buf[8] = 0x0D;
  buf[9] = 0x0A;
  return buf;
}

/**
 * Parse a GT06 data buffer. Returns array of parsed packets.
 * @param {Buffer} data - Raw TCP data
 * @param {string} imei - Device IMEI (stored from login packet)
 * @returns {{ packets: Object[], imei: string|null, acks: Buffer[] }}
 */
function parseGT06(data, imei) {
  const packets = [];
  const acks = [];
  let newImei = null;
  let offset = 0;

  while (offset < data.length) {
    // Find start marker
    if (data[offset] !== 0x78 || data[offset + 1] !== 0x78) {
      offset++;
      continue;
    }

    const length = data[offset + 2];
    // Total packet = start(2) + length(1) + payload(length-5) + serial(2) + crc(2) + end(2)
    // Simplified: packetEnd = offset + length + 5
    const packetEnd = offset + length + 5;

    if (packetEnd > data.length) break; // incomplete packet, wait for more data

    const protocolNumber = data[offset + 3];
    const payloadStart = offset + 4;
    const payloadLen = length - 5; // length field includes protocol, serial, crc but not start or end
    const payload = data.slice(payloadStart, payloadStart + payloadLen);
    const serialNumber = data.readUInt16BE(payloadStart + payloadLen);

    // CRC validation — covers from length byte to end of serial number
    const crcComputed = crc16(data.slice(offset + 2, payloadStart + payloadLen + 2));
    const crcReceived = data.readUInt16BE(payloadStart + payloadLen + 2);
    if (crcComputed !== crcReceived) {
      console.warn(`[GT06] ⚠️  CRC mismatch (got 0x${crcReceived.toString(16)}, expected 0x${crcComputed.toString(16)}) — skipping packet`);
      offset = packetEnd;
      continue;
    }

    const ack = buildAck(protocolNumber, serialNumber);
    acks.push(ack);

    switch (protocolNumber) {
      case PROTOCOL.LOGIN: {
        // IMEI is 8 bytes BCD
        newImei = parseBCD(data, payloadStart, 8);
        console.log(`[GT06] 📱 Login from IMEI: ${newImei}`);
        packets.push({ type: 'login', imei: newImei });
        break;
      }

      case PROTOCOL.GPS:
      case PROTOCOL.GPS_OFFROAD: {
        const currentImei = newImei || imei;
        if (!currentImei) break;
        const p = payloadStart;
        try {
          const year   = data[p] + 2000;
          const month  = data[p + 1];
          const day    = data[p + 2];
          const hour   = data[p + 3];
          const minute = data[p + 4];
          const second = data[p + 5];

          const gpsInfo    = data[p + 6];
          const satellites = gpsInfo & 0x0F;
          const latRaw     = data.readUInt32BE(p + 7);
          const lngRaw     = data.readUInt32BE(p + 11);
          const speed      = data[p + 15]; // km/h directly in GT06
          const courseStatus = data.readUInt16BE(p + 16);

          // Bit 12: GPS fixed (1 = valid fix, 0 = no fix — DISCARD)
          // Bit 11: 1=East, 0=West  (longitude sign)
          // Bit 10: 1=North, 0=South (latitude sign)
          const gpsFixed = (courseStatus >> 12) & 1;
          const isEast   = (courseStatus >> 11) & 1;
          const isNorth  = (courseStatus >> 10) & 1;
          const course   = courseStatus & 0x3FF;

          // FIX: Skip packet if no satellite fix — prevents spurious (0,0) coordinates
          if (!gpsFixed) {
            console.log(`[GT06] ⚠️  No GPS fix from ${currentImei} — discarding (satellites: ${satellites})`);
            break;
          }

          // FIX: Correct coordinate formula for GT06 binary protocol
          let lat = gt06CoordToDec(latRaw);
          let lng = gt06CoordToDec(lngRaw);

          // Apply hemisphere sign
          if (!isNorth) lat = -lat;  // Southern hemisphere (e.g. Chile → negative)
          if (!isEast)  lng = -lng;  // Western hemisphere (e.g. Chile → negative)

          // Sanity check: Chile is roughly lat [-56, -17], lng [-76, -66]
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.warn(`[GT06] ⚠️  Invalid coords from ${currentImei}: lat=${lat}, lng=${lng} — skipping`);
            break;
          }

          const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

          packets.push({
            type: 'gps',
            imei: currentImei,
            gps: {
              latitude: lat,
              longitude: lng,
              speed,           // km/h
              heading: course,
              satellites,
              fixed: true,
            },
            timestamp,
          });

          console.log(`[GT06] 📍 GPS from ${currentImei}: lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}, speed=${speed}km/h, sat=${satellites}`);
        } catch (e) {
          console.error('[GT06] Error parsing GPS packet:', e.message);
        }
        break;
      }

      case PROTOCOL.ALARM: {
        const alarmByte = payload[7];
        let alarmType = 'unknown';
        if (alarmByte === 0x01) alarmType = 'sos';
        if (alarmByte === 0x02) alarmType = 'powerOff';
        if (alarmByte === 0x03) alarmType = 'shock';
        if (alarmByte === 0x09) alarmType = 'lowBattery';

        packets.push({
          type: 'alarm',
          imei: newImei || imei,
          alarmType,
        });
        console.log(`[GT06] 🚨 Alarm from ${newImei || imei}: ${alarmType}`);
        break;
      }

      case PROTOCOL.HEARTBEAT:
      case PROTOCOL.STATUS: {
        packets.push({ type: 'heartbeat', imei: newImei || imei });
        break;
      }
    }

    offset = packetEnd;
  }

  return { packets, imei: newImei || imei, acks };
}

export default parseGT06;
