// vite.config.js is gitignored - a stale .js from tsc crashes Vite when
// "type": "module" is set in package.json. Vite handles .ts natively.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills(), // Required: @solana/web3.js uses Buffer/crypto which don't exist in browser
  ],
  define: {
    'process.env': {},
  },
})
