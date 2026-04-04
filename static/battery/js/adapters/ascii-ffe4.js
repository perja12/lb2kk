const FFE0 = 0xffe0;
const FFE4 = 0xffe4;
const EXPECTED_WORDS = 28;

class FrameDecoder {
  constructor() {
    this.buf = new Uint8Array();
  }

  feed(chunk) {
    const trimmed = trimTrailingZeros(chunk);
    if (!trimmed.length) return [];

    const frames = [];
    const caret = 0x5e;
    const indexes = [];
    for (let i = 0; i < trimmed.length; i += 1) {
      if (trimmed[i] === caret) indexes.push(i);
    }

    if (!indexes.length) {
      this.buf = concat(this.buf, trimmed);
      return frames;
    }

    if (indexes[0] > 0) {
      this.buf = concat(this.buf, trimmed.slice(0, indexes[0]));
    }
    if (this.buf.length) {
      frames.push(this.buf);
      this.buf = new Uint8Array();
    }

    for (let i = 0; i < indexes.length; i += 1) {
      const start = indexes[i];
      const end = indexes[i + 1] ?? trimmed.length;
      const candidate = trimmed.slice(start, end);
      if (i < indexes.length - 1) {
        frames.push(candidate);
      } else {
        this.buf = concat(this.buf, candidate);
      }
    }

    return frames.filter((f) => f.length);
  }

  flush() {
    if (!this.buf.length) return null;
    const out = this.buf;
    this.buf = new Uint8Array();
    return out;
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function trimTrailingZeros(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end -= 1;
  return bytes.slice(0, end);
}

function parseLittleWord(text, idx) {
  const offset = idx * 4;
  const chunk = text.slice(offset, offset + 4);
  if (chunk.length !== 4) return null;
  const lo = Number.parseInt(chunk.slice(0, 2), 16);
  const hi = Number.parseInt(chunk.slice(2, 4), 16);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo | (hi << 8);
}

function signed32(lo, hi) {
  const value = (lo | (hi << 16)) >>> 0;
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

function parseFrame(frame) {
  const text = new TextDecoder().decode(frame).replace(/\0+$/, "").trim();
  if (!text.startsWith("^")) return null;

  const body = text.slice(1);
  if (!/^[0-9A-F]+$/.test(body)) return null;
  if (body.length % 4 !== 0) return null;
  if (body.length / 4 !== EXPECTED_WORDS) return null;

  const words = [];
  for (let i = 0; i < EXPECTED_WORDS; i += 1) {
    words.push(parseLittleWord(body, i));
  }
  if (words.some((w) => w == null)) return null;

  const currentRaw = signed32(words[2], words[3]);
  const currentA = Number((currentRaw / 1000).toFixed(3));
  const tempRaw = words[8];
  const cells = words.slice(11, 15).map((v) => Number(v));
  const flags = words[9];
  const statusText = inferStatusText(currentA, flags);

  return {
    timestamp: Date.now(),
    protocolId: "ascii-ffe4",
    packVoltageV: Number((words[0] / 1000).toFixed(3)),
    currentA,
    remainingCapacityAh: Number((words[4] / 1000).toFixed(3)),
    cycleCount: words[6],
    socPercent: words[7],
    temperatureC: Number((tempRaw / 10 - 273.15).toFixed(2)),
    cellVoltagesMv: cells,
    statusFlags: `0x${flags.toString(16).toUpperCase().padStart(4, "0")}`,
    statusText,
    rawFrameHex: bytesToHex(frame)
  };
}

function inferStatusText(currentA, flags) {
  // Current direction is the most reliable real-time indicator.
  if (Number.isFinite(currentA)) {
    if (currentA > 0.2) return "charging";
    if (currentA < -0.2) return "discharging";
    return "standby";
  }
  if (flags === 0x8000) return "charging";
  if (flags === 0xc000) return "discharging/standby";
  return "unknown";
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

export const asciiFfe4Adapter = {
  id: "ascii-ffe4",
  label: "FFE4 ASCII (from probe)",
  serviceUuids: [FFE0],
  characteristicUuids: [FFE4],
  match(ctx) {
    const hasNotify = ctx.hasCharacteristic(FFE0, FFE4);
    if (!hasNotify) return 0;
    const name = (ctx.deviceName || "").toLowerCase();
    if (name.includes("bms") || name.includes("lifepo")) return 0.8;
    return 0.65;
  },
  async start({ server, onTelemetry, onFrame, onStatus }) {
    const service = await server.getPrimaryService(FFE0);
    const ch = await service.getCharacteristic(FFE4);
    const decoder = new FrameDecoder();
    let invalidFrames = 0;

    const handle = (event) => {
      const value = event.target.value;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const complete = decoder.feed(bytes);
      for (const frame of complete) {
        onFrame(bytesToHex(frame));
        const telemetry = parseFrame(frame);
        if (telemetry) {
          invalidFrames = 0;
          onTelemetry(telemetry);
          onStatus("Receiving battery telemetry...");
        } else {
          invalidFrames += 1;
          // Some devices emit occasional non-telemetry chunks; ignore but keep operator informed.
          onStatus(`Ignoring non-telemetry frame (${invalidFrames}).`);
        }
      }
    };

    await ch.startNotifications();
    ch.addEventListener("characteristicvaluechanged", handle);
    onStatus("Listening for FFE4 notifications...");

    return {
      async stop() {
        ch.removeEventListener("characteristicvaluechanged", handle);
        try {
          await ch.stopNotifications();
        } catch (_err) {
          // ignore disconnect path
        }
        const tail = decoder.flush();
        if (tail) onFrame(bytesToHex(tail));
      }
    };
  }
};
