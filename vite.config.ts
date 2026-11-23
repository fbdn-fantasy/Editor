import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: ['es2022', 'safari16.4'] },
  test: { include: ['src/**/*.test.ts'], environment: 'jsdom' }
})
