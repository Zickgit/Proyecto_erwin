// Restauración de la base de un nodo desde un respaldo (T-10).
// Requisitos de seguridad que verifica antes de tocar nada:
//   1) el nodo está DETENIDO (su puerto no responde);
//   2) el respaldo pasa PRAGMA integrity_check;
//   3) el respaldo pertenece al MISMO nodo (node_identity);
// y guarda una copia de la base actual en backups/pre-restore-* (reversible).
// Uso:  node scripts/restore.js A backups/nodeA-<fecha>.db
// Después: iniciar el nodo y ejecutar POST /api/sync/reconcile (o botón en la UI) para
// recuperar desde los peers lo ocurrido después del respaldo.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, nodeConfig, inspect, portInUse, stamp } from './lib/node-files.js';

const [, , nodeArg, backupArg] = process.argv;
if (!nodeArg || !backupArg) {
  console.error('Uso: node scripts/restore.js <A|B|config/nodeX.env> <respaldo.db>');
  process.exit(2);
}
const cfg = nodeConfig(nodeArg);
const backup = path.resolve(backupArg);
if (!fs.existsSync(backup)) { console.error(`No existe el respaldo ${backup}`); process.exit(1); }

if (await portInUse(cfg.host, cfg.port)) {
  console.error(`El nodo ${cfg.id} sigue activo en ${cfg.host}:${cfg.port}. Deténgalo antes de restaurar (scripts/kill-node.ps1 -Port ${cfg.port}).`);
  process.exit(1);
}

const info = inspect(backup);
if (info.integrity !== 'ok') { console.error(`El respaldo no pasa integrity_check: ${info.integrity}`); process.exit(1); }
if (info.identity !== cfg.id) { console.error(`El respaldo pertenece al nodo ${info.identity}, no al ${cfg.id}.`); process.exit(1); }

const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
fs.mkdirSync(backupDir, { recursive: true });
if (fs.existsSync(cfg.dbPath)) {
  const safety = path.join(backupDir, `pre-restore-node${cfg.id}-${stamp()}.db`);
  fs.copyFileSync(cfg.dbPath, safety);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(cfg.dbPath + ext)) fs.copyFileSync(cfg.dbPath + ext, safety + ext);
  console.log(`[restore] Copia de seguridad de la base actual: ${path.relative(ROOT, safety)}`);
}
for (const ext of ['-wal', '-shm']) fs.rmSync(cfg.dbPath + ext, { force: true });
fs.copyFileSync(backup, cfg.dbPath);

const after = inspect(cfg.dbPath);
console.log(`[restore] Nodo ${cfg.id} restaurado desde ${path.relative(ROOT, backup)}`);
console.log(`[restore] integridad=${after.integrity} incidentes=${after.counts.incidents} bitácora=${after.counts.auditEntries} pendientes=${after.counts.outboxPending}`);
console.log(`[restore] triggers de bitácora: ${after.triggers.filter((t) => t.startsWith('trg_audit')).join(', ')}`);
console.log('[restore] Siguiente paso: iniciar el nodo y reconciliar con los peers:');
console.log(`          npm run start:${cfg.id.toLowerCase()}`);
console.log(`          Invoke-RestMethod -Method Post http://${cfg.host}:${cfg.port}/api/sync/reconcile -Headers @{ 'X-User'='coord' }`);
