/**
 * Zero-Dependency Static HTTP Server for Maquette Slicer Studio (Web Edition)
 * Automatically finds an available port starting from 8080 so it never crashes on EADDRINUSE.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const useDist = args.includes('--dist');
const autoOpen = args.includes('--open');
const portArg = args.find(a => a.startsWith('--port='));
const INITIAL_PORT = portArg ? parseInt(portArg.split('=')[1], 10) : (parseInt(process.env.PORT, 10) || 8080);

const SERVE_DIR = useDist ? path.join(ROOT_DIR, 'dist') : ROOT_DIR;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.stl': 'model/stl',
  '.obj': 'text/plain; charset=utf-8',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function createHandler(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const safePath = path.normalize(path.join(SERVE_DIR, pathname));
  if (!safePath.startsWith(SERVE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });

    fs.createReadStream(safePath).pipe(res);
  });
}

function startServer(port, attemptsLeft = 10) {
  const server = http.createServer(createHandler);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} occupé, essai sur le port ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      console.error('Erreur serveur HTTP :', err.message);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`================================================================`);
    console.log(` Maquette Slicer Studio (100% Web) disponible sur : ${url}`);
    console.log(` Dossier servi : ${SERVE_DIR}`);
    console.log(` (Ne fermez pas cette fenetre tant que vous utilisez le studio)`);
    console.log(`================================================================`);

    if (autoOpen) {
      if (process.platform === 'win32') {
        exec(`start "" "${url}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
    }
  });
}

startServer(INITIAL_PORT);
