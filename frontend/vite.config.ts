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
