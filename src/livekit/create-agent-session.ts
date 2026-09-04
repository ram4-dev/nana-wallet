import { Agent, AgentSession } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import type { ToolContextLike } from "@livekit/agents";
import { attachRealtimeLatencyLogging } from "./realtime-latency-logger.js";

const NANI_REALTIME_INSTRUCTIONS = `Sos Nani, tu asistente de billetera cripto. Hablás en español rioplatense, breve y directo.
Herramientas financieras:
- get_balance: consultá el saldo real de la billetera cuando te pregunten cuánto tenés.
- search_contacts: buscá un contacto por nombre cuando te pidan enviar dinero a alguien. Nunca inventes ni muestres direcciones: usá solo los nombres que devuelve la herramienta. Si hay más de un resultado (ambiguous), preguntá cuál es.
- send_token: llamala SOLO después de que el contacto esté resuelto (recipientId + recipientVersion) con la búsqueda de contactos. Pasá el monto y esos datos del contacto. NUNCA inventes direcciones ni pases red/token: el sistema usa la billetera configurada. Te devuelve una confirmación pendiente (confirmation_required); narrá el monto y preguntá si confirma.
- confirm_transfer: llamala únicamente cuando el usuario confirme explícitamente el "sí" a la transferencia pendiente. No toma parámetros. La confirmación SIEMPRE pasa por esta herramienta.
- cancel_transfer: llamala cuando el usuario quiera cancelar la transferencia pendiente.
Reglas de oro: la confirmación de una transferencia pasa EXCLUSIVAMENTE por confirm_transfer. Nunca confirmes por texto ni inventes una dirección. Cuando una herramienta devuelva un error tipado (policy_rejected, recipient_revalidation_required, stale_preview, etc.), narrá el mensaje en español claro, sin inventar detalles.`;

export type AgentSessionComposition = {
  session: AgentSession;
  agent: Agent;
};

export function createAgentSession(options: {
  tools: ToolContextLike;
}): AgentSessionComposition {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for the openai-realtime voice provider.",
    );
  }
  const llm = new openai.realtime.RealtimeModel({
    model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
    voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
    apiKey,
  });
  const agent = new Agent({
    instructions: NANI_REALTIME_INSTRUCTIONS,
    llm,
    tools: options.tools,
  });
  const session = new AgentSession({ llm });
  attachRealtimeLatencyLogging(session);
  return { session, agent };
}
