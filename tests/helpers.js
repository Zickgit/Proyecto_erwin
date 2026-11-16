// Utilidades de prueba: levanta nodos REALES (procesos aparte) con bases temporales
// en puertos 31xx para no interferir con los nodos de demostración (3001/3002).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startNode({ id, port, peers = {}, dir, env = {} }) {
  const tmp = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `lab2-${id}-`));
  const dbPath = path.join(tmp, `node${id}.db`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ID: id,
      NODE_NAME: `Prueba ${id}`,
      HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      PEERS: Object.entries(peers).map(([pid, pport]) => `${pid}=http://127.0.0.1:${pport}`).join(','),
      PEER_TIMEOUT_MS: '800',
      HEARTBEAT_MS: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`El nodo ${id} terminó al iniciar:\n${log}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch { /* aún no escucha */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    id, port, url, dbPath, dir: tmp, child,
    log: () => log,
    async stop() {
      if (child.exitCode !== null) return;
      const done = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await done;
    },
  };
}

/** Cliente HTTP de pruebas. */
export async function api(baseUrl, method, urlPath, { user, body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-user'] = user;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
}

export const validIncident = (over = {}) => ({
  category: 'INFRAESTRUCTURA',
  priority: 'ALTA',
  description: 'Fuga de agua en sanitarios del edificio ficticio C',
  location: 'Edificio C, planta baja (ficticio)',
  ...over,
});
