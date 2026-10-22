import { describe, expect, it } from "vitest";
import { developmentProxies } from "../../dev-proxy";

describe("proxy del stack local", () => {
  it("no cambia el desarrollo normal cuando no se configura el stack", () => {
    expect(developmentProxies({})).toEqual({});
  });

  it("conserva rutas y query strings de API y señalización WebSocket", () => {
    const proxies = developmentProxies({
      NANA_API_PROXY_TARGET: "http://127.0.0.1:3100",
      NANA_LIVEKIT_PROXY_TARGET: "http://127.0.0.1:7882",
    });
    const apiKey = Object.keys(proxies).find((key) =>
      new RegExp(key).test("/api/v1/live-bindings"),
    )!;
    const livekitKey = Object.keys(proxies).find((key) => new RegExp(key).test("/livekit/rtc"))!;
    expect(new RegExp(apiKey).test("/apiary")).toBe(false);
    expect(proxies[apiKey]?.rewrite?.("/api/v1/me?x=1")).toBe("/v1/me?x=1");
    expect(proxies[apiKey]?.rewrite?.("/api")).toBe("/");
    expect(proxies[livekitKey]?.rewrite?.("/livekit/rtc?access_token=test")).toBe(
      "/rtc?access_token=test",
    );
    expect(proxies[livekitKey]?.ws).toBe(true);
  });

  it.each([
    "https://127.0.0.1:3000",
    "http://example.com",
    "http://user:secret@localhost:3000",
    "http://localhost:3000/api",
  ])("rechaza targets externos o con configuración ambigua: %s", (target) => {
    expect(() => developmentProxies({ NANA_API_PROXY_TARGET: target })).toThrow(
      "NANA_API_PROXY_TARGET",
    );
  });
});
