// Utilidades compartidas por los scripts de respaldo/restauración.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lee config/node<ID>.env (o la ruta dada) y devuelve { id, dbPath, host, port }. */
export function nodeConfig(idOrEnvFile) {
  const envFile = idOrEnvFile.endsWith('.env') ? path.resolve(idOrEnvFile) : path.join(ROOT, 'config', `node${idOrEnvFile}.env`);
  if (!fs.existsSync(envFile)) throw new Error(`No existe ${envFile}`);
  const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  return {
    id: env.NODE_ID,
    dbPath: path.resolve(ROOT, process.env.DB_PATH || env.DB_PATH),
    host: env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || env.PORT),
  };
}

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Verificación de integridad y conteos de una base de nodo. */
export function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const identity = db.prepare('SELECT node_id FROM node_identity').get()?.node_id ?? null;
    const counts = { ...db.prepare(`SELECT
        (SELECT COUNT(*) FROM incidents) AS incidents,
        (SELECT COUNT(*) FROM audit_log) AS auditEntries,
        (SELECT COUNT(*) FROM outbox WHERE state = 'PENDIENTE') AS outboxPending,
        (SELECT COUNT(*) FROM applied_events) AS appliedEvents`).get() };
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((t) => t.name);
    const { user_version: schemaVersion } = db.prepare('PRAGMA user_version').get();
    return { integrity, identity, schemaVersion, counts, triggers };
  } finally {
    db.close();
  }
}

/** true si hay un proceso escuchando en host:port. */
export function portInUse(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
