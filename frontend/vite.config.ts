import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import * as fs from 'fs'

const ACTIVE_MARKET_FILE = '/tmp/meridian-active-market.txt'

export default defineConfig({
  envDir: "..",
  plugins: [
    react(),
    tailwindcss(),
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
  define: {
    'process.env': {},
  },
})
