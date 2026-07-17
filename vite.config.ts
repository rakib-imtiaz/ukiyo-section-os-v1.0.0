import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      // WebSocket proxy for the integrated PTY terminal.
      '/terminal': { target: 'ws://localhost:8787', ws: true },
      // WebSocket proxy for the integrated browser (screencast + input).
      '/browser': { target: 'ws://localhost:8787', ws: true },
      // Local MCP browser-tools endpoint (localhost-only).
      '/mcp-local': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
  },
});
