import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function readPort(value: string | undefined, key: string, fallback: number) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Set ${key} to a port between 1 and 65535.`);
  }
  return port;
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const env = loadEnv(mode, root, ["API_PORT", "WEB_PORT"]);
  const apiPort = readPort(env.API_PORT, "API_PORT", 4301);
  return {
    plugins: [react()],
    envDir: false,
    server: {
      host: "127.0.0.1",
      port: readPort(env.WEB_PORT, "WEB_PORT", 4317),
      strictPort: true,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
