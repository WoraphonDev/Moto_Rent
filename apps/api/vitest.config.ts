import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    // e2e ใช้ฐานข้อมูลและ Valkey จริงจาก `pnpm db:setup`
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
