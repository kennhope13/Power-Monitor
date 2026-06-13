import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import pkg from './package.json';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: `Station Monitor Enterprise`,
        short_name: 'StationMonitor',
        description: 'Vận hành trạm biến áp',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0a0f0a',
        background_color: '#0a0f0a',
        icons: [
          { src: '/favico/logo.svg', sizes: '512x512', type: 'image/svg+xml' },
          { src: '/favico/logo.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: '/favico/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,ico,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024, // 30 MB
        navigateFallback: null,
      }
    })
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/media': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'http://127.0.0.1:5000',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
      '/ai-api': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai-api/, ''),
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res) { res.writeHead(503); res.end(); }
          });
        },
      },
      '/pd-monitor': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res) { res.writeHead(503); res.end(); }
          });
        },
      }
    }
  }
});
