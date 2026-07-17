// Single WebSocket upgrade router. Multiple `WebSocketServer({ server, path })` instances
// cannot share one HTTP server — each aborts (400) upgrades whose path it doesn't own,
// killing the other's connections. Instead every WS service creates a `noServer` server and
// registers its path here; this hub owns the sole 'upgrade' listener and dispatches by path.
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

const routes = new Map<string, WebSocketServer>();

export function addWsRoute(path: string, wss: WebSocketServer) { routes.set(path, wss); }

export function installWsHub(server: Server) {
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* keep default */ }
    const wss = routes.get(pathname);
    if (!wss) { socket.destroy(); return; }
    // verifyClient (configured on each wss) is still honoured inside handleUpgrade.
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
