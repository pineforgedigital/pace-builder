import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      useCredentials: true,
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'favicon.svg'],
      manifest: {
        name: 'PACE Builder',
        short_name: 'PACE',
        description: 'Offline-first disaster communication planning utility.',
        theme_color: '#121212',
        background_color: '#121212',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5000000,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf}'],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pace-html-cache',
              expiration: { maxEntries: 10 }
            }
          }
        ]
      }
    })
  ]
});
