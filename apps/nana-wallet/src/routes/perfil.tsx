import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays, Copy, Users } from "lucide-react";

export const Route = createFileRoute("/perfil")({
  head: () => ({
    meta: [
      { title: "Mi perfil y agenda | Nana Wallet" },
      {
        name: "description",
        content:
          "Tus datos, la agenda de CBU de hijos y nietos y el calendario de facturas por pagar.",
      },
      { property: "og:title", content: "Mi perfil y agenda" },
      {
        property: "og:description",
        content: "Contactos guardados y facturas del mes, todo en un solo lugar.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PerfilPage,
});

const contactos = [
  { nombre: "Sofía (nieta)", alias: "sofi.mate.rio", cbu: "0000003100010000000001" },
  { nombre: "Julián (nieto)", alias: "juli.bici.sol", cbu: "0000003100010000000002" },
  { nombre: "Marta (hija)", alias: "marta.flor.luz", cbu: "0000003100010000000003" },
];

const facturas = [
  { nombre: "Edesur", dia: "5 de septiembre", monto: "$ 18.450", estado: "Pendiente" },
  { nombre: "Metrogas", dia: "12 de septiembre", monto: "$ 9.230", estado: "Pendiente" },
  { nombre: "OSDE", dia: "20 de septiembre", monto: "$ 74.900", estado: "Programada" },
];

function PerfilPage() {
  return (
    <main className="mx-auto max-w-md px-6 pt-12 pb-40">
      <section className="surface-card flex items-center gap-4 p-5">
        <div className="plastic flex size-16 items-center justify-center rounded-full text-2xl font-extrabold">
          H
        </div>
        <div>
          <h1 className="text-2xl font-extrabold">Héctor Bianchi</h1>
          <p className="text-base text-muted-foreground">DNI 8.114.552 · Lanús</p>
        </div>
      </section>

      <h2 className="mt-10 flex items-center gap-2 text-xl font-extrabold">
        <Users className="size-6 text-primary" strokeWidth={2.4} /> Mi familia guardada
      </h2>
      <ul className="mt-4 space-y-3">
        {contactos.map((c) => (
          <li key={c.cbu} className="surface-card flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-lg font-bold">{c.nombre}</p>
              <p className="text-sm text-muted-foreground">
                {c.alias} · CBU …{c.cbu.slice(-4)}
              </p>
            </div>
            <button
              className="press rounded-xl bg-secondary p-3 text-secondary-foreground"
              aria-label={`Copiar CBU de ${c.nombre}`}
            >
              <Copy className="size-5" strokeWidth={2.4} />
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 flex items-center gap-2 text-xl font-extrabold">
        <CalendarDays className="size-6 text-primary" strokeWidth={2.4} /> Facturas del mes
      </h2>
      <ul className="mt-4 space-y-3">
        {facturas.map((f) => (
          <li key={f.nombre} className="surface-card flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-lg font-bold">{f.nombre}</p>
              <p className="text-sm text-muted-foreground">Vence el {f.dia}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-extrabold">{f.monto}</p>
              <p
                className={
                  f.estado === "Pendiente"
                    ? "text-sm font-bold text-destructive"
                    : "text-sm font-bold text-success"
                }
              >
                {f.estado}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
