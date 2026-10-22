#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import https from "node:https";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://nana-privy.localhost";
const project = "nana-dev-stack";
const vaultKeys = [
  "PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_AUTHORIZATION_PRIVATE_KEY",
  "PRIVY_AUTHORIZATION_PUBLIC_KEY", "PRIVY_AUTHORIZATION_KEY_QUORUM_ID",
  "NANA_SUPABASE_URL", "SUPABASE_PASSWORD_NANA_WALLET", "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET", "OPEN_AI_API_KEY", "OPENCODE_GO_API_KEY",
];

export const requiredVaultKeys = [...vaultKeys];

function fail(message) { throw new Error(message); }

function run(command, args, env = process.env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} no pudo completar ${args[0] ?? "la operación"}. No se muestran detalles que puedan contener secretos.`);
  }
  return result.stdout?.trim() ?? "";
}

export function normalizeAuthorizationKey(value) {
  return value?.trim().replace(/^wallet-auth:/u, "") ?? "";
}

export function parseProjectRef(supabaseUrl) {
  try {
    const host = new URL(supabaseUrl).hostname;
    const match = /^([a-z0-9]{20})\.supabase\.co$/u.exec(host);
    if (!match) fail("NANA_SUPABASE_URL no identifica un proyecto Supabase válido.");
    return match[1];
  } catch (error) {
    if (error instanceof Error && error.message.includes("NANA_SUPABASE_URL")) throw error;
    fail("NANA_SUPABASE_URL no es una URL válida.");
  }
}

export function remoteDatabaseUrl(poolerUrl, password, projectRef) {
  let parsed;
  try { parsed = new URL(poolerUrl); } catch { fail("La metadata del pooler de Supabase no es una URL válida."); }
  if (!/^postgres(?:ql)?:$/u.test(parsed.protocol) || !parsed.hostname.endsWith(".pooler.supabase.com")) {
    fail("La metadata no apunta al pooler remoto de Supabase.");
  }
  if (parsed.username !== `postgres.${projectRef}` || parsed.password) {
    fail("La metadata del pooler no coincide con el proyecto Supabase linkeado.");
  }
  if (!password?.trim()) fail("Falta SUPABASE_PASSWORD_NANA_WALLET.");
  parsed.password = password;
  parsed.searchParams.set("sslmode", "verify-full");
  parsed.searchParams.set("sslrootcert", "/run/certs/supabase-ca.crt");
  return parsed.toString();
}

function commonRoot(repo) {
  const gitDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], process.env);
  return dirname(gitDir);
}

export function readLinkedSupabaseMetadata(repo = sourceRoot, common = commonRoot(repo)) {
  for (const candidate of [repo, common]) {
    const temp = resolve(candidate, "supabase/.temp");
    const ref = resolve(temp, "project-ref");
    const pooler = resolve(temp, "pooler-url");
    if (existsSync(ref) && existsSync(pooler)) {
      return { ref: readFileSync(ref, "utf8").trim(), poolerUrl: readFileSync(pooler, "utf8").trim() };
    }
  }
  fail("No se encontró la metadata linkeada de Supabase (supabase/.temp). Ejecutá `supabase link` para Nana Wallet.");
}

export function verifySupabaseTarget(env, metadata) {
  const ref = parseProjectRef(env.NANA_SUPABASE_URL ?? "");
  if (metadata.ref !== ref) fail("El proyecto Supabase linkeado no coincide con NANA_SUPABASE_URL.");
  return remoteDatabaseUrl(metadata.poolerUrl, env.SUPABASE_PASSWORD_NANA_WALLET, ref);
}

function stateDirectory(repo = sourceRoot) { return resolve(commonRoot(repo), ".cache/dev-stack"); }
function writeRestricted(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function ensureBindingPair(state) {
  const privatePath = resolve(state, "live-binding-private.pem");
  const publicPath = resolve(state, "live-binding-public.pem");
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    const pair = generateKeyPairSync("ed25519");
    writeRestricted(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    writeRestricted(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  }
  return { privateKey: readFileSync(privatePath, "utf8"), publicKey: readFileSync(publicPath, "utf8") };
}

async function fetchVerificationBundle(appId) {
  const response = await fetch(`https://api.privy.io/v1/apps/${encodeURIComponent(appId)}/jwks.json`);
  if (!response.ok) fail("No se pudieron obtener las claves públicas de verificación de Privy.");
  const payload = await response.json();
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  const pem = keys.filter(key => key.kty === "EC" && key.crv === "P-256" && key.alg === "ES256")
    .map(key => createPublicKey({ key, format: "jwk" }).export({ type: "spki", format: "pem" }).toString());
  if (!pem.length) fail("Privy no devolvió claves ES256 de verificación.");
  return pem.join("\n");
}

async function ensureDatabaseCertificate(state) {
  const path = resolve(state, "supabase-ca.crt");
  if (!existsSync(path)) {
    const response = await fetch("https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) fail("No se pudo descargar el certificado público de Supabase.");
    writeFileSync(path, await response.text(), { mode: 0o644 });
  }
  const certificate = new X509Certificate(readFileSync(path));
  if (!certificate.ca || Date.parse(certificate.validTo) <= Date.now()) fail("La CA de Supabase no es válida o está vencida.");
  return path;
}

function composeArgs() {
  return ["compose", "--env-file", "/dev/null", "--project-directory", sourceRoot, "-p", project, "-f", resolve(sourceRoot, "docker/compose.dev-stack.yaml")];
}

function compose(env, args) { return run("docker", [...composeArgs(), ...args], env); }

function composePort(env, service, containerPort) {
  const output = compose(env, ["port", service, String(containerPort)]);
  const match = /:(\d+)\s*$/u.exec(output);
  if (!match) fail(`Docker no publicó el puerto de ${service}.`);
  return Number(match[1]);
}

function assertSignerNamespaces(env) {
  for (const [consumer, sidecar] of [["backend", "backend-signer"], ["voice-worker", "voice-worker-signer"]]) {
    const consumerNamespace = compose(env, ["exec", "-T", consumer, "readlink", "/proc/self/ns/net"]);
    const signerNamespace = compose(env, ["exec", "-T", sidecar, "readlink", "/proc/self/ns/net"]);
    if (consumerNamespace !== signerNamespace) fail(`El sidecar ${sidecar} no comparte la red de ${consumer}.`);
  }
}

function livekitConfig(start) {
  return `port: 7880\nrtc:\n  udp_port: "${start}-${start + 10}"\n  tcp_port: ${start}\n  use_external_ip: false\n  node_ip: "127.0.0.1"\n  advertise_internal_ip: true\n`;
}

async function checkPortless() {
  const state = resolve(process.env.HOME ?? "", ".portless");
  const portFile = resolve(state, "proxy.port");
  const pidFile = resolve(state, "proxy.pid");
  let running = false;
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); running = true; } catch (error) { running = error.code === "EPERM"; }
    }
  }
  if (!running) {
    console.log("Iniciando Portless HTTPS/443; macOS puede pedir autorización de administrador…");
    if (process.platform === "darwin") {
      const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
      const command = ["env", `SUDO_USER=${userInfo().username}`, `SUDO_UID=${process.getuid()}`, `SUDO_GID=${process.getgid()}`, process.execPath,
        run("which", ["portless"]), "proxy", "start", "--port", "443", "--https"].map(quote).join(" ");
      run("osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges with prompt "Iniciar Nana Wallet con Portless HTTPS en el puerto 443."`]);
    } else {
      run("portless", ["proxy", "start", "--port", "443", "--https"], process.env, { stdio: "inherit" });
    }
  }
  const port = existsSync(portFile) ? readFileSync(portFile, "utf8").trim() : "";
  const tlsFile = resolve(state, "proxy.tls");
  if (port !== "443" || !existsSync(tlsFile) || readFileSync(tlsFile, "utf8").trim() !== "1") {
    fail("Portless debe estar en HTTPS/443. No se modifica otro proxy activo: usá `portless proxy stop` y `portless proxy start --port 443 --https`.");
  }
  await request(origin); // 404 without an app route is valid; TLS and listener must work.
}

function ensureDocker() {
  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { cwd: sourceRoot, encoding: "utf8", stdio: "pipe" });
  if (probe.status === 0) return;
  if (process.platform === "darwin" && spawnSync("which", ["colima"], { stdio: "ignore" }).status === 0) {
    run("colima", ["start"]);
    run("docker", ["info", "--format", "{{.ServerVersion}}"]); return;
  }
  fail("Docker no está disponible. Iniciá Docker Desktop o Colima y reintentá.");
}

function routeOwnedByLauncher(state) {
  const pidPath = resolve(state, "frontend.pid");
  if (!existsSync(pidPath)) return false;
  const pid = Number(readFileSync(pidPath, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    const command = run("ps", ["-p", String(pid), "-o", "command="]);
    return command.includes("portless") && /(?:^|\s)nana-privy(?:\s|$)/u.test(command);
  } catch { return false; }
}

async function startFrontend(env, state, apiPort, livekitPort) {
  const routes = run("portless", ["list"]);
  const frontendState = resolve(state, "frontend.json");
  if (routes.includes("nana-privy.localhost") && !routeOwnedByLauncher(state)) {
    fail("La ruta nana-privy.localhost ya pertenece a otro proceso. Detenelo antes de iniciar el stack.");
  }
  if (routeOwnedByLauncher(state) && existsSync(frontendState)) {
    try {
      const prior = JSON.parse(readFileSync(frontendState, "utf8"));
      if (prior.apiPort === apiPort && prior.livekitPort === livekitPort && prior.sourceRoot === sourceRoot) return;
    } catch { /* restart a malformed owned state */ }
    const pid = Number(readFileSync(resolve(state, "frontend.pid"), "utf8"));
    try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
    await waitFor(async () => {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
      fail("El frontend anterior todavía se está cerrando.");
    }, "cierre del frontend anterior", 20);
  }
  const frontendEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    NANA_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    NANA_LIVEKIT_PROXY_TARGET: `http://127.0.0.1:${livekitPort}`,
    VITE_API_URL: "/api",
    VITE_AGENT_BACKEND: "1",
    VITE_E2E_REAL_BACKEND: "1",
    VITE_LIVEKIT_TOKEN_SOURCE: "local",
    VITE_PRIVY_APP_ID: env.PRIVY_APP_ID,
  };
  const child = spawn("portless", ["nana-privy", "npm", "run", "dev"], {
    cwd: resolve(sourceRoot, "apps/nana-wallet"), env: frontendEnv, detached: true, stdio: "ignore",
  });
  child.unref();
  writeRestricted(resolve(state, "frontend.pid"), String(child.pid));
  writeRestricted(frontendState, JSON.stringify({ apiPort, livekitPort, sourceRoot }));
}

function request(url, options = {}) {
  const ca = readFileSync(resolve(process.env.HOME ?? "", ".portless/ca.pem"));
  return new Promise((resolveRequest, reject) => {
    const req = https.request(url, { ca, rejectUnauthorized: true, ...options }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.once("end", () => resolveRequest({ statusCode: response.statusCode, body }));
    });
    req.once("error", reject); req.end(options.body);
    req.setTimeout(10_000, () => req.destroy(new Error("timeout HTTPS local")));
  });
}

async function waitFor(check, description, attempts = 40) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await check(); return; } catch (error) { last = error; await new Promise(resolveDelay => setTimeout(resolveDelay, 500)); }
  }
  fail(`No pasó la verificación de ${description}.${last instanceof Error ? ` ${last.message}` : ""}`);
}

async function checkWebSocket(env, livekitPort) {
  const { WebSocket } = await import("ws");
  const { AccessToken, RoomServiceClient } = await import("livekit-server-sdk");
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: `readiness-${randomBytes(6).toString("hex")}` });
  const room = `readiness-${randomBytes(6).toString("hex")}`;
  token.addGrant({ roomJoin: true, room });
  const accessToken = await token.toJwt();
  const ca = readFileSync(resolve(process.env.HOME ?? "", ".portless/ca.pem"));
  const rooms = new RoomServiceClient(`http://127.0.0.1:${livekitPort}`, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  try { await new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(`${origin.replace("https", "wss")}/livekit/rtc?access_token=${encodeURIComponent(accessToken)}`, { ca, rejectUnauthorized: true });
    const timeout = setTimeout(() => { socket.terminate(); rejectSocket(new Error("timeout WSS")); }, 8_000);
    socket.once("open", () => { clearTimeout(timeout); socket.close(); resolveSocket(); });
    socket.once("error", error => { clearTimeout(timeout); rejectSocket(error); });
  }); } finally { await rooms.deleteRoom(room).catch(() => undefined); }
}

export function validateInfrastructureHealth(payload) {
  const expectedDeferredProvider = payload?.mode === "live" && payload?.network === "solana-devnet" &&
    payload?.provider?.status === "degraded" && payload?.provider?.reason === "Privy wallet health is evaluated per authenticated user.";
  if (!expectedDeferredProvider || payload?.policySigner?.capable !== true || payload?.policySigner?.code !== "verified") {
    fail("La infraestructura Privy o el sidecar firmante no están listos; revisá `docker logs nana-dev-stack-backend-1`.");
  }
}

async function readiness(env, livekitPort) {
  await waitFor(async () => { if ((await request(origin)).statusCode !== 200) fail("frontend"); }, "frontend HTTPS");
  await waitFor(async () => { if ((await request(`${origin}/api/health`)).statusCode !== 200) fail("API health"); }, "API same-origin");
  await waitFor(async () => { if ((await request(`${origin}/api/v1/live-bindings`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).statusCode !== 401) fail("binding 401"); }, "binding no autenticado");
  await waitFor(() => checkWebSocket(env, livekitPort), "upgrade WSS");
  const databaseProbe = `import('pg').then(async({Client})=>{
    const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
    try {const r=await c.query("SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.conversations') IS NOT NULL AND to_regtype('vector') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='recipient_app') AS ready");if(!r.rows[0]?.ready)throw new Error('schema');}
    finally {await c.end();}
  }).catch(()=>process.exit(1))`;
  try { compose(env, ["exec", "-T", "backend", "node", "-e", databaseProbe]); }
  catch { fail("No pasó la verificación de conexión, TLS o esquema de Supabase remoto. No se aplicaron migraciones."); }
  await waitFor(async () => {
    compose(env, ["exec", "-T", "voice-worker", "node", "-e", "import('/app/dist/wallet/signer/probe.js').then(async({probePayloadSigner})=>{const result=await probePayloadSigner();if(!result.capable)process.exit(1)}).catch(()=>process.exit(1))"]);
    const health = await request(`${origin}/api/health`);
    let payload;
    try { payload = JSON.parse(health.body); } catch { fail("La respuesta health no es JSON válido."); }
    if (health.statusCode !== 200) fail("health del backend");
    validateInfrastructureHealth(payload);
  }, "capacidad de firma de API y worker");
  const worker = compose(env, ["ps", "--format", "json", "voice-worker"]);
  if (!worker.includes("running")) fail("El worker de LiveKit no quedó en ejecución.");
  await waitFor(async () => {
    const logs = compose(env, ["logs", "--tail", "120", "voice-worker"]);
    if (!/registered.*(?:agent|worker)|(?:agent|worker).*registered/iu.test(logs)) fail("registro del worker");
  }, "registro del worker de LiveKit", 20);
}

function validateVault(env) {
  const missing = vaultKeys.filter(name => !env[name]?.trim());
  if (missing.length) fail(`Faltan claves de Vault: ${missing.join(", ")}.`);
  return { ...env, OPENAI_API_KEY: env.OPENAI_API_KEY || env.OPEN_AI_API_KEY };
}

function invokeVault(args) {
  const available = new Set(run("vault-env", ["list"]).split(/\s+/u));
  const missing = vaultKeys.filter(name => !available.has(name));
  if (missing.length) fail(`Faltan claves de Vault: ${missing.join(", ")}.`);
  const result = spawnSync("vault-env", ["run", "--names", vaultKeys.join(","), "--", process.execPath, fileURLToPath(import.meta.url), "--vault-injected", ...args], { cwd: sourceRoot, env: process.env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { check: { type: "boolean" }, "vault-injected": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) { console.log("Uso: npm run dev:stack [-- --check]\nInicia el stack Privy/Supabase local en https://nana-privy.localhost."); return; }
  const installEnv = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  // Las instalaciones no reciben las credenciales inyectadas desde Vault.
  if (!existsSync(resolve(sourceRoot, "node_modules/livekit-server-sdk")) || !existsSync(resolve(sourceRoot, "node_modules/ws"))) run("npm", ["ci"], installEnv);
  if (!existsSync(resolve(sourceRoot, "apps/nana-wallet/node_modules"))) run("npm", ["ci", "--prefix", resolve(sourceRoot, "apps/nana-wallet")], installEnv);
  if (!values["vault-injected"]) return invokeVault(args);
  const env = validateVault(process.env);
  await checkPortless();
  ensureDocker();
  const databaseUrl = verifySupabaseTarget(env, readLinkedSupabaseMetadata());
  if (values.check) { console.log("Preflight válido: Portless HTTPS, Vault y Supabase Nana Wallet."); return; }
  const state = stateDirectory();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databaseCertificate = await ensureDatabaseCertificate(state);
  const binding = ensureBindingPair(state);
  const signerDir = resolve(state, "signer");
  mkdirSync(signerDir, { recursive: true, mode: 0o700 });
  writeRestricted(resolve(signerDir, "privy-authorization-private-key"), normalizeAuthorizationKey(env.PRIVY_AUTHORIZATION_PRIVATE_KEY));
  const tokenPath = resolve(state, "signer.token");
  if (!existsSync(tokenPath)) writeRestricted(tokenPath, randomBytes(32).toString("hex"));
  const verification = await fetchVerificationBundle(env.PRIVY_APP_ID);
  writeRestricted(resolve(state, "privy-verification.pem"), verification);
  const mediaStart = Number(env.NANA_LIVEKIT_MEDIA_START ?? 18881);
  if (!Number.isInteger(mediaStart) || mediaStart < 1024 || mediaStart > 65525) fail("NANA_LIVEKIT_MEDIA_START debe ser un puerto válido.");
  const livekitPath = resolve(state, "livekit.yaml");
  writeRestricted(livekitPath, livekitConfig(mediaStart));
  const runtime = {
    ...env,
    DATABASE_URL: databaseUrl,
    PRIVY_AUTHORIZATION_PUBLIC_KEY: normalizeAuthorizationKey(env.PRIVY_AUTHORIZATION_PUBLIC_KEY),
    PRIVY_VERIFICATION_KEY: verification,
    PRIVY_SIGNER_TOKEN: readFileSync(tokenPath, "utf8").trim(),
    LIVE_VOICE_BINDING_PRIVATE_KEY: binding.privateKey,
    LIVE_VOICE_BINDING_PUBLIC_KEY: binding.publicKey,
    NANA_SOURCE_DIR: sourceRoot,
    NANA_LIVEKIT_CONFIG: livekitPath,
    NANA_LIVEKIT_MEDIA_START: String(mediaStart),
    NANA_LIVEKIT_MEDIA_END: String(mediaStart + 10),
    PRIVY_SIGNER_KEY_DIR: signerDir,
    NANA_DATABASE_CA: databaseCertificate,
  };
  compose(runtime, ["config", "--quiet"]);
  console.log("Construyendo e iniciando API, worker, LiveKit y sidecars…");
  compose(runtime, ["up", "-d", "--build", "--wait", "--wait-timeout", "180"]);
  // `network_mode: service:*` captures a namespace when the sidecar starts.
  // Recreate only the owned sidecars after every consumer update so none stays
  // attached to a prior namespace.
  compose(runtime, ["up", "-d", "--no-deps", "--force-recreate", "backend-signer", "voice-worker-signer"]);
  assertSignerNamespaces(runtime);
  const apiPort = composePort(runtime, "backend", 3000);
  const livekitPort = composePort(runtime, "livekit", 7880);
  console.log("Servicios Docker activos; iniciando el frontend HTTPS…");
  await startFrontend(runtime, state, apiPort, livekitPort);
  await readiness(runtime, livekitPort);
  console.log(`Stack listo: ${origin}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "No se pudo iniciar el stack."); process.exitCode = 1; });
}
