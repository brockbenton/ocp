import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // An empty config keeps Vite from loading the Tailwind PostCSS setup in tests.
  css: { postcss: {} },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: ['./test/setup.tsx'],
    env: {
      NEXT_PUBLIC_CONTRACT_ADDRESS: '0x0000000000000000000000000000000000000001',
      NEXT_PUBLIC_REP_ADDRESS: '0x0000000000000000000000000000000000000002',
      NEXT_PUBLIC_GOVERNOR_ADDRESS: '0x0000000000000000000000000000000000000003',
      NEXT_PUBLIC_TIMELOCK_ADDRESS: '0x0000000000000000000000000000000000000004',
    },
  },
});
