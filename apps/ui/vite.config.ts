import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the Python server in dev mode
      "/backups": "http://localhost:8000",
      "/messages": "http://localhost:8000",
      "/contacts": "http://localhost:8000",
      "/calls": "http://localhost:8000",
      "/voicemail": "http://localhost:8000",
      "/notes": "http://localhost:8000",
      "/photos": "http://localhost:8000",
      "/analysis": "http://localhost:8000",
      "/anonymize": "http://localhost:8000",
    },
  },
});
