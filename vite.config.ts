import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  // Relative asset paths so the packaged Electron app can load dist/index.html
  // from file:// without resolving /assets against the filesystem root.
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/electron/**"],
    },
  },
}));
