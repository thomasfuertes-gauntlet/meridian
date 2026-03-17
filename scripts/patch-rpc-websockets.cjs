// Patch jito-ts/node_modules/rpc-websockets to add missing exports field.
// rpc-websockets@7 lacks subpath exports, breaking Node 22's ESM-aware require (via tsx).
// Same patch applied in Dockerfile; this script runs via postinstall so local dev works too.
const fs = require("fs");
const p = "node_modules/jito-ts/node_modules/rpc-websockets/package.json";
if (!fs.existsSync(p)) process.exit(0);
const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
if (pkg.exports) process.exit(0);
pkg.exports = {
  ".": { require: "./dist/index.cjs", default: "./dist/index.cjs" },
  "./dist/lib/client": { require: "./dist/lib/client.cjs", default: "./dist/lib/client.cjs" },
  "./dist/lib/client/websocket": { require: "./dist/lib/client/websocket.cjs", default: "./dist/lib/client/websocket.cjs" },
  "./dist/lib/client/websocket.browser": { require: "./dist/lib/client/websocket.browser.cjs", default: "./dist/lib/client/websocket.browser.cjs" },
};
fs.writeFileSync(p, JSON.stringify(pkg, null, 2));
console.log("Patched jito-ts/rpc-websockets exports");
