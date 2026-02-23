import { defineConfig } from 'vite';

const target = process.env.VITE_ORCHESTRATOR_URL || 'http://127.0.0.1:3030';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
      },
    },
  },
});

