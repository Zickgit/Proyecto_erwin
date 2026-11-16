// Carga y valida la configuración del nodo desde variables de entorno.
// Las variables se inyectan con `node --env-file=config/nodeX.env` (sin dependencias extra).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Falta la variable de entorno obligatoria ${name}. Revise config/*.env o .env.example`);
  }
  return v;
}

function int(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} debe ser un entero >= 0 (valor: ${raw})`);
  return n;
}

// PEERS="B=http://127.0.0.1:3002,C=http://127.0.0.1:3003"
function parsePeers(raw, selfId) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const idx = entry.indexOf('=');
    if (idx <= 0) throw new Error(`Peer mal formado "${entry}". Formato esperado ID=URL`);
    const id = entry.slice(0, idx).trim();
    const url = entry.slice(idx + 1).trim().replace(/\/+$/, '');
    if (id === selfId) throw new Error(`El nodo ${selfId} no puede declararse a sí mismo como peer`);
    new URL(url); // lanza si la URL es inválida
    return { id, url };
  });
}

function load() {
  const nodeId = required('NODE_ID');
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(nodeId)) throw new Error('NODE_ID solo admite letras, números, _ y - (máx. 16)');
  return Object.freeze({
    root: ROOT,
    nodeId,
    nodeName: process.env.NODE_NAME || `Nodo ${nodeId}`,
    host: process.env.HOST || '127.0.0.1',
    port: int('PORT', 3001),
    dbPath: path.resolve(ROOT, required('DB_PATH')),
    peers: parsePeers(process.env.PEERS, nodeId),
    peerTimeoutMs: int('PEER_TIMEOUT_MS', 1500),
    heartbeatMs: int('HEARTBEAT_MS', 5000),
    syncIntervalMs: int('SYNC_INTERVAL_MS', 3000),
    syncBatchSize: 50,
    // Secreto compartido OPCIONAL entre nodos. Nunca se versiona: definirlo como variable
    // de entorno del proceso antes de arrancar (ver docs/SINCRONIZACION.md).
    syncSecret: process.env.SYNC_SECRET || null,
    version: '0.1.0',
  });
}

let loaded;
try {
  loaded = load();
} catch (e) {
  console.error(`[config] ${e.message}`);
  process.exit(1);
}
export const config = loaded;

/** Ruta relativa a la raíz del proyecto, siempre con "/" (independiente del SO). */
export function relPath(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}
