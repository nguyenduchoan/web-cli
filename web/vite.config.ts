import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/api/web-cli/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api/web-cli": { target: "http://127.0.0.1:3001", ws: true } }
  },
  preview: {
    port: 4173
  }
});
