import { afterEach, describe, expect, it, vi } from "vitest";

const capacitor = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => false) }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => capacitor.isNativePlatform() },
}));

import { canScanAddress, scanAddressWithCapacitor } from "./address-scanner";

/**
 * The scan seam resolves a plugin this package does not depend on, so what must
 * be pinned is the honest degradation: outside a native shell, or without an
 * installed scanner, the answer is `unavailable` — never a fabricated address.
 */
const globals = globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } };
const original = globals.Capacitor;

afterEach(() => {
  capacitor.isNativePlatform.mockReset().mockReturnValue(false);
  if (original === undefined) delete globals.Capacitor;
  else globals.Capacitor = original;
});

describe("address scanner", () => {
  it("reports the web platform as unscannable", async () => {
    // jsdom is not a native shell: this is the real degradation path, not a stub.
    expect(canScanAddress()).toBe(false);
    expect(await scanAddressWithCapacitor()).toEqual({ status: "unavailable" });
  });

  it("stays unavailable in a native shell that has no scanner plugin", async () => {
    capacitor.isNativePlatform.mockReturnValue(true);
    expect(canScanAddress()).toBe(true);
    globals.Capacitor = { Plugins: {} };
    expect(await scanAddressWithCapacitor()).toEqual({ status: "unavailable" });
    // A plugin object without `scan` is not a scanner either.
    globals.Capacitor = { Plugins: { BarcodeScanner: {} } };
    expect(await scanAddressWithCapacitor()).toEqual({ status: "unavailable" });
  });

  it("returns the trimmed barcode value and reports a cancelled scan", async () => {
    capacitor.isNativePlatform.mockReturnValue(true);
    const scan = vi.fn().mockResolvedValue({
      barcodes: [{ rawValue: "  9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM  " }],
    });
    globals.Capacitor = { Plugins: { BarcodeScanner: { scan } } };
    expect(await scanAddressWithCapacitor()).toEqual({
      status: "scanned",
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    });

    scan.mockResolvedValue({ barcodes: [{ rawValue: "   " }] });
    expect(await scanAddressWithCapacitor()).toEqual({ status: "cancelled" });
    scan.mockResolvedValue({});
    expect(await scanAddressWithCapacitor()).toEqual({ status: "cancelled" });
  });
});
