import type { ProxyOptions } from "vite";

/** Mantiene el mismo contrato de rutas que docker/nginx.conf. */
export function developmentProxies(
  environment: Record<string, string | undefined>,
): Record<string, ProxyOptions> {
  const proxies: Record<string, ProxyOptions> = {};
  for (const [prefix, name] of [
    ["/api", "NANA_API_PROXY_TARGET"],
    ["/livekit", "NANA_LIVEKIT_PROXY_TARGET"],
  ] as const) {
    const target = environment[name];
    if (!target) continue;
    const url = new URL(target);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${name} debe ser una URL HTTP local sin credenciales.`);
    }
    proxies[`^${prefix}(?:/|\\?|$)`] = {
      target,
      changeOrigin: true,
      ws: prefix === "/livekit",
      rewrite: (path) => path.slice(prefix.length) || "/",
    };
  }
  return proxies;
}
