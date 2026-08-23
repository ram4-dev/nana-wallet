export function isLiveAgentBackendEnabled(flag: string | undefined): boolean {
  return flag === "1" || flag === "true";
}

export function shouldUseLiveAgentBackend(): boolean {
  return isLiveAgentBackendEnabled(import.meta.env["VITE_AGENT_BACKEND"]);
}
