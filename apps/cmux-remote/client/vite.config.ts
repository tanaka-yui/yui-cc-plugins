import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:3456",
        ws: true,
      },
      "/health": {
        target: "http://localhost:3456",
      },
    },
  },
});
