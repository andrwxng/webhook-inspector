import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dashboard API calls and webhook URLs go to the backend during local
    // dev, so the URL shown in the UI works even from the Vite origin.
    proxy: {
      '/api': 'http://localhost:3000',
      '/in': 'http://localhost:3000',
    },
  },
});
