import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLogin, usePrivy } from "@privy-io/react-auth";

import { RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";

// PMU-026: advertise ONLY the phone channel actually configured in Privy,
// never both. SMS is the default when the env var is absent or unrecognised.
const phoneChannel: "sms" | "whatsapp" =
  import.meta.env["VITE_PRIVY_PHONE_CHANNEL"] === "whatsapp" ? "whatsapp" : "sms";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Ingresar | Nana Wallet" },
      { name: "description", content: "Entrá a tu Nana Wallet con tu correo o tu teléfono." },
      { property: "og:title", content: "Ingresar | Nana Wallet" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PrivyLoginContent,
});

function PrivyLoginContent() {
  const navigate = useNavigate();
  const { ready } = usePrivy();
  const { login } = useLogin({
    onComplete: () => {
      void navigate({ to: "/" });
    },
  });

  if (!ready) return <RoutePending label="Estamos preparando el acceso" />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <section className="surface-card w-full max-w-sm p-7">
        <h1 className="text-3xl font-extrabold">Entrá a tu Nana Wallet</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
          Te vamos a mandar un código a tu correo o a tu teléfono
          {phoneChannel === "whatsapp" ? " por WhatsApp" : " por SMS"} para verificarte. Es rápido y
          seguro.
        </p>
        <Button
          type="button"
          className="press mt-7 min-h-16 w-full text-lg font-extrabold"
          onClick={() => login()}
        >
          Ingresar
        </Button>
      </section>
    </main>
  );
}
