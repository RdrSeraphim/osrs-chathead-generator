import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { osrsApiPlugin } from './src/server/apiPlugin';

export default defineConfig({
  plugins: [react(), osrsApiPlugin()],
  server: {
    host: '127.0.0.1',
  },
  build: {
    target: 'esnext',
  },
});
