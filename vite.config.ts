import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser cannot talk to the board. Only the process holding the COM handle can drive it, and
// that process is the Deno tester in the hardware-libs repo
// (`ier/s33380/examples/tester/main.ts`), which owns the port and exposes this JSON + SSE API.
// Every /api call is proxied there, which is also why no CORS headers are needed on its side —
// nothing in this repo requires a change to the driver.
const TESTER_PORT = process.env.TESTER_PORT ?? "8777";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": { target: `http://localhost:${TESTER_PORT}`, changeOrigin: true },
    },
  },
  // `vite preview` proxies too, so a built bundle reaches the board the same way `dev` does.
  preview: {
    port: 5175,
    proxy: {
      "/api": { target: `http://localhost:${TESTER_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
