const FFE0 = 0xffe0;
const FFE1 = 0xffe1;
const RESPONSE_SIZE = 300;

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function crc8sum(bytes, len) {
  let crc = 0;
  for (let i = 0; i < len; i += 1) crc = (crc + bytes[i]) & 0xff;
  return crc;
}

function buildCommand(address, value = 0, length = 0) {
  const frame = new Uint8Array(20);
  frame[0] = 0xaa;
  frame[1] = 0x55;
  frame[2] = 0x90;
  frame[3] = 0xeb;
  frame[4] = address;
  frame[5] = length;
  frame[6] = value & 0xff;
  frame[7] = (value >> 8) & 0xff;
  frame[8] = (value >> 16) & 0xff;
  frame[9] = (value >> 24) & 0xff;
  frame[19] = crc8sum(frame, 19);
  return frame;
}

function getU16LE(dv, offset) {
  return dv.getUint16(offset, true);
}

function getI16LE(dv, offset) {
  return dv.getInt16(offset, true);
}

function getU32LE(dv, offset) {
  return dv.getUint32(offset, true);
}

function getI32LE(dv, offset) {
  return dv.getInt32(offset, true);
}

function inferStatus(currentA) {
  if (currentA > 0.2) return "charging";
  if (currentA < -0.2) return "discharging";
  return "idle";
}

function parseJk02_24S(frame) {
  if (frame.length < RESPONSE_SIZE) return { error: "frame_too_short" };
  if (!(frame[0] === 0x55 && frame[1] === 0xaa && frame[2] === 0xeb && frame[3] === 0x90)) {
    return { error: "header_mismatch" };
  }
  const remoteCrc = frame[299];
  const computedCrc = crc8sum(frame, 299);
  if (remoteCrc !== computedCrc) return { error: "crc_mismatch" };
  if (frame[4] !== 0x02) return { error: "unsupported_frame_type" };

  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const cellVoltagesMv = [];
  for (let i = 0; i < 24; i += 1) {
    cellVoltagesMv.push(getU16LE(dv, 6 + i * 2));
  }

  const packVoltageV = Number((getU32LE(dv, 118) / 1000).toFixed(3));
  const currentA = Number((getI32LE(dv, 126) / 1000).toFixed(3));
  const t1 = Number((getI16LE(dv, 130) / 10).toFixed(1));
  const t2 = Number((getI16LE(dv, 132) / 10).toFixed(1));
  const mos = Number((getI16LE(dv, 134) / 10).toFixed(1));
  const soc = frame[141];
  const remainingCapacityAh = Number((getU32LE(dv, 142) / 1000).toFixed(3));
  const cycleCount = getU32LE(dv, 150);
  const errorsBitmask = ((frame[136] << 8) | frame[137]) >>> 0;

  if (soc > 100 || packVoltageV <= 0 || packVoltageV > 200) {
    return { error: "plausibility_check_failed" };
  }

  const validCells = cellVoltagesMv.filter((v) => v > 0);
  const avgCell = validCells.length
    ? Number((validCells.reduce((a, b) => a + b, 0) / validCells.length / 1000).toFixed(3))
    : null;

  return {
    telemetry: {
      timestamp: Date.now(),
      protocolId: "jk-ble-jk02-24s",
      packVoltageV,
      currentA,
      socPercent: soc,
      remainingCapacityAh,
      cycleCount,
      temperatureC: t1,
      statusText: inferStatus(currentA),
      statusFlags: `0x${errorsBitmask.toString(16).toUpperCase().padStart(4, "0")}`,
      cellVoltagesMv,
      adapterWarnings: [
        `Temp2=${t2.toFixed(1)}C`,
        `MOS=${mos.toFixed(1)}C`,
        avgCell == null ? "No active cells detected" : `AvgCell=${avgCell.toFixed(3)}V`
      ],
      rawFrameHex: bytesToHex(frame)
    }
  };
}

export const jkBleJk02Adapter = {
  id: "jk-ble-jk02-24s",
  label: "JK-BMS BLE (JK02 24S)",
  serviceUuids: [FFE0],
  characteristicUuids: [FFE1],
  match(ctx) {
    if (!ctx.hasCharacteristic(FFE0, FFE1)) return 0;
    const name = (ctx.deviceName || "").toLowerCase();
    if (name.includes("jk") || name.includes("jkbms")) return 0.95;
    return 0.6;
  },
  async start({ server, onTelemetry, onFrame, onStatus }) {
    const service = await server.getPrimaryService(FFE0);
    const ch = await service.getCharacteristic(FFE1);
    let buffer = new Uint8Array();
    let pollTimer = null;

    const parseBuffer = () => {
      while (buffer.length >= 4) {
        const start = findHeader(buffer);
        if (start < 0) {
          buffer = new Uint8Array();
          return;
        }
        if (start > 0) {
          buffer = buffer.slice(start);
        }
        if (buffer.length < RESPONSE_SIZE) return;

        const frame = buffer.slice(0, RESPONSE_SIZE);
        buffer = buffer.slice(RESPONSE_SIZE);

        onFrame(bytesToHex(frame));
        const parsed = parseJk02_24S(frame);
        if (parsed.telemetry) {
          onTelemetry(parsed.telemetry);
          onStatus("Received JK telemetry.");
        } else if (parsed.error === "unsupported_frame_type") {
          onStatus("JK frame received, but this variant is not supported yet.");
        }
      }
    };

    const onNotify = (event) => {
      const value = event.target.value;
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (!chunk.length) return;
      buffer = concat(buffer, chunk);
      if (buffer.length > 420) {
        const start = findHeader(buffer);
        buffer = start >= 0 ? buffer.slice(start) : new Uint8Array();
      }
      parseBuffer();
    };

    await ch.startNotifications();
    ch.addEventListener("characteristicvaluechanged", onNotify);

    const poll = async () => {
      try {
        const query = buildCommand(0x96, 0, 0);
        await ch.writeValueWithoutResponse(query);
      } catch (err) {
        onStatus(`JK query failed: ${err.message || String(err)}`);
      }
    };

    await poll();
    pollTimer = window.setInterval(poll, 2000);
    onStatus("Polling JK cell info every 2s...");

    return {
      async stop() {
        if (pollTimer) window.clearInterval(pollTimer);
        ch.removeEventListener("characteristicvaluechanged", onNotify);
        try {
          await ch.stopNotifications();
        } catch (_err) {
          // ignore disconnect path
        }
      }
    };
  }
};

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function findHeader(bytes) {
  for (let i = 0; i <= bytes.length - 4; i += 1) {
    if (bytes[i] === 0x55 && bytes[i + 1] === 0xaa && bytes[i + 2] === 0xeb && bytes[i + 3] === 0x90) {
      return i;
    }
  }
  return -1;
}
