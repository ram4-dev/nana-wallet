import { createFileRoute } from "@tanstack/react-router";
import { Calculator, Mic, Send } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Agente | Nana Wallet" },
      {
        name: "description",
        content:
          "Hablá con tu agente y resolvé pagos, transferencias y recordatorios sin complicaciones.",
      },
      { property: "og:title", content: "Agente | Nana Wallet" },
      {
        property: "og:description",
        content: "Tu asistente de confianza para pagar y transferir en pesos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AgentePage,
});

function AgentePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center px-6 pt-14 pb-40">
      <p className="mb-3 rounded-full bg-secondary px-4 py-2 text-sm font-extrabold tracking-[0.16em] text-primary">
        NANA WALLET
      </p>
      <h1 className="text-center text-3xl leading-tight font-extrabold">Hola, Don Héctor</h1>
      <p className="mt-2 text-center text-lg text-muted-foreground">
        Pedime lo que necesites. Yo me encargo.
      </p>

      <div className="relative mt-9 flex flex-col items-center">
        <div className="breathe relative h-64 w-60" aria-hidden="true">
          <div className="agent-rubber absolute bottom-0 left-1/2 h-24 w-48 -translate-x-1/2 rounded-[4.5rem_4.5rem_2.5rem_2.5rem] bg-agent-dress" />
          <div className="absolute bottom-8 left-1/2 h-16 w-20 -translate-x-1/2 bg-card [clip-path:polygon(0_0,100%_0,50%_100%)]" />
          <div className="absolute bottom-5 left-1/2 h-14 w-5 -translate-x-1/2 bg-agent-glasses [clip-path:polygon(50%_0,100%_24%,72%_100%,28%_100%,0_24%)]" />
          <div className="agent-rubber absolute right-8 bottom-5 flex size-11 items-center justify-center rounded-xl bg-card text-primary">
            <Calculator className="size-6" strokeWidth={2.5} />
          </div>

          <div className="agent-rubber absolute top-24 left-7 h-12 w-8 rounded-full bg-agent-skin" />
          <div className="agent-rubber absolute top-24 right-7 h-12 w-8 rounded-full bg-agent-skin" />
          <div className="agent-rubber absolute top-7 left-8 h-20 w-12 -rotate-12 rounded-full bg-agent-hair-shadow" />
          <div className="agent-rubber absolute top-7 right-8 h-20 w-12 rotate-12 rounded-full bg-agent-hair-shadow" />
          <div className="absolute top-5 left-12 h-10 w-10 -rotate-12 rounded-full bg-agent-hair" />
          <div className="absolute top-5 right-12 h-10 w-10 rotate-12 rounded-full bg-agent-hair" />

          <div className="agent-rubber absolute top-8 left-1/2 h-40 w-40 -translate-x-1/2 rounded-[48%_48%_46%_46%] bg-agent-skin">
            <span className="absolute top-3 left-1/2 h-5 w-16 -translate-x-1/2 rounded-full bg-card/35 blur-[1px]" />
            <div className="absolute top-14 left-3 size-4 rounded-full bg-agent-blush/55" />
            <div className="absolute top-14 right-3 size-4 rounded-full bg-agent-blush/55" />

            <span className="absolute top-7 left-7 h-1.5 w-9 -rotate-6 rounded-full bg-agent-hair-shadow" />
            <span className="absolute top-7 right-7 h-1.5 w-9 rotate-6 rounded-full bg-agent-hair-shadow" />
            <div className="absolute top-9 left-6 flex size-11 items-center justify-center rounded-full border-[3px] border-agent-glasses bg-card/35">
              <span className="size-2.5 rounded-full bg-agent-glasses" />
            </div>
            <div className="absolute top-9 right-6 flex size-11 items-center justify-center rounded-full border-[3px] border-agent-glasses bg-card/35">
              <span className="size-2.5 rounded-full bg-agent-glasses" />
            </div>
            <span className="absolute top-[3.85rem] left-1/2 h-[3px] w-4 -translate-x-1/2 bg-agent-glasses" />
            <span className="absolute top-[4.15rem] left-1/2 h-5 w-3 -translate-x-1/2 rounded-full border-r-2 border-agent-skin-shadow/55" />

            <div className="absolute top-[5.65rem] left-1/2 h-5 w-10 -translate-x-1/2 rounded-b-full border-b-[3px] border-agent-mouth" />
            <span className="absolute top-[7.1rem] left-10 h-px w-5 rotate-6 bg-agent-skin-shadow/60" />
            <span className="absolute top-[7.1rem] right-10 h-px w-5 -rotate-6 bg-agent-skin-shadow/60" />
          </div>

          <div className="agent-rubber absolute top-[10.4rem] left-1/2 h-9 w-20 -translate-x-1/2 rounded-full bg-agent-skin" />
        </div>
        <span className="mt-8 rounded-full bg-secondary px-5 py-2 text-base font-bold text-secondary-foreground">
          Tu contador de confianza
        </span>
      </div>

      <div className="surface-card mt-14 flex w-full items-center gap-3 px-5 py-4">
        <Mic className="size-6 text-primary" strokeWidth={2.4} />
        <input
          placeholder="Escribí o hablame…"
          className="w-full bg-transparent text-lg outline-none placeholder:text-muted-foreground"
        />
        <Send className="size-6 text-primary" strokeWidth={2.4} />
      </div>
    </main>
  );
}
