import type { PrivyClientConfig } from "@privy-io/react-auth";

/**
 * Provision both user-owned embedded wallets (Ethereum for Arc/USDC and
 * Solana for delegated grants) for existing and new Privy users.
 * `all-users` is intentional on both chains: `users-without-wallets` would
 * skip a user who linked an external wallet but still needs Nana's embedded
 * wallets.
 */
export const PRIVY_PROVIDER_CONFIG = {
  loginMethods: ["email", "sms"],
  embeddedWallets: {
    ethereum: {
      createOnLogin: "all-users",
    },
    solana: {
      createOnLogin: "all-users",
    },
  },
} satisfies PrivyClientConfig;
