import { adapters, getAllServiceUuids } from "./adapters/index.js";

const state = {
  device: null,
  server: null,
  activeAdapter: null,
  adapterSession: null,
  adHandler: null,
  latestTelemetry: null,
  latestRawFrame: "",
  latestSignalRssi: null,
  signalSupported: true,
  aliases: loadAliases(),
  scanAllDevicesNext: false,
  renderTimer: null,
  installPrompt: null,
  unsupportedReason: ""
};

const el = {
  connectBtn: document.getElementById("connectBtn"),
  statusLine: document.getElementById("statusLine"),
  unsupportedBanner: document.getElementById("unsupportedBanner"),
  displayDeviceName: document.getElementById("displayDeviceName"),
  editDeviceNameBtn: document.getElementById("editDeviceNameBtn"),
  activeProtocol: document.getElementById("activeProtocol"),
  deviceName: document.getElementById("deviceName"),
  packVoltage: document.getElementById("packVoltage"),
  packCurrent: document.getElementById("packCurrent"),
  socPercent: document.getElementById("socPercent"),
  capacityRemaining: document.getElementById("capacityRemaining"),
  temperature: document.getElementById("temperature"),
  statusText: document.getElementById("statusText"),
  cycleCount: document.getElementById("cycleCount"),
  signalRssi: document.getElementById("signalRssi"),
  lastUpdate: document.getElementById("lastUpdate"),
  cells: document.getElementById("cells"),
  statusFlags: document.getElementById("statusFlags"),
  rawFrame: document.getElementById("rawFrame"),
  themeBtn: document.getElementById("themeBtn"),
  installBtn: document.getElementById("installBtn")
};

init();

function init() {
  initTheme();
  initInstallPrompt();
  initServiceWorker();

  el.connectBtn.addEventListener("click", onConnectToggle);
  el.editDeviceNameBtn.addEventListener("click", editLocalDeviceName);

  const unsupportedReason = detectWebBluetoothSupportIssue();
  if (unsupportedReason) {
    showUnsupported(unsupportedReason);
  }

  state.renderTimer = window.setInterval(renderTelemetry, 1000);
  refreshDisplayedDeviceName();
  renderTelemetry();
}

function detectWebBluetoothSupportIssue() {
  if (!window.isSecureContext) {
    return "Web Bluetooth requires a secure context (HTTPS or localhost). Open this tool over HTTPS.";
  }
  if (!("bluetooth" in navigator)) {
    return "Web Bluetooth is not available in this browser. Use Chrome or Edge on desktop/Android.";
  }
  if (typeof navigator.bluetooth.requestDevice !== "function") {
    return "This browser exposes Bluetooth partially, but device selection is unavailable. Use Chrome or Edge.";
  }
  return "";
}

function showUnsupported(message) {
  state.unsupportedReason = message;
  el.unsupportedBanner.hidden = false;
  el.unsupportedBanner.textContent = message;
  el.connectBtn.disabled = true;
  el.connectBtn.textContent = "Connect";
  setStatus(message, true);
}

function setStatus(message, isError = false) {
  el.statusLine.textContent = message;
  el.statusLine.style.color = isError ? "var(--warn-fg)" : "var(--muted)";
}

async function connect() {
  if (state.unsupportedReason) {
    showUnsupported(state.unsupportedReason);
    return;
  }

  try {
    await disconnect();

    setStatus("Requesting BLE device...");
    const optionalServices = getAllServiceUuids();
    const device = await requestBmsDevice(optionalServices, state.scanAllDevicesNext);
    state.scanAllDevicesNext = false;

    device.addEventListener("gattserverdisconnected", onDisconnected);
    state.device = device;
    await setupSignalMonitoring(device);
    setStatus(`Connecting to ${device.name || "Unnamed device"}...`);

    const server = await device.gatt.connect();
    state.server = server;

    const context = await buildProbeContext(server, device);
    const selected = selectAdapter(context);
    if (!selected) {
      throw new Error("No compatible adapter found. Pick a protocol manually or try another device.");
    }

    state.activeAdapter = selected;
    state.adapterSession = await selected.start({
      server,
      device,
      onTelemetry: (telemetry) => {
        state.latestTelemetry = telemetry;
      },
      onFrame: (rawHex) => {
        state.latestRawFrame = rawHex;
      },
      onStatus: (msg) => setStatus(msg)
    });

    el.connectBtn.textContent = "Disconnect";
    el.activeProtocol.textContent = selected.label;
    el.deviceName.textContent = normalizeDeviceName(device.name) || "Unnamed";
    refreshDisplayedDeviceName();
    setStatus(`Connected: ${selected.label}`);
  } catch (err) {
    await disconnect();
    setStatus(`Connect failed: ${err.message || String(err)}`, true);
  }
}

async function disconnect() {
  if (state.adapterSession?.stop) {
    try {
      await state.adapterSession.stop();
    } catch (_err) {
      // ignore
    }
  }
  state.adapterSession = null;

  if (state.device) {
    state.device.removeEventListener("gattserverdisconnected", onDisconnected);
    if (state.adHandler) {
      state.device.removeEventListener("advertisementreceived", state.adHandler);
    }
    if (typeof state.device.unwatchAdvertisements === "function") {
      try {
        state.device.unwatchAdvertisements();
      } catch (_err) {
        // ignore
      }
    }
  }

  if (state.server?.connected) {
    try {
      state.server.disconnect();
    } catch (_err) {
      // ignore
    }
  }
  if (state.device?.gatt?.connected) {
    try {
      state.device.gatt.disconnect();
    } catch (_err) {
      // ignore
    }
  }

  state.device = null;
  state.server = null;
  state.activeAdapter = null;
  state.adHandler = null;
  state.latestSignalRssi = null;
  state.signalSupported = true;
  el.connectBtn.disabled = Boolean(state.unsupportedReason);
  el.connectBtn.textContent = "Connect";
  el.activeProtocol.textContent = "-";
  el.deviceName.textContent = "-";
  refreshDisplayedDeviceName();
}

async function onDisconnected() {
  setStatus("BLE device disconnected.", true);
  await disconnect();
}

async function buildProbeContext(server, device) {
  const serviceUuids = getAllServiceUuids();
  const map = new Map();

  for (const serviceUuid of serviceUuids) {
    try {
      const service = await server.getPrimaryService(serviceUuid);
      const chars = await service.getCharacteristics();
      map.set(toShort(serviceUuid), chars.map((c) => toShort(c.uuid)));
    } catch (_err) {
      // service not available
    }
  }

  return {
    deviceName: device.name || "",
    characteristicsByService: map,
    hasCharacteristic(service, characteristic) {
      const s = toShort(service);
      const c = toShort(characteristic);
      const list = map.get(s) || [];
      return list.includes(c);
    }
  };
}

function selectAdapter(context) {
  const scored = adapters
    .map((adapter) => ({ adapter, score: Number(adapter.match(context) || 0) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.adapter || null;
}

async function onConnectToggle() {
  if (state.server?.connected || state.device?.gatt?.connected) {
    await disconnect();
    setStatus("Disconnected.");
    return;
  }
  await connect();
}

function renderTelemetry() {
  const t = state.latestTelemetry;
  if (!t) {
    setText(el.signalRssi, formatSignalText());
    if (state.latestRawFrame) {
      el.rawFrame.value = state.latestRawFrame;
    }
    return;
  }

  setText(el.packVoltage, formatNum(t.packVoltageV, 3, "V", "--.- V"));
  setText(el.packCurrent, formatNum(t.currentA, 3, "A", "--.- A"));
  setText(el.socPercent, formatNum(t.socPercent, 0, "%", "-- %"));
  setText(el.capacityRemaining, formatNum(t.remainingCapacityAh, 3, "Ah", "-- Ah"));
  setText(el.temperature, formatNum(t.temperatureC, 1, "C", "--.- C"));
  setText(el.statusText, t.statusText || "unknown");
  setText(el.cycleCount, Number.isFinite(t.cycleCount) ? String(t.cycleCount) : "-");
  setText(el.signalRssi, formatSignalText());
  setText(el.lastUpdate, new Date(t.timestamp || Date.now()).toLocaleTimeString());
  setText(el.statusFlags, t.statusFlags || "-");

  if (Array.isArray(t.cellVoltagesMv) && t.cellVoltagesMv.length) {
    const printable = t.cellVoltagesMv
      .map((mv, idx) => `C${idx + 1}:${(mv / 1000).toFixed(3)}V`)
      .join("  ");
    setText(el.cells, printable);
  } else {
    setText(el.cells, "-");
  }

  if (t.rawFrameHex) {
    el.rawFrame.value = t.rawFrameHex;
  } else if (state.latestRawFrame) {
    el.rawFrame.value = state.latestRawFrame;
  }

  if (Array.isArray(t.adapterWarnings) && t.adapterWarnings.length) {
    setStatus(`Connected. ${t.adapterWarnings.join(" | ")}`);
  }
}

function setText(node, text) {
  node.textContent = text;
}

function formatNum(value, decimals, unit, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return `${value.toFixed(decimals)} ${unit}`;
}

function formatSignalText() {
  if (!state.device) return "-";
  if (!state.signalSupported) return "Not supported by this browser/device";
  if (!Number.isFinite(state.latestSignalRssi)) return "Waiting for RSSI...";
  const rssi = state.latestSignalRssi;
  let quality = "weak";
  if (rssi >= -60) quality = "excellent";
  else if (rssi >= -75) quality = "good";
  else if (rssi >= -85) quality = "fair";
  return `${rssi} dBm (${quality})`;
}

async function setupSignalMonitoring(device) {
  state.latestSignalRssi = null;
  state.signalSupported = typeof device.watchAdvertisements === "function";
  if (!state.signalSupported) return;

  const handler = (event) => {
    if (Number.isFinite(event.rssi)) {
      state.latestSignalRssi = event.rssi;
    }
  };
  state.adHandler = handler;
  device.addEventListener("advertisementreceived", handler);

  try {
    await device.watchAdvertisements();
  } catch (_err) {
    state.signalSupported = false;
    device.removeEventListener("advertisementreceived", handler);
    state.adHandler = null;
  }
}

async function requestBmsDevice(optionalServices, forceAllDevices = false) {
  const filters = optionalServices.map((service) => ({ services: [service] }));
  if (forceAllDevices || !filters.length) {
    return navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices
    });
  }

  try {
    return await navigator.bluetooth.requestDevice({
      filters,
      optionalServices
    });
  } catch (err) {
    if (err?.name !== "NotFoundError") {
      throw err;
    }
    state.scanAllDevicesNext = true;
    throw new Error("No matching BMS devices found in filtered scan. Press Connect again to show the full Bluetooth list.");
  }
}

function getDeviceStorageKey(device) {
  if (!device) return "";
  if (device.id) return `id:${device.id}`;
  return `name:${device.name || "unnamed"}`;
}

function getDisplayNameForDevice(device) {
  if (!device) return "-";
  const fallback = normalizeDeviceName(device.name) || "Unnamed";
  const key = getDeviceStorageKey(device);
  const alias = state.aliases[key];
  return alias && alias.trim() ? alias.trim() : fallback;
}

function refreshDisplayedDeviceName() {
  const name = getDisplayNameForDevice(state.device);
  setText(el.displayDeviceName, name);
  el.editDeviceNameBtn.disabled = !state.device;
}

function editLocalDeviceName() {
  if (!state.device) return;
  const fallback = normalizeDeviceName(state.device.name) || "Unnamed";
  const current = getDisplayNameForDevice(state.device);
  const next = window.prompt(
    `Set a local name for this battery.\nThis is only stored in this browser.\nLeave empty to reset to device name (${fallback}).`,
    current
  );
  if (next === null) return;

  const key = getDeviceStorageKey(state.device);
  const trimmed = next.trim();
  if (!trimmed || trimmed === fallback) {
    delete state.aliases[key];
  } else {
    state.aliases[key] = trimmed;
  }
  persistAliases(state.aliases);
  refreshDisplayedDeviceName();
}

function loadAliases() {
  try {
    const raw = localStorage.getItem("battery-device-aliases-v1");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (_err) {
    return {};
  }
}

function persistAliases(aliases) {
  try {
    localStorage.setItem("battery-device-aliases-v1", JSON.stringify(aliases));
  } catch (_err) {
    // ignore storage failures
  }
}

function normalizeDeviceName(rawName) {
  const value = String(rawName || "").trim();
  if (!value) return "";
  return value.replace(/[\s\u25B6\u25B8\u25BA\u25B9\u203A>]+$/u, "").trim();
}

function toShort(uuid) {
  if (typeof uuid === "number") {
    return uuid & 0xffff;
  }
  const text = String(uuid).toLowerCase();
  const match = text.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
  if (match) return Number.parseInt(match[1], 16);
  const short = Number.parseInt(text.replace(/^0x/, ""), 16);
  return Number.isFinite(short) ? short : text;
}

function initTheme() {
  const root = document.documentElement;
  const key = "battery-status-theme";
  const stored = localStorage.getItem(key);
  if (stored === "light" || stored === "dark") root.dataset.theme = stored;

  el.themeBtn.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(key, root.dataset.theme || "light");
  });
}

function initInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    el.installBtn.hidden = false;
  });

  el.installBtn.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt();
    state.installPrompt = null;
    el.installBtn.hidden = true;
  });
}

function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // keep app usable without SW
  });
}
