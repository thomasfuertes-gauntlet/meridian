import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import * as fs from 'fs'

const ACTIVE_MARKET_FILE = '/tmp/meridian-active-market.txt'

const READ_API_TARGET = process.env.VITE_READ_API_URL || 'http://localhost:8080'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills(),
    {
      name: 'active-ticker-api',
      configureServer(server) {
        server.middlewares.use('/api/active-ticker', (req, res) => {
          const url = new URL(req.url!, `http://${req.headers.host}`)
          const ticker = url.searchParams.get('ticker')
          if (ticker) {
            fs.writeFileSync(ACTIVE_MARKET_FILE, ticker)
          }
          res.writeHead(204)
          res.end()
        })
      },
    },
  ],
  server: {
    proxy: {
      '/api/markets': READ_API_TARGET,
      '/api/activity': READ_API_TARGET,
      '/api/health': READ_API_TARGET,
    },
  },
  define: {
    'process.env': {},
  },
})
