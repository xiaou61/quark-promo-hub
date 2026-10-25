import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5181,
    proxy: { "/api": "http://localhost:5180" },
  },
});
