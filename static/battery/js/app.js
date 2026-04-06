import { adapters, getAllServiceUuids } from "./adapters/index.js";

const AUX_UI_VISIBLE_MS = 4500;
const ESTIMATE_DISCHARGE_THRESHOLD_A = 0.3;
const ESTIMATE_SMOOTHING_ALPHA = 0.12;
const ESTIMATE_STEP_MIN = 5;
const ESTIMATE_HYSTERESIS_MIN = 8;
const MAX_REASONABLE_CURRENT_A = 120;
const NOMINAL_CAPACITY_STORAGE_KEY = "battery-nominal-capacity-ah-v1";
const HISTORY_STORAGE_KEY = "battery-discharge-history-v1";
const HISTORY_CURRENT_ALPHA = 0.08;
const HISTORY_SOC_RATE_ALPHA = 0.2;
const HISTORY_MIN_DT_MS = 60 * 1000;
const HISTORY_MAX_DT_MS = 30 * 60 * 1000;
const HISTORY_PERSIST_DEBOUNCE_MS = 1200;
const SOC_HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000;
const SOC_HISTORY_MAX_POINTS = 500;
const SOC_SAMPLE_MIN_INTERVAL_MS = 4000;

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
  nominalCapacities: loadNominalCapacities(),
  scanAllDevicesNext: false,
  renderTimer: null,
  installPrompt: null,
  unsupportedReason: "",
  uiHideTimer: null,
  smoothedDischargeA: null,
  displayedEstimateMin: null,
  peakDischargeA: null,
  socHistory: [],
  lastSocSampleAt: 0,
  dischargeHistoryByDevice: loadDischargeHistory(),
  historyPersistTimer: null
};

const el = {
  connectBtn: document.getElementById("connectBtn"),
  statusLine: document.getElementById("statusLine"),
  unsupportedBanner: document.getElementById("unsupportedBanner"),
  displayDeviceName: document.getElementById("displayDeviceName"),
  editDeviceNameBtn: document.getElementById("editDeviceNameBtn"),
  actions: document.getElementById("actions"),
  activeProtocol: document.getElementById("activeProtocol"),
  deviceName: document.getElementById("deviceName"),
  packVoltage: document.getElementById("packVoltage"),
  currentWithPeak: document.getElementById("currentWithPeak"),
  socPercent: document.getElementById("socPercent"),
  capacityRemaining: document.getElementById("capacityRemaining"),
  nominalCapacityAhInput: document.getElementById("nominalCapacityAhInput"),
  temperature: document.getElementById("temperature"),
  estTimeLeft: document.getElementById("estTimeLeft"),
  statusText: document.getElementById("statusText"),
  cycleCount: document.getElementById("cycleCount"),
  signalRssi: document.getElementById("signalRssi"),
  lastUpdate: document.getElementById("lastUpdate"),
  cells: document.getElementById("cells"),
  statusFlags: document.getElementById("statusFlags"),
  rawFrame: document.getElementById("rawFrame"),
  socSparkline: document.getElementById("socSparkline"),
  resetStatsBtn: document.getElementById("resetStatsBtn"),
  themeBtn: document.getElementById("themeBtn"),
  installBtn: document.getElementById("installBtn"),
  details: document.querySelector(".details")
};

init();

function init() {
  initTheme();
  initInstallPrompt();
  initServiceWorker();
  initAuxUiDimming();

  el.connectBtn.addEventListener("click", onConnectToggle);
  el.editDeviceNameBtn.addEventListener("click", editLocalDeviceName);
  el.nominalCapacityAhInput?.addEventListener("change", onNominalCapacityInputCommit);
  el.nominalCapacityAhInput?.addEventListener("blur", onNominalCapacityInputCommit);
  el.nominalCapacityAhInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onNominalCapacityInputCommit();
      el.nominalCapacityAhInput.blur();
    }
  });
  el.resetStatsBtn?.addEventListener("click", resetStatsForActiveBattery);
  el.details?.addEventListener("toggle", () => {
    if (el.details.open) {
      document.body.classList.remove("ui-dimmed");
      clearAuxUiTimer();
      return;
    }
    showAuxUi();
  });

  const unsupportedReason = detectWebBluetoothSupportIssue();
  if (unsupportedReason) {
    showUnsupported(unsupportedReason);
  }

  state.renderTimer = window.setInterval(renderTelemetry, 1000);
  window.addEventListener("resize", drawSocSparkline, { passive: true });
  updateActionsAuxUiClass();
  showAuxUi();
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
  el.actions.classList.remove("is-connected");
  updateActionsAuxUiClass();
  showAuxUi();
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
    el.connectBtn.classList.add("is-connected");
    el.actions.classList.add("is-connected");
    updateActionsAuxUiClass();
    el.activeProtocol.textContent = selected.label;
    el.deviceName.textContent = normalizeDeviceName(device.name) || "Unnamed";
    refreshDisplayedDeviceName();
    refreshNominalCapacityInput();
    showAuxUi();
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
  state.smoothedDischargeA = null;
  state.displayedEstimateMin = null;
  state.peakDischargeA = null;
  state.socHistory = [];
  state.lastSocSampleAt = 0;
  drawSocSparkline();
  el.connectBtn.disabled = Boolean(state.unsupportedReason);
  el.connectBtn.textContent = "Connect";
  el.connectBtn.classList.remove("is-connected");
  el.actions.classList.remove("is-connected");
  updateActionsAuxUiClass();
  showAuxUi();
  el.activeProtocol.textContent = "-";
  el.deviceName.textContent = "-";
  refreshDisplayedDeviceName();
  refreshNominalCapacityInput();
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

  const estimatedTotalAh = estimateTotalCapacityAh(t.remainingCapacityAh, t.socPercent);
  const currentLimitA = estimateReasonableCurrentLimitA(estimatedTotalAh);
  setText(el.packVoltage, formatNumWithNarrowUnitSpace(t.packVoltageV, 2, "V", "--.-- V"));
  setText(el.currentWithPeak, formatCurrentWithPeak(t.currentA, currentLimitA));
  setText(el.socPercent, formatNumWithNarrowUnitSpace(t.socPercent, 0, "%", "-- %"));
  setText(el.capacityRemaining, formatCompactCapacityAh(t.remainingCapacityAh, t.socPercent));
  setText(el.temperature, formatNum(t.temperatureC, 1, "C", "--.- C"));
  updateDischargeHistoryModel(t, currentLimitA);
  setText(el.estTimeLeft, updateAndFormatTimeLeftEstimate(t, currentLimitA));
  setText(el.statusText, formatStatusText(t.statusText));
  recordSocSample(t);
  drawSocSparkline();
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

function formatNumWithNarrowUnitSpace(value, decimals, unit, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return `${value.toFixed(decimals)}\u2009${unit}`;
}

function updateAndGetPeakDischargeCurrent(currentA, maxAllowedA = MAX_REASONABLE_CURRENT_A) {
  const limit = Number.isFinite(maxAllowedA) && maxAllowedA > 0 ? maxAllowedA : MAX_REASONABLE_CURRENT_A;
  if (Number.isFinite(state.peakDischargeA) && state.peakDischargeA > limit) {
    state.peakDischargeA = null;
  }

  const now = normalizeCurrentA(currentA, limit);
  if (Number.isFinite(now) && now < -0.2) {
    const dischargeA = Math.abs(now);
    if (!Number.isFinite(state.peakDischargeA) || dischargeA > state.peakDischargeA) {
      state.peakDischargeA = dischargeA;
    }
  }
  return Number.isFinite(state.peakDischargeA) ? state.peakDischargeA : null;
}

function formatCurrentWithPeak(currentA, maxAllowedA = MAX_REASONABLE_CURRENT_A) {
  const now = normalizeCurrentA(currentA, maxAllowedA);
  const peak = updateAndGetPeakDischargeCurrent(now, maxAllowedA);
  const nowText = Number.isFinite(now) ? `${now.toFixed(2)} A` : "--.-- A";
  const peakText = Number.isFinite(peak) ? `${peak.toFixed(2)} A` : "--.-- A";
  return `${nowText} (\u2191 ${peakText})`;
}

function formatCompactCapacityAh(remainingAh, socPercent) {
  const totalAh = estimateTotalCapacityAh(remainingAh, socPercent);
  if (Number.isFinite(totalAh) && totalAh > 0) return `${totalAh.toFixed(1)} Ah`;
  if (Number.isFinite(remainingAh)) return `${remainingAh.toFixed(1)} Ah`;
  return "--.- Ah";
}

function formatStatusText(value) {
  if (!value) return "Unknown";
  const text = String(value).trim();
  if (!text) return "Unknown";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function updateAndFormatTimeLeftEstimate(t, maxAllowedA = MAX_REASONABLE_CURRENT_A) {
  const currentA = normalizeCurrentA(t?.currentA, maxAllowedA);
  const remainingAh = Number(t?.remainingCapacityAh);
  const socPercent = Number(t?.socPercent);
  if (!Number.isFinite(currentA)) {
    if (Number.isFinite(state.displayedEstimateMin)) return formatDuration(state.displayedEstimateMin);
    return "-";
  }

  if (currentA >= -0.2) {
    // Keep output explicit when not discharging.
    if (currentA > 0.2) return "Charging";
    if (Number.isFinite(state.displayedEstimateMin)) {
      return formatDuration(state.displayedEstimateMin);
    }
    return "-";
  }

  const dischargeA = Math.abs(currentA);
  if (dischargeA >= ESTIMATE_DISCHARGE_THRESHOLD_A) {
    if (!Number.isFinite(state.smoothedDischargeA)) {
      state.smoothedDischargeA = dischargeA;
    } else {
      state.smoothedDischargeA = (
        state.smoothedDischargeA * (1 - ESTIMATE_SMOOTHING_ALPHA)
        + dischargeA * ESTIMATE_SMOOTHING_ALPHA
      );
    }
  }

  const instantMinutes = (
    Number.isFinite(remainingAh)
    && remainingAh > 0
    && Number.isFinite(state.smoothedDischargeA)
    && state.smoothedDischargeA > 0
  )
    ? (remainingAh / state.smoothedDischargeA) * 60
    : null;
  const historicalMinutes = getHistoricalEtaMinutes(socPercent);
  const rawMinutes = blendEtaMinutes(instantMinutes, historicalMinutes);

  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) {
    if (Number.isFinite(state.displayedEstimateMin)) {
      return formatDuration(state.displayedEstimateMin);
    }
    return "Calculating...";
  }

  const rounded = roundToStep(clamp(rawMinutes, 1, 99 * 60 + 59), ESTIMATE_STEP_MIN);
  if (!Number.isFinite(state.displayedEstimateMin)) {
    state.displayedEstimateMin = rounded;
  } else if (Math.abs(rounded - state.displayedEstimateMin) >= ESTIMATE_HYSTERESIS_MIN) {
    state.displayedEstimateMin = rounded;
  }

  return formatDuration(state.displayedEstimateMin);
}

function roundToStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "0m";
  const minutes = Math.round(totalMinutes);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

function getActiveHistoryModel() {
  const key = getHistoryStorageKey(state.device);
  if (!key) return null;
  if (!state.dischargeHistoryByDevice[key]) {
    state.dischargeHistoryByDevice[key] = {
      ewmaDischargeA: null,
      ewmaSocDropPctPerHour: null,
      sampleCount: 0,
      lastPoint: null
    };
  }
  return state.dischargeHistoryByDevice[key];
}

function updateDischargeHistoryModel(t, maxAllowedA = MAX_REASONABLE_CURRENT_A) {
  const model = getActiveHistoryModel();
  if (!model) return;

  const now = Number(t?.timestamp) || Date.now();
  const currentA = normalizeCurrentA(t?.currentA, maxAllowedA);
  const soc = Number(t?.socPercent);
  const remainingAh = Number(t?.remainingCapacityAh);

  const discharging = Number.isFinite(currentA) && currentA < -ESTIMATE_DISCHARGE_THRESHOLD_A;
  if (discharging) {
    const dischargeA = Math.abs(currentA);
    if (!Number.isFinite(model.ewmaDischargeA)) {
      model.ewmaDischargeA = dischargeA;
    } else {
      model.ewmaDischargeA = (
        model.ewmaDischargeA * (1 - HISTORY_CURRENT_ALPHA)
        + dischargeA * HISTORY_CURRENT_ALPHA
      );
    }
  }

  const prev = model.lastPoint;
  if (
    prev
    && Number.isFinite(prev.ts)
    && Number.isFinite(prev.soc)
    && Number.isFinite(soc)
    && Number.isFinite(prev.currentA)
    && Number.isFinite(currentA)
    && prev.currentA < -ESTIMATE_DISCHARGE_THRESHOLD_A
    && currentA < -ESTIMATE_DISCHARGE_THRESHOLD_A
  ) {
    const dtMs = now - prev.ts;
    if (dtMs >= HISTORY_MIN_DT_MS && dtMs <= HISTORY_MAX_DT_MS) {
      const dSoc = prev.soc - soc;
      if (dSoc > 0) {
        const ratePctPerHour = dSoc / (dtMs / (60 * 60 * 1000));
        if (Number.isFinite(ratePctPerHour) && ratePctPerHour > 0.02 && ratePctPerHour < 60) {
          if (!Number.isFinite(model.ewmaSocDropPctPerHour)) {
            model.ewmaSocDropPctPerHour = ratePctPerHour;
          } else {
            model.ewmaSocDropPctPerHour = (
              model.ewmaSocDropPctPerHour * (1 - HISTORY_SOC_RATE_ALPHA)
              + ratePctPerHour * HISTORY_SOC_RATE_ALPHA
            );
          }
          model.sampleCount = Number(model.sampleCount || 0) + 1;
        }
      }
    }
  }

  model.lastPoint = {
    ts: now,
    soc: Number.isFinite(soc) ? soc : null,
    remainingAh: Number.isFinite(remainingAh) ? remainingAh : null,
    currentA: Number.isFinite(currentA) ? currentA : null
  };
  schedulePersistDischargeHistory();
}

function getHistoricalEtaMinutes(socPercent) {
  const model = getActiveHistoryModel();
  if (!model || !Number.isFinite(socPercent) || socPercent <= 0) return null;
  const rate = Number(model.ewmaSocDropPctPerHour);
  if (!Number.isFinite(rate) || rate <= 0.01) return null;
  return (socPercent / rate) * 60;
}

function blendEtaMinutes(instantMinutes, historicalMinutes) {
  const hasInstant = Number.isFinite(instantMinutes) && instantMinutes > 0;
  const hasHistorical = Number.isFinite(historicalMinutes) && historicalMinutes > 0;
  if (hasInstant && !hasHistorical) return instantMinutes;
  if (!hasInstant && hasHistorical) return historicalMinutes;
  if (!hasInstant && !hasHistorical) return null;

  const model = getActiveHistoryModel();
  const sampleCount = Number(model?.sampleCount || 0);
  const histWeight = clamp(sampleCount / 30, 0, 0.6);
  return instantMinutes * (1 - histWeight) + historicalMinutes * histWeight;
}

function schedulePersistDischargeHistory() {
  if (state.historyPersistTimer) return;
  state.historyPersistTimer = window.setTimeout(() => {
    state.historyPersistTimer = null;
    persistDischargeHistory(state.dischargeHistoryByDevice);
  }, HISTORY_PERSIST_DEBOUNCE_MS);
}

function loadDischargeHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (_err) {
    return {};
  }
}

function persistDischargeHistory(history) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch (_err) {
    // ignore storage failures
  }
}

function resetStatsForActiveBattery() {
  state.smoothedDischargeA = null;
  state.displayedEstimateMin = null;
  state.peakDischargeA = null;
  state.socHistory = [];
  state.lastSocSampleAt = 0;
  drawSocSparkline();

  const historyKey = getHistoryStorageKey(state.device);
  if (historyKey && state.dischargeHistoryByDevice[historyKey]) {
    delete state.dischargeHistoryByDevice[historyKey];
    persistDischargeHistory(state.dischargeHistoryByDevice);
    setStatus("Stats reset for this battery (including saved history).");
    return;
  }
  setStatus("Session stats reset.");
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

function getHistoryStorageKey(device) {
  if (!device || !device.id) return "";
  return `id:${device.id}`;
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

function onNominalCapacityInputCommit() {
  if (!state.device || !el.nominalCapacityAhInput) return;
  const raw = el.nominalCapacityAhInput.value.trim();
  if (!raw) {
    setNominalCapacityForDevice(state.device, null);
    refreshNominalCapacityInput();
    setStatus("Cleared nominal capacity override for this battery.");
    return;
  }

  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) {
    refreshNominalCapacityInput();
    setStatus("Nominal capacity must be a positive number (Ah).", true);
    return;
  }
  setNominalCapacityForDevice(state.device, value);
  refreshNominalCapacityInput();
  setStatus("Saved nominal capacity for this battery.");
}

function refreshNominalCapacityInput() {
  if (!el.nominalCapacityAhInput) return;
  if (!state.device) {
    el.nominalCapacityAhInput.value = "";
    el.nominalCapacityAhInput.disabled = true;
    return;
  }
  el.nominalCapacityAhInput.disabled = false;
  const configured = getNominalCapacityForDevice(state.device);
  el.nominalCapacityAhInput.value = Number.isFinite(configured) ? configured.toFixed(1) : "";
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

function loadNominalCapacities() {
  try {
    const raw = localStorage.getItem(NOMINAL_CAPACITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (_err) {
    return {};
  }
}

function persistNominalCapacities(values) {
  try {
    localStorage.setItem(NOMINAL_CAPACITY_STORAGE_KEY, JSON.stringify(values));
  } catch (_err) {
    // ignore storage failures
  }
}

function getNominalCapacityForDevice(device) {
  const key = getDeviceStorageKey(device);
  if (!key) return null;
  const value = Number(state.nominalCapacities[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function setNominalCapacityForDevice(device, value) {
  const key = getDeviceStorageKey(device);
  if (!key) return;
  if (!Number.isFinite(value) || value <= 0) {
    delete state.nominalCapacities[key];
  } else {
    state.nominalCapacities[key] = Number(value.toFixed(2));
  }
  persistNominalCapacities(state.nominalCapacities);
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
    drawSocSparkline();
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
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then((registration) => {
      const onUpdateFound = () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      };

      registration.addEventListener("updatefound", onUpdateFound);
      onUpdateFound();

      let reloadedForNewSw = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadedForNewSw) return;
        reloadedForNewSw = true;
        window.location.reload();
      });

      window.setInterval(() => {
        registration.update().catch(() => {
          // ignore update check failures
        });
      }, 60 * 1000);

      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          registration.update().catch(() => {
            // ignore update check failures
          });
        }
      });
    })
    .catch(() => {
      // keep app usable without SW
    });
}

function initAuxUiDimming() {
  document.addEventListener("pointerdown", showAuxUi, { passive: true });
  document.addEventListener("keydown", showAuxUi);
  document.addEventListener("focusin", showAuxUi);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearAuxUiTimer();
      return;
    }
    showAuxUi();
  });
}

function clearAuxUiTimer() {
  if (state.uiHideTimer) {
    window.clearTimeout(state.uiHideTimer);
    state.uiHideTimer = null;
  }
}

function showAuxUi() {
  document.body.classList.remove("ui-dimmed");
  clearAuxUiTimer();
  if (!isConnected() || el.details?.open) return;
  state.uiHideTimer = window.setTimeout(() => {
    if (el.details?.open) return;
    document.body.classList.add("ui-dimmed");
  }, AUX_UI_VISIBLE_MS);
}

function updateActionsAuxUiClass() {
  el.actions.classList.toggle("aux-ui", isConnected());
}

function isConnected() {
  return Boolean(state.server?.connected || state.device?.gatt?.connected);
}

function normalizeCurrentA(value, maxAllowedA = MAX_REASONABLE_CURRENT_A) {
  const currentA = Number(value);
  if (!Number.isFinite(currentA)) return null;
  const limit = Number.isFinite(maxAllowedA) && maxAllowedA > 0 ? maxAllowedA : MAX_REASONABLE_CURRENT_A;
  if (Math.abs(currentA) > limit) return null;
  return currentA;
}

function estimateTotalCapacityAh(remainingAh, socPercent, device = state.device) {
  const configured = getNominalCapacityForDevice(device);
  if (Number.isFinite(configured) && configured > 0) return configured;
  if (Number.isFinite(remainingAh) && Number.isFinite(socPercent) && socPercent > 0) {
    const totalAh = remainingAh / (socPercent / 100);
    if (Number.isFinite(totalAh) && totalAh > 0) return totalAh;
  }
  return null;
}

function estimateReasonableCurrentLimitA(totalAh) {
  if (!Number.isFinite(totalAh) || totalAh <= 0) return MAX_REASONABLE_CURRENT_A;
  // Practical limit for these battery types: allow up to ~8C with a sane floor/ceiling.
  return clamp(totalAh * 8, 25, MAX_REASONABLE_CURRENT_A);
}

function recordSocSample(t) {
  const soc = Number(t?.socPercent);
  if (!Number.isFinite(soc)) return;
  const ts = Number(t?.timestamp) || Date.now();
  if (state.lastSocSampleAt && ts - state.lastSocSampleAt < SOC_SAMPLE_MIN_INTERVAL_MS) return;
  state.lastSocSampleAt = ts;

  state.socHistory.push({
    ts,
    soc: clamp(soc, 0, 100)
  });
  pruneSocHistory(ts);
}

function pruneSocHistory(nowTs = Date.now()) {
  const minTs = nowTs - SOC_HISTORY_WINDOW_MS;
  state.socHistory = state.socHistory.filter((point) => point.ts >= minTs);
  if (state.socHistory.length > SOC_HISTORY_MAX_POINTS) {
    state.socHistory = state.socHistory.slice(-SOC_HISTORY_MAX_POINTS);
  }
}

function drawSocSparkline() {
  const canvas = el.socSparkline;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (!width || !height) return;

  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const targetW = width * dpr;
  const targetH = height * dpr;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = state.socHistory;
  if (!points.length) return;

  const padX = 8;
  const padY = 8;
  const plotW = Math.max(1, width - padX * 2);
  const plotH = Math.max(1, height - padY * 2);

  const firstTs = points[0].ts;
  const lastTs = points[points.length - 1].ts;
  const spanMs = Math.max(1000, lastTs - firstTs);

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0f766e";
  const coords = points.map((point) => ({
    x: padX + ((point.ts - firstTs) / spanMs) * plotW,
    y: padY + ((100 - point.soc) / 100) * plotH
  }));
  if (!coords.length) return;

  ctx.lineWidth = 3.2;
  ctx.globalAlpha = 0.72;
  ctx.strokeStyle = accent;
  if (coords.length === 1) {
    ctx.beginPath();
    ctx.arc(coords[0].x, coords[0].y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length; i += 1) {
    ctx.lineTo(coords[i].x, coords[i].y);
  }
  ctx.stroke();

  // Fill below curve with a vertical fade: stronger near the line, fading toward bottom.
  ctx.globalAlpha = 1;
  const fillPath = new Path2D();
  fillPath.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length; i += 1) {
    fillPath.lineTo(coords[i].x, coords[i].y);
  }
  fillPath.lineTo(padX + plotW, padY + plotH);
  fillPath.lineTo(padX, padY + plotH);
  fillPath.closePath();
  const gradient = ctx.createLinearGradient(0, padY, 0, padY + plotH);
  gradient.addColorStop(0, toRgba(accent, 0.42));
  gradient.addColorStop(0.45, toRgba(accent, 0.22));
  gradient.addColorStop(1, toRgba(accent, 0));
  ctx.fillStyle = gradient;
  ctx.fill(fillPath);
  ctx.globalAlpha = 1;
}

function toRgba(color, alpha) {
  if (!color) return `rgba(15, 118, 110, ${alpha})`;
  const c = color.trim();
  if (c.startsWith("#")) {
    let hex = c.slice(1);
    if (hex.length === 3) {
      hex = hex.split("").map((ch) => ch + ch).join("");
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }
  const rgbMatch = c.match(/^rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  return c;
}
