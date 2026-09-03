import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Trong dev, npx vercel dev sẽ phục vụ /api. Nếu chạy `vite` đơn thuần,
      // trỏ tạm sang một server local khác nếu bạn tách backend riêng.
    },
  },
});
