import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Mi plata | Nana Wallet" },
      {
        name: "description",
        content:
          "Saldo en pesos, dólares y plazo fijo, con los últimos movimientos en letra grande.",
      },
      { property: "og:title", content: "Mi plata" },
      {
        property: "og:description",
        content: "Mirá cuánto tenés y qué entró o salió este mes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PortfolioPage,
});

const tenencias = [
  { nombre: "Pesos disponibles", monto: "$ 412.300", detalle: "En la cuenta" },
  { nombre: "Dólares", monto: "US$ 1.250", detalle: "≈ $ 1.687.500" },
  { nombre: "Plazo fijo", monto: "$ 900.000", detalle: "Vence el 3/10" },
];

const movimientos = [
  { texto: "Jubilación ANSES", monto: "+ $ 305.000", entrada: true },
  { texto: "Edesur", monto: "− $ 18.450", entrada: false },
  { texto: "Transferencia a Sofía", monto: "− $ 25.000", entrada: false },
  { texto: "Alquiler cochera", monto: "+ $ 90.000", entrada: true },
];

function PortfolioPage() {
  return (
    <main className="mx-auto max-w-md px-6 pt-12 pb-40">
      <h1 className="text-2xl font-extrabold">Mi plata</h1>

      <section className="plastic mt-5 p-7">
        <p className="text-base font-bold opacity-80">Total en pesos</p>
        <p className="mt-1 text-4xl font-extrabold tracking-tight">$ 2.999.800</p>
      </section>

      <ul className="mt-6 space-y-3">
        {tenencias.map((t) => (
          <li key={t.nombre} className="surface-card flex items-center justify-between gap-3 p-5">
            <div>
              <p className="text-lg font-bold">{t.nombre}</p>
              <p className="text-sm text-muted-foreground">{t.detalle}</p>
            </div>
            <p className="text-lg font-extrabold">{t.monto}</p>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-xl font-extrabold">Últimos movimientos</h2>
      <ul className="mt-4 space-y-3">
        {movimientos.map((m) => (
          <li key={m.texto} className="surface-card flex items-center gap-4 p-4">
            <span
              className={
                m.entrada
                  ? "rounded-xl bg-success/15 p-3 text-success"
                  : "rounded-xl bg-destructive/15 p-3 text-destructive"
              }
            >
              {m.entrada ? (
                <ArrowDownLeft className="size-5" strokeWidth={2.6} />
              ) : (
                <ArrowUpRight className="size-5" strokeWidth={2.6} />
              )}
            </span>
            <p className="flex-1 text-lg font-bold">{m.texto}</p>
            <p className="text-base font-extrabold">{m.monto}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
