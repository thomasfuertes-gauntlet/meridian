/**
 * HTTP server that:
 *  1. Health check (GET /health)
 *  2. Serves the frontend SPA static files from frontend/dist/ with SPA fallback
 *
 * GET  /health  -> 200 OK
 * GET  /*       -> static file or index.html
 *
 * Listens on PORT (Railway sets this) or 8080.
 */
import { createServer } from "http";
import {
  existsSync,
  readFileSync,
  statSync,
} from "fs";
import { join, extname } from "path";

const PORT = Number(process.env.PORT || 8080);

// Resolve frontend/dist relative to cwd (Docker WORKDIR = /app, local dev = repo root)
const STATIC_DIR = join(process.cwd(), "frontend", "dist");
const HAS_STATIC = existsSync(STATIC_DIR);

if (!HAS_STATIC) {
  console.warn(
    `[signal-server] WARNING: ${STATIC_DIR} not found - static file serving disabled. Run 'npm run build' in frontend/ first.`
  );
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/**
 * Try to serve a static file. Returns true if served, false otherwise.
 */
function tryServeStatic(
  pathname: string,
  res: import("http").ServerResponse
): boolean {
  if (!HAS_STATIC) return false;

  // Prevent directory traversal
  const safePath = join(STATIC_DIR, pathname);
  if (!safePath.startsWith(STATIC_DIR)) return false;

  try {
    const stat = statSync(safePath);
    if (!stat.isFile()) return false;

    const ext = extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const body = readFileSync(safePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

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

  // ── API routes (priority) ──────────────────────────────────────

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // ── Static file serving + SPA fallback ─────────────────────────

  if (req.method === "GET" || req.method === "HEAD") {
    // Try exact file match first
    if (tryServeStatic(url.pathname, res)) return;

    // SPA fallback: serve index.html for any unmatched GET
    if (tryServeStatic("/index.html", res)) return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[signal-server] Listening on :${PORT}`);
  if (HAS_STATIC) {
    console.log(`[signal-server] Serving SPA from ${STATIC_DIR}`);
  }
});
