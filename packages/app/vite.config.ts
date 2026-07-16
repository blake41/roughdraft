import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(() => {
  const apiPort = parseInt(process.env.API_PORT || "3001", 10);

  return {
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      outDir: "dist",
      chunkSizeWarningLimit: 1000,
    },
    server: {
      proxy: {
        // `ws: true` forwards WebSocket upgrades (file-change + open-request
        // streams) through the dev proxy. The two-line string shorthand does
        // not reliably forward upgrades across Vite versions, so the target is
        // expanded to the object form to set it explicitly.
        "/api": {
          target: `http://localhost:${apiPort}`,
          ws: true,
        },
      },
    },
  };
});
