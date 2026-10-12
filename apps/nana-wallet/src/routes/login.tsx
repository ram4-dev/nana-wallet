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
      { title: "Sign in | Nana Wallet" },
      {
        name: "description",
        content: "Sign in to your Nana Wallet with your email or your phone.",
      },
      { property: "og:title", content: "Sign in | Nana Wallet" },
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

  if (!ready) return <RoutePending label="We are preparing the sign-in" />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <section className="surface-card w-full max-w-sm p-7">
        <h1 className="text-3xl font-extrabold">Sign in to your Nana Wallet</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
          We are going to send you a code to your email or to your phone
          {phoneChannel === "whatsapp" ? " on WhatsApp" : " by SMS"} to verify you. It is fast and
          safe.
        </p>
        <Button
          type="button"
          className="press mt-7 min-h-16 w-full text-lg font-extrabold"
          onClick={() => login()}
        >
          Sign in
        </Button>
      </section>
    </main>
  );
}
