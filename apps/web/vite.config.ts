import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  server: { proxy: { "/api": process.env.COREWASTE_API_PROXY || "http://127.0.0.1:3000" } },
});
