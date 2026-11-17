import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS === 'true' ? '/draw-history/' : '/',
  server: {
    host: '127.0.0.1',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@turf/')) return 'turf';
          if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre';
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
        },
      },
    },
  },
});
