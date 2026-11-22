import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.ALTER_API ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true },
});
