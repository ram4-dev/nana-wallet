import type { CapacitorConfig } from "@capacitor/cli";

const devServerUrl = process.env["CAPACITOR_DEV_SERVER_URL"];

const config: CapacitorConfig = {
  appId: "com.nanawallet.app",
  appName: "Nana Wallet",
  webDir: "dist/client",
  backgroundColor: "#f5f3ed",
  ...(devServerUrl
    ? {
        server: {
          url: devServerUrl,
          cleartext: devServerUrl.startsWith("http://"),
        },
      }
    : {}),
};

export default config;
