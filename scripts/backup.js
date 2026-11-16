// Respaldo en caliente de la base de un nodo (T-10). Puede ejecutarse con el nodo encendido:
// `VACUUM INTO` produce una copia consistente (una sola transacción de lectura, incluye el WAL).
// Uso:  node scripts/backup.js A            -> backups/nodeA-<fecha>.db (+ .json con hash y conteos)
//       node scripts/backup.js B destino.db
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, nodeConfig, inspect, sha256, stamp } from './lib/node-files.js';

const [, , nodeArg, outArg] = process.argv;
if (!nodeArg) {
  console.error('Uso: node scripts/backup.js <A|B|config/nodeX.env> [archivo_destino.db]');
  process.exit(2);
}
const cfg = nodeConfig(nodeArg);
if (!fs.existsSync(cfg.dbPath)) {
  console.error(`No existe la base ${cfg.dbPath}. ¿Se inició alguna vez el nodo ${cfg.id}?`);
  process.exit(1);
}
const out = path.resolve(outArg ?? path.join(process.env.BACKUP_DIR || path.join(ROOT, 'backups'), `node${cfg.id}-${stamp()}.db`));
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) { console.error(`El destino ya existe: ${out}`); process.exit(1); }

const db = new DatabaseSync(cfg.dbPath);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.prepare('VACUUM INTO ?').run(out);
} finally {
  db.close();
}

const info = inspect(out);
if (info.integrity !== 'ok') { console.error(`Respaldo con errores de integridad: ${info.integrity}`); process.exit(1); }
const manifest = { node: cfg.id, source: path.relative(ROOT, cfg.dbPath), file: path.relative(ROOT, out), createdAt: new Date().toISOString(), sha256: sha256(out), ...info };
fs.writeFileSync(out.replace(/\.db$/, '.json'), JSON.stringify(manifest, null, 2));

console.log(`[backup] Nodo ${cfg.id} -> ${manifest.file}`);
console.log(`[backup] integridad=${info.integrity} esquema=v${info.schemaVersion} sha256=${manifest.sha256.slice(0, 16)}…`);
console.log(`[backup] incidentes=${info.counts.incidents} bitácora=${info.counts.auditEntries} pendientes=${info.counts.outboxPending}`);
