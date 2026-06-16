import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(async () => ({
  plugins: [
    react(),
    process.env.ANALYZE_BUNDLE === 'true' &&
      visualizer({
        filename: 'reports/bundle-stats.html',
        gzipSize: true,
        brotliSize: true,
      }),
  ],
  // Relative asset paths so the packaged Electron app can load dist/index.html
  // from file:// without resolving /assets against the filesystem root.
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/electron/**'],
    },
  },
}));
