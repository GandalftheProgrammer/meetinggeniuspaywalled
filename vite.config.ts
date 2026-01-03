import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // SECURITY: Do NOT expose process.env here. 
    // Only expose specific safe variables if needed.
    // The API_KEY will now be hidden in the Netlify backend.
  }
});