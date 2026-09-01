import { loadConfig, ensureDevice } from "./config";
import { httpCall } from "./httpClient";

export interface PromoCode {
  id: string;
  code: string;
}

export interface Promotion {
  id: string;
  name: string;
  divisor: number;
  codes: PromoCode[];
}

export interface DeviceStatus {
  device: { id: string; name: string; hostname: string | null; firstSeen: string; lastSeen: string };
  seen: boolean;
  lastDataAt: string | null;
  totalCost: number;
  billing: { totalPaid: number; entries: Array<{ invoiceId: string; date: string; amount: number; status: string }> };
  hasClient: boolean;
  currentPromoCodeId: string | null;
  promotions: Promotion[];
}

/* Equivalent scope-appareil de device.html, via /api/device-status (cle API
   de sync) plutot que le view_token public — jamais le nom du client, comme
   partout ailleurs dans le projet. */
export async function fetchDeviceStatus(): Promise<DeviceStatus | null> {
  const config = loadConfig();
  if (!config || !config.url || !config.apiKey) return null;
  const device = ensureDevice();
  const base = config.url.replace(/\/$/, "");
  try {
    const { status, body } = await httpCall("GET", `${base}/api/device-status/${encodeURIComponent(device.id)}`, config.apiKey, undefined, 15000);
    if (status !== 200) return null;
    return body as DeviceStatus;
  } catch (e) {
    return null;
  }
}
