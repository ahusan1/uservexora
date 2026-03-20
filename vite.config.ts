import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              const normalizedId = id.replace(/\\/g, '/');

              if (!normalizedId.includes('node_modules')) return;

              if (normalizedId.includes('three')) {
                return 'vendor-three';
              }

              if (normalizedId.includes('@supabase')) {
                return 'vendor-supabase';
              }

              if (normalizedId.includes('react') || normalizedId.includes('scheduler')) {
                return 'vendor-react';
              }

              return 'vendor-misc';
            },
          },
        },
      },
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
