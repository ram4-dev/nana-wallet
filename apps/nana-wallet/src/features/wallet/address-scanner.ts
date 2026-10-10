import { Capacitor } from "@capacitor/core";

/**
 * The Capacitor scan seam (design §8.3).
 *
 * A scanned address is untrusted input: it is validated by the card's own
 * canonical base58 pre-check and then re-validated by
 * `POST /v1/contact-actions/:id/address`. Nothing here decides that an address
 * is acceptable.
 *
 * The barcode plugin is resolved from the Capacitor plugin registry rather than
 * imported, because this package does not depend on a scanner plugin: importing
 * one would add a native dependency to a build that has no native scanner
 * configured, and an unavailable plugin must be an honest `unavailable` rather
 * than a crash or a silently missing button. Installing the plugin is what makes
 * the scan path live; until then the paste path is the review channel's route.
 */
export type AddressScanResult =
  { status: "scanned"; address: string } | { status: "cancelled" } | { status: "unavailable" };

type BarcodeScannerPlugin = {
  scan?: () => Promise<{ barcodes?: Array<{ rawValue?: unknown }> }>;
};

/** `true` only inside a native shell: the scan button is not offered on the web. */
export function canScanAddress(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function scanAddressWithCapacitor(): Promise<AddressScanResult> {
  if (!canScanAddress()) return { status: "unavailable" };
  const plugin = (
    globalThis as {
      Capacitor?: { Plugins?: Record<string, unknown> };
    }
  ).Capacitor?.Plugins?.["BarcodeScanner"] as BarcodeScannerPlugin | undefined;
  if (!plugin || typeof plugin.scan !== "function") return { status: "unavailable" };
  const result = await plugin.scan();
  const raw = result?.barcodes?.[0]?.rawValue;
  if (typeof raw !== "string" || raw.trim().length === 0) return { status: "cancelled" };
  return { status: "scanned", address: raw.trim() };
}
