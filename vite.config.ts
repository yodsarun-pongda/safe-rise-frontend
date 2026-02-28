import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  preview: {
    allowedHosts: [".yodsarun.online"],
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: [".yodsarun.online"],
  },
});
