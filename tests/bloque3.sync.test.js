// Pruebas del Bloque 3: T-05, T-06, T-07, T-08, T-09 con DOS nodos reales (procesos) en :3111 y :3112.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startNode, api, validIncident } from './helpers.js';

const PA = 3111;
const PB = 3112;
const FAST = { SYNC_INTERVAL_MS: '300', HEARTBEAT_MS: '400', PEER_TIMEOUT_MS: '600' };
let A;
let B;
const OP_A = 'op.norte';
const OP_B = 'op.sur';
const CO = 'coord';
const AU = 'auditor';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 8000, every = 150, msg = 'condición' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`Tiempo agotado esperando: ${msg}`);
}
const get = (node, p, user = AU) => api(node.url, 'GET', p, { user });
const post = (node, p, user, body) => api(node.url, 'POST', p, { user, body });
const link = (node, peer, up) => api(node.url, 'PUT', `/api/admin/links/${peer}`, { body: { up } });
const pendingTo = async (node) => (await get(node, '/api/sync/status')).body.peers[0].outbox.pending;
const existsIn = async (node, id) => (await get(node, `/api/incidents/${id}`)).status === 200;

before(async () => {
  A = await startNode({ id: 'A', port: PA, peers: { B: PB }, env: FAST });
  B = await startNode({ id: 'B', port: PB, peers: { A: PA }, env: FAST });
});
after(async () => {
  await A?.stop();
  await B?.stop();
  for (const n of [A, B]) if (n) fs.rmSync(n.dir, { recursive: true, force: true });
});

describe('T-08 Sincronización y deduplicación', () => {
  it('un incidente creado en A llega a B con su historial y queda SINCRONIZADO', async () => {
    const { body: inc } = await post(A, '/api/incidents', OP_A, validIncident({ description: 'Sincronización básica A->B' }));
    await waitFor(() => existsIn(B, inc.id), { msg: 'réplica en B' });
    const inB = (await get(B, `/api/incidents/${inc.id}`)).body;
    assert.equal(inB.originNode, 'A');
    assert.equal(inB.isLocal, false);
    assert.equal(inB.history[0].source, 'REPLICADO');
    assert.equal(inB.history[0].node, 'A');
    const synced = await waitFor(async () => {
      const r = (await get(A, `/api/incidents/${inc.id}`)).body;
      return r.sync.state === 'SINCRONIZADO' ? r : null;
    }, { msg: 'marca SINCRONIZADO en A' });
    assert.ok(synced.sync.lastSyncedAt);
  });

  it('reenviar el mismo evento no duplica (DUPLICADO por UUID)', async () => {
    const { body: inc } = await post(A, '/api/incidents', OP_A, validIncident({ description: 'Prueba de reenvío idempotente' }));
    await waitFor(() => existsIn(B, inc.id), { msg: 'réplica en B' });
    // Tomamos el evento ya entregado de la outbox de A y lo reenviamos manualmente a B.
    const dbA = new DatabaseSync(A.dbPath, { readOnly: true });
    const { payload } = dbA.prepare('SELECT payload FROM outbox WHERE incident_id = ?').get(inc.id);
    dbA.close();
    const before = (await get(B, '/api/health')).body.database.counts;
    const res = await fetch(`${B.url}/api/sync/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-id': 'A' },
      body: JSON.stringify({ sourceNode: 'A', events: [JSON.parse(payload), JSON.parse(payload)] }),
    }).then((r) => r.json());
    assert.deepEqual(res.results.map((r) => r.result), ['DUPLICADO', 'DUPLICADO']);
    const afterCounts = (await get(B, '/api/health')).body.database.counts;
    assert.equal(afterCounts.incidents, before.incidents);
    assert.equal(afterCounts.auditEntries, before.auditEntries);
  });

  it('sincronizar repetidamente (POST /api/sync/run) es idempotente', async () => {
    await post(A, '/api/sync/run', CO);
    const c1 = (await get(B, '/api/health')).body.database.counts;
    await post(A, '/api/sync/run', CO);
    await post(B, '/api/sync/run', CO);
    const c2 = (await get(B, '/api/health')).body.database.counts;
    assert.deepEqual(c2, c1);
  });

  it('solo peers declarados pueden enviar eventos', async () => {
    const r = await fetch(`${B.url}/api/sync/receive`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-node-id': 'Z' }, body: '{"sourceNode":"Z","events":[]}',
    });
    assert.equal(r.status, 403);
  });
});

describe('Red: desfase de reloj (requisito de LWW entre equipos)', () => {
  it('el heartbeat mide el desfase de reloj con cada peer', async () => {
    const peer = await waitFor(async () => {
      const p = (await get(A, '/api/network/peers')).body.peers[0];
      return p.clockSkewMs !== null ? p : null;
    }, { msg: 'medición de desfase' });
    assert.equal(typeof peer.clockSkewMs, 'number');
    assert.ok(Math.abs(peer.clockSkewMs) < 1000, `misma máquina: desfase ${peer.clockSkewMs} ms`);
    assert.equal(peer.clockSkewWarnMs, 1000);
  });
});

describe('T-05 Consulta distribuida', () => {
  it('la consulta agregada combina ambos nodos e identifica el origen', async () => {
    const tag = `agg-${Date.now()}`;
    await post(A, '/api/incidents', OP_A, validIncident({ description: `Registro en A ${tag}` }));
    await post(B, '/api/incidents', OP_B, validIncident({ description: `Registro en B ${tag}`, category: 'SERVICIOS_TI' }));
    const r = (await get(A, `/api/aggregate/incidents?q=${tag}`)).body;
    assert.equal(r.complete, true);
    assert.equal(r.warning, null);
    assert.equal(r.total, 2);
    assert.deepEqual(r.sources.map((s) => [s.node, s.status, s.servedFrom]), [['A', 'OK', 'EN_VIVO'], ['B', 'OK', 'EN_VIVO']]);
    const origins = r.items.map((i) => `${i.originNode}:${i.source.node}:${i.source.respondedBy}`).sort();
    assert.deepEqual(origins, ['A:A:A', 'B:B:B']);
  });
});

describe('T-06 / T-07 Nodo no disponible y desconexión (enlace SIMULADO)', () => {
  it('con el enlace cortado: eventos quedan pendientes y la consulta se marca parcial', async () => {
    const tag = `cut-${Date.now()}`;
    await post(B, '/api/incidents', OP_B, validIncident({ description: `Previo al corte ${tag}` }));
    await waitFor(async () => (await get(A, `/api/incidents?q=${tag}`)).body.total === 1, { msg: 'réplica previa en A' });

    assert.equal((await link(A, 'B', false)).status, 200);
    const { body: inc } = await post(A, '/api/incidents', OP_A, validIncident({ description: `Durante el corte ${tag}` }));
    assert.equal(inc.sync.state, 'PENDIENTE');
    await sleep(900); // varios ciclos de sincronización fallidos
    assert.ok(await pendingTo(A) >= 1, 'evento conservado en la outbox');
    assert.equal(await existsIn(B, inc.id), false, 'B no lo recibió');
    const st = (await get(A, '/api/sync/status')).body.peers[0];
    assert.equal(st.peerStatus, 'offline');
    assert.equal(st.outbox.lastError, 'LINK_DOWN_SIMULATED');

    const agg = (await get(A, `/api/aggregate/incidents?q=${tag}`)).body;
    assert.equal(agg.complete, false);
    assert.match(agg.warning, /RESULTADO PARCIAL/);
    assert.deepEqual(agg.unavailableNodes, ['B']);
    const srcB = agg.sources.find((s) => s.node === 'B');
    assert.equal(srcB.status, 'NO_DISPONIBLE');
    assert.equal(srcB.error, 'LINK_DOWN_SIMULATED');
    assert.equal(agg.total, null, 'no se presenta un total como si fuera completo');
    const fromB = agg.items.find((i) => i.originNode === 'B');
    assert.equal(fromB.source.servedFrom, 'REPLICA_LOCAL');

    // T-07: la desconexión queda en la bitácora persistente
    const log = (await get(A, '/api/sync/log?limit=50')).body.items.map((x) => x.kind);
    assert.ok(log.includes('LINK_CHANGED_SIMULATED'));
    assert.ok(log.includes('PEER_DOWN') || log.includes('PUSH_FAIL'));

    // Reconexión (F-07): se entrega lo pendiente sin intervención manual.
    await link(A, 'B', true);
    await waitFor(() => existsIn(B, inc.id), { msg: 'entrega tras reconectar' });
    await waitFor(async () => (await pendingTo(A)) === 0, { msg: 'outbox vacía' });
    const after = (await get(A, `/api/incidents/${inc.id}`)).body;
    assert.equal(after.sync.state, 'SINCRONIZADO');
    const agg2 = (await get(A, `/api/aggregate/incidents?q=${tag}`)).body;
    assert.equal(agg2.complete, true);
  });
});

describe('T-06 / T-07 Caída REAL del proceso y recuperación', () => {
  it('B se detiene, A acumula pendientes en disco; al reiniciar B se sincroniza', async () => {
    await B.stop();
    const { body: inc } = await post(A, '/api/incidents', OP_A, validIncident({ description: 'Creado con B apagado' }));
    await sleep(800);
    const st = (await get(A, '/api/sync/status')).body.peers[0];
    assert.ok(st.outbox.pending >= 1);
    assert.equal(st.outbox.lastError, 'CONNECTION_REFUSED');
    const agg = (await get(A, '/api/aggregate/incidents')).body;
    assert.equal(agg.complete, false);
    assert.equal(agg.sources.find((s) => s.node === 'B').error, 'CONNECTION_REFUSED');

    // Reiniciar B con la MISMA base de datos
    B = await startNode({ id: 'B', port: PB, peers: { A: PA }, env: FAST, dir: B.dir });
    await waitFor(() => existsIn(B, inc.id), { msg: 'sincronización tras reinicio de B' });
    await waitFor(async () => (await pendingTo(A)) === 0, { msg: 'outbox de A vacía' });
    const kinds = (await get(A, '/api/sync/log?limit=100')).body.items.map((x) => x.kind);
    assert.ok(kinds.includes('PEER_UP'));
    assert.ok(kinds.includes('PUSH_OK'));
  });
});

describe('T-09 Conflicto (Last Write Wins)', () => {
  it('el mismo incidente modificado en A y en B durante la partición converge al último cambio', async () => {
    const { body: inc } = await post(A, '/api/incidents', OP_A, validIncident({ description: 'Incidente para conflicto controlado' }));
    await waitFor(() => existsIn(B, inc.id), { msg: 'réplica en B' });
    await waitFor(async () => (await pendingTo(A)) === 0, { msg: 'A sin pendientes' });

    // Partición simétrica
    await link(A, 'B', false);
    await link(B, 'A', false);

    // Escritura 1 (A): validar. Escritura 2 (B, posterior): cancelar.
    const wa = await post(A, `/api/incidents/${inc.id}/transition`, CO, { to: 'VALIDADO', note: 'desde A' });
    assert.equal(wa.status, 200);
    await sleep(20);
    const wb = await post(B, `/api/incidents/${inc.id}/transition`, CO, { to: 'CANCELADO', note: 'desde B' });
    assert.equal(wb.status, 200);
    assert.ok(wb.body.updatedAt > wa.body.updatedAt);

    // Reconexión
    await link(A, 'B', true);
    await link(B, 'A', true);
    await waitFor(async () => (await pendingTo(A)) === 0 && (await pendingTo(B)) === 0, { msg: 'ambas outbox vacías' });

    const fa = (await get(A, `/api/incidents/${inc.id}`)).body;
    const fb = (await get(B, `/api/incidents/${inc.id}`)).body;
    // Convergencia: mismo estado, mismo autor de la última escritura y misma versión.
    assert.equal(fa.status, 'CANCELADO', 'gana la escritura más reciente (B)');
    assert.equal(fb.status, 'CANCELADO');
    assert.equal(fa.updatedNode, 'B');
    assert.equal(fa.updatedAt, fb.updatedAt);
    assert.equal(fa.version, fb.version);

    // Ambos nodos registran el conflicto y conservan las DOS escrituras en la bitácora.
    for (const [n, h, expectedWinner] of [['A', fa.history, 'REMOTO'], ['B', fb.history, 'LOCAL']]) {
      const c = h.find((e) => e.action === 'SYNC_CONFLICTO');
      assert.ok(c, `conflicto registrado en ${n}`);
      assert.equal(c.details.winner, expectedWinner, `ganador visto desde ${n}`);
      assert.equal(c.details.local.status, n === 'A' ? 'VALIDADO' : 'CANCELADO');
      assert.equal(c.details.remote.status, n === 'A' ? 'CANCELADO' : 'VALIDADO');
      const notes = h.filter((e) => e.action === 'TRANSICION').map((e) => e.details.note).sort();
      assert.deepEqual(notes, ['desde A', 'desde B'], `historial completo en ${n}`);
    }
    const log = (await get(A, '/api/sync/log?kind=CONFLICT')).body.items;
    assert.ok(log.length >= 1);
  });
});
