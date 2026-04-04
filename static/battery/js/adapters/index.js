import { asciiFfe4Adapter } from "./ascii-ffe4.js";
import { jkBleJk02Adapter } from "./jk-ble-jk02.js";

export const adapters = [asciiFfe4Adapter, jkBleJk02Adapter];

export function getAllServiceUuids() {
  const out = new Set();
  for (const adapter of adapters) {
    for (const uuid of adapter.serviceUuids || []) out.add(uuid);
  }
  return [...out];
}
