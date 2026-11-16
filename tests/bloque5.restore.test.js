// T-10 Restauración: respaldo en caliente, pérdida simulada, restauración segura,
// verificación de datos/bitácora y recuperación del faltante por reconciliación con el peer.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startNode, api, validIncident, ROOT } from './helpers.js';

const PA = 3121;
const PB = 3122;
const FAST = { SYNC_INTERVAL_MS: '300', HEARTBEAT_MS: '400', PEER_TIMEOUT_MS: '600' };
let A;
let B;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await sleep(150); }
  throw new Error('tiempo agotado');
}
const run = (script, args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, BACKUP_DIR: B.dir } });
const counts = async (n) => (await api(n.url, 'GET', '/api/health')).body.database.counts;
const has = async (n, id) => (await api(n.url, 'GET', `/api/incidents/${id}`, { user: 'auditor' })).status === 200;

before(async () => {
  A = await startNode({ id: 'A', port: PA, peers: { B: PB }, env: FAST });
  B = await startNode({ id: 'B', port: PB, peers: { A: PA }, env: FAST });
});
after(async () => {
  await A?.stop();
  await B?.stop();
  for (const n of [A, B]) if (n) fs.rmSync(n.dir, { recursive: true, force: true });
});

describe('T-10 Restauración desde respaldo', () => {
  it('respalda en caliente, restaura con verificaciones y recupera el faltante desde el peer', async () => {
    // Env file temporal que apunta a la base de prueba de B (los scripts leen NODE_ID/DB_PATH/PORT).
    const envB = path.join(B.dir, 'nodeB.test.env');
    fs.writeFileSync(envB, `NODE_ID=B\nHOST=127.0.0.1\nPORT=${PB}\nDB_PATH=${B.dbPath}\n`);

    // 1) Datos previos al respaldo
    const before1 = (await api(B.url, 'POST', '/api/incidents', { user: 'op.sur', body: validIncident({ description: 'Antes del respaldo (B)' }) })).body;
    await waitFor(() => has(A, before1.id));

    // 2) Respaldo EN CALIENTE (B encendido)
    const backupFile = path.join(B.dir, 'respaldo-B.db');
    const outBackup = run('backup.js', [envB, backupFile]);
    assert.match(outBackup, /integridad=ok/);
    const manifest = JSON.parse(fs.readFileSync(backupFile.replace(/\.db$/, '.json'), 'utf8'));
    assert.equal(manifest.identity, 'B');
    assert.equal(manifest.integrity, 'ok');
    assert.equal(manifest.sha256.length, 64);

    // 3) Cambios POSTERIORES al respaldo, en ambos nodos (se replican normalmente)
    const afterB = (await api(B.url, 'POST', '/api/incidents', { user: 'op.sur', body: validIncident({ description: 'Después del respaldo (B)' }) })).body;
    const afterA = (await api(A.url, 'POST', '/api/incidents', { user: 'op.norte', body: validIncident({ description: 'Después del respaldo (A)' }) })).body;
    await api(B.url, 'POST', `/api/incidents/${before1.id}/transition`, { user: 'coord', body: { to: 'VALIDADO', note: 'post-respaldo' } });
    await waitFor(async () => (await has(A, afterB.id)) && (await has(B, afterA.id)));
    await waitFor(async () => (await counts(A)).outboxPending === 0 && (await counts(B)).outboxPending === 0);
    const reference = await counts(A);

    // 4) Restaurar con el nodo encendido debe NEGARSE
    assert.throws(() => run('restore.js', [envB, backupFile]), /sigue activo/);

    // 5) Detener B (pérdida del nodo) y restaurar
    await B.stop();
    const outRestore = run('restore.js', [envB, backupFile]);
    assert.match(outRestore, /integridad=ok/);
    assert.match(outRestore, /trg_audit_no_delete, trg_audit_no_update/);
    assert.ok(fs.readdirSync(B.dir).some((f) => f.startsWith('pre-restore-nodeB')), 'copia de la base previa');

    // 6) B arranca con el estado del respaldo: le falta lo posterior
    B = await startNode({ id: 'B', port: PB, peers: { A: PA }, env: FAST, dir: B.dir });
    assert.equal(await has(B, before1.id), true);
    assert.equal(await has(B, afterB.id), false, 'lo creado después del respaldo se perdió en B');
    assert.equal(await has(B, afterA.id), false, 'lo recibido después del respaldo se perdió en B');
    assert.equal((await api(B.url, 'GET', `/api/incidents/${before1.id}`, { user: 'auditor' })).body.status, 'NUEVO');

    // 7) Reconciliación con el peer: recupera todo y no duplica
    const rec = (await api(B.url, 'POST', '/api/sync/reconcile', { user: 'coord' })).body.results[0];
    assert.equal(rec.peer, 'A');
    assert.ok(rec.incidentsInserted >= 2);
    assert.ok(rec.incidentsUpdated >= 1);
    assert.equal(await has(B, afterB.id), true);
    assert.equal(await has(B, afterA.id), true);
    const det = (await api(B.url, 'GET', `/api/incidents/${before1.id}`, { user: 'auditor' })).body;
    assert.equal(det.status, 'VALIDADO');
    assert.ok(det.history.some((h) => h.details?.note === 'post-respaldo'), 'bitácora recuperada');

    // Repetir la reconciliación no duplica nada
    const rec2 = (await api(B.url, 'POST', '/api/sync/reconcile', { user: 'coord' })).body.results[0];
    assert.equal(rec2.incidentsInserted, 0);
    assert.equal(rec2.auditInserted, 0);

    // 8) Convergencia: mismos incidentes y entradas de bitácora (más las de sistema, si hubiera)
    await waitFor(async () => (await counts(B)).outboxPending === 0);
    const cb = await counts(B);
    assert.equal(cb.incidents, reference.incidents);
    assert.equal(cb.auditEntries, reference.auditEntries);
    const log = (await api(B.url, 'GET', '/api/sync/log?kind=RECONCILE', { user: 'auditor' })).body.items;
    assert.equal(log.length, 2);
  });
});
