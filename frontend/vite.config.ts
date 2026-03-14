import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import * as fs from 'fs'

const ACTIVE_MARKET_FILE = '/tmp/meridian-active-market.txt'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills(), // Required: @solana/web3.js uses Buffer/crypto which don't exist in browser
    {
      name: 'active-ticker-api',
      configureServer(server) {
        server.middlewares.use('/api/active-ticker', (req, res) => {
          const url = new URL(req.url!, `http://${req.headers.host}`)
          const ticker = url.searchParams.get('ticker')
          const market = url.searchParams.get('market')
          if (ticker) {
            const value = market ? `${ticker}:${market}` : ticker
            fs.writeFileSync(ACTIVE_MARKET_FILE, value)
          }
          res.writeHead(204)
          res.end()
        })
      },
    },
  ],
  define: {
    'process.env': {},
  },
})
