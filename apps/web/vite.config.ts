import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5176,
    proxy: {
      "/api": "http://127.0.0.1:8766",
    },
  },
});
