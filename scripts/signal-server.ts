/**
 * Tiny HTTP server that accepts active-market signals from the frontend SPA.
 * Writes to /tmp/meridian-active-market.txt so live-bots and strategy-bots
 * (same container on Railway) can read it via getActiveMarket().
 *
 * POST /active-market?ticker=NVDA&market=<address>  -> writes "NVDA:<address>"
 * GET  /health                                       -> 200 OK
 *
 * Listens on PORT (Railway sets this) or 8080.
 */
import { createServer } from "http";
import { writeFileSync } from "fs";

const PORT = Number(process.env.PORT || 8080);
const ACTIVE_MARKET_FILE = "/tmp/meridian-active-market.txt";

const server = createServer((req, res) => {
  // CORS for browser requests from the frontend origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url.pathname === "/active-market") {
    const ticker = url.searchParams.get("ticker");
    const market = url.searchParams.get("market");
    if (ticker) {
      const value = market ? `${ticker}:${market}` : ticker;
      writeFileSync(ACTIVE_MARKET_FILE, value);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[signal-server] Listening on :${PORT}`);
});
