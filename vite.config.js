import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.API_PORT ?? 8787);

function manualChunks(id) {
    const normalized = id.replaceAll('\\', '/');

    if (normalized.includes('/src/vendor/novnc/')) {
        return 'novnc';
    }

    if (normalized.includes('/node_modules/@xterm/')) {
        return 'xterm';
    }

    if (normalized.includes('/node_modules/highlight.js/')) {
        return 'highlight';
    }

    if (
        normalized.includes('/node_modules/react-markdown/')
        || normalized.includes('/node_modules/remark-')
        || normalized.includes('/node_modules/rehype-')
        || normalized.includes('/node_modules/unified/')
        || normalized.includes('/node_modules/unist')
        || normalized.includes('/node_modules/mdast')
        || normalized.includes('/node_modules/micromark')
        || normalized.includes('/node_modules/katex/')
    ) {
        return 'markdown-core';
    }

    if (
        normalized.includes('/node_modules/react/')
        || normalized.includes('/node_modules/react-dom/')
        || normalized.includes('/node_modules/scheduler/')
    ) {
        return 'react-core';
    }

    return undefined;
}

export default defineConfig({
    plugins: [react()],
    build: {
        rollupOptions: {
            output: {
                manualChunks,
            },
        },
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': {
                target: `http://localhost:${API_PORT}`,
                changeOrigin: true,
            },
        },
    },
});
