import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "offline",
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    lib: {
      entry: "offline-entry.tsx",
      formats: ["iife"],
      name: "TrustAidOffline",
      fileName: () => "app.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => asset.names.some((name) => name.endsWith(".css")) ? "app.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
