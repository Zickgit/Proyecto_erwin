// Pruebas del Bloque 2: T-01, T-02, T-03, T-04, T-12 (+ filtros F-02 y outbox).
// Ejecutar: npm test   (levanta un nodo A de prueba en :3101 con peer B declarado pero apagado)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startNode, api, validIncident, ROOT } from './helpers.js';

let A;
const call = (method, p, opts) => api(A.url, method, p, opts);
const OP = 'op.norte';
const CO = 'coord';
const AU = 'auditor';

before(async () => { A = await startNode({ id: 'A', port: 3101, peers: { B: 3102 } }); });
after(async () => {
  await A?.stop();
  fs.rmSync(A.dir, { recursive: true, force: true });
});

describe('T-01 Registro', () => {
  it('un incidente válido recibe ID, hora, nodo y estado inicial', async () => {
    const before = Date.now();
    const r = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    assert.equal(r.status, 201);
    assert.match(r.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(r.body.status, 'NUEVO');
    assert.equal(r.body.statusLabel, 'Nuevo');
    assert.equal(r.body.originNode, 'A');
    assert.equal(r.body.isLocal, true);
    assert.equal(r.body.createdBy, OP);
    assert.equal(r.body.version, 1);
    assert.equal(r.body.sync.state, 'PENDIENTE');
    assert.ok(Date.parse(r.body.createdAt) >= before - 1000);
    assert.equal(r.headers.get('location'), `/api/incidents/${r.body.id}`);
  });

  it('es idempotente: repetir el alta con el mismo UUID no duplica', async () => {
    const id = randomUUID();
    const r1 = await call('POST', '/api/incidents', { user: OP, body: validIncident({ id }) });
    const r2 = await call('POST', '/api/incidents', { user: OP, body: validIncident({ id }) });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.idempotentReplay, true);
    assert.equal(r2.body.id, id);
    const hist = await call('GET', `/api/incidents/${id}`, { user: CO });
    assert.equal(hist.body.history.length, 1, 'solo una entrada CREAR en bitácora');
  });

  it('el mismo UUID enviado por otro usuario se rechaza (409)', async () => {
    const id = randomUUID();
    await call('POST', '/api/incidents', { user: OP, body: validIncident({ id }) });
    const r = await call('POST', '/api/incidents', { user: CO, body: validIncident({ id }) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ID_CONFLICT');
  });
});

describe('T-02 Validación', () => {
  it('rechaza campos obligatorios ausentes, indicando cada campo', async () => {
    const r = await call('POST', '/api/incidents', { user: OP, body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'VALIDATION_ERROR');
    const fields = r.body.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ['category', 'description', 'location', 'priority']);
  });

  it('rechaza prioridad y categoría inválidas', async () => {
    const r = await call('POST', '/api/incidents', { user: OP, body: validIncident({ priority: 'URGENTE', category: 'ALIENS' }) });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.details.map((d) => d.field).sort(), ['category', 'priority']);
  });

  it('rechaza estado inicial impuesto por el cliente y campos desconocidos', async () => {
    const r = await call('POST', '/api/incidents', { user: OP, body: validIncident({ status: 'CERRADO', origin_node: 'B' }) });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.details.map((d) => d.field).sort(), ['origin_node', 'status']);
  });

  it('rechaza textos fuera de rango, fecha futura e id no UUID', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const r = await call('POST', '/api/incidents', {
      user: OP, body: validIncident({ description: 'corta', location: 'x', reportedAt: future, id: '123' }),
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.details.map((d) => d.field).sort(), ['description', 'id', 'location', 'reportedAt']);
  });

  it('rechaza JSON mal formado', async () => {
    const r = await call('POST', '/api/incidents', { user: OP, raw: '{"category":' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'INVALID_JSON');
  });

  it('rechaza un estado destino inexistente', async () => {
    const c = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    const r = await call('POST', `/api/incidents/${c.body.id}/transition`, { user: CO, body: { to: 'ARCHIVADO' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.details[0].field, 'to');
  });

  it('rechaza filtros inválidos en la consulta', async () => {
    const r = await call('GET', '/api/incidents?status=FOO&priority=X', { user: OP });
    assert.equal(r.status, 400);
  });
});

describe('T-03 Transición', () => {
  it('la inválida se rechaza sin cambiar estado; la válida se guarda', async () => {
    const { body: inc } = await call('POST', '/api/incidents', { user: OP, body: validIncident() });

    const bad = await call('POST', `/api/incidents/${inc.id}/transition`, { user: CO, body: { to: 'CERRADO' } });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error, 'INVALID_TRANSITION');
    assert.deepEqual(bad.body.details.allowed, ['VALIDADO', 'CANCELADO']);
    const still = await call('GET', `/api/incidents/${inc.id}`, { user: CO });
    assert.equal(still.body.status, 'NUEVO');
    assert.equal(still.body.version, 1);
    assert.equal(still.body.history.length, 1, 'el rechazo no deja rastro de cambio');

    const ok = await call('POST', `/api/incidents/${inc.id}/transition`, { user: CO, body: { to: 'VALIDADO', note: 'Verificado por cámara' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'VALIDADO');
    assert.equal(ok.body.version, 2);
  });

  it('ciclo de vida completo Nuevo → … → Cerrado', async () => {
    const { body: inc } = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    const id = inc.id;
    assert.equal((await call('POST', `/api/incidents/${id}/transition`, { user: CO, body: { to: 'VALIDADO' } })).status, 200);

    const noAssignee = await call('POST', `/api/incidents/${id}/transition`, { user: CO, body: { to: 'ASIGNADO' } });
    assert.equal(noAssignee.status, 422, 'Asignado requiere responsable');

    const asg = await call('POST', `/api/incidents/${id}/assign`, { user: CO, body: { assignee: 'Cuadrilla de Mantenimiento 1' } });
    assert.equal(asg.status, 200);
    assert.equal(asg.body.status, 'ASIGNADO');
    for (const to of ['EN_ATENCION', 'RESUELTO', 'CERRADO']) {
      const r = await call('POST', `/api/incidents/${id}/transition`, { user: CO, body: { to } });
      assert.equal(r.status, 200, `→ ${to}`);
      assert.equal(r.body.status, to);
    }
    const term = await call('POST', `/api/incidents/${id}/transition`, { user: CO, body: { to: 'EN_ATENCION' } });
    assert.equal(term.status, 409, 'Cerrado es terminal');
  });

  it('control optimista: expectedVersion desactualizada → 409', async () => {
    const { body: inc } = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    await call('POST', `/api/incidents/${inc.id}/transition`, { user: CO, body: { to: 'VALIDADO', expectedVersion: 1 } });
    const stale = await call('POST', `/api/incidents/${inc.id}/transition`, { user: CO, body: { to: 'CANCELADO', expectedVersion: 1 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'VERSION_CONFLICT');
  });

  it('no se puede asignar si no está validado, ni con responsable inexistente', async () => {
    const { body: inc } = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    const r1 = await call('POST', `/api/incidents/${inc.id}/assign`, { user: CO, body: { assignee: 'Brigada Ambiental' } });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error, 'ASSIGN_NOT_ALLOWED');
    const r2 = await call('POST', `/api/incidents/${inc.id}/assign`, { user: CO, body: { assignee: 'Juan Pérez Real' } });
    assert.equal(r2.status, 400);
  });
});

describe('T-04 Auditoría', () => {
  it('cada modificación registra actor, hora, nodo y estado anterior/nuevo', async () => {
    const { body: inc } = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    await call('POST', `/api/incidents/${inc.id}/transition`, { user: CO, body: { to: 'VALIDADO' } });
    await call('POST', `/api/incidents/${inc.id}/assign`, { user: CO, body: { assignee: 'Soporte TI Campus', note: 'turno matutino' } });
    await call('POST', `/api/incidents/${inc.id}/assign`, { user: CO, body: { assignee: 'Servicios Generales' } });

    const { body } = await call('GET', `/api/incidents/${inc.id}`, { user: AU });
    const h = body.history;
    assert.deepEqual(h.map((e) => e.action), ['CREAR', 'TRANSICION', 'ASIGNAR', 'ASIGNAR']);
    for (const e of h) {
      assert.ok(e.actor && e.actorRole && e.node === 'A' && Date.parse(e.at), JSON.stringify(e));
      assert.equal(e.source, 'LOCAL');
    }
    assert.deepEqual([h[0].fromStatus, h[0].toStatus], [null, 'NUEVO']);
    assert.deepEqual([h[1].fromStatus, h[1].toStatus], ['NUEVO', 'VALIDADO']);
    assert.deepEqual([h[2].fromStatus, h[2].toStatus], ['VALIDADO', 'ASIGNADO']);
    assert.deepEqual([h[2].details.assigneeBefore, h[2].details.assigneeAfter], [null, 'Soporte TI Campus']);
    assert.equal(h[2].details.note, 'turno matutino');
    assert.deepEqual([h[3].fromStatus, h[3].toStatus], ['ASIGNADO', 'ASIGNADO'], 'reasignación conserva estado');
    assert.equal(h[3].details.assigneeBefore, 'Soporte TI Campus');
    assert.equal(h[1].actor, CO);
    assert.equal(h[1].actorRole, 'COORDINADOR');
    // Marcas de tiempo estrictamente crecientes
    for (let i = 1; i < h.length; i++) assert.ok(h[i].at > h[i - 1].at);

    const log = await call('GET', `/api/audit?incident=${inc.id}`, { user: AU });
    assert.equal(log.body.total, 4);
  });

  it('la bitácora es de solo inserción (trigger en la BD)', () => {
    const db = new DatabaseSync(A.dbPath);
    try {
      assert.throws(() => db.exec("UPDATE audit_log SET actor = 'intruso'"), /solo inserción/);
      assert.throws(() => db.exec('DELETE FROM audit_log'), /solo inserción/);
      assert.throws(() => db.exec("UPDATE incidents SET origin_node = 'Z'"), /inmutables/);
    } finally { db.close(); }
  });

  it('cada cambio queda encolado en la outbox para el peer B (transactional outbox)', async () => {
    const db = new DatabaseSync(A.dbPath, { readOnly: true });
    try {
      const { audits } = db.prepare('SELECT COUNT(*) AS audits FROM audit_log').get();
      const { pend } = db.prepare("SELECT COUNT(*) AS pend FROM outbox WHERE target_node = 'B' AND state = 'PENDIENTE'").get();
      const { orphan } = db.prepare('SELECT COUNT(*) AS orphan FROM audit_log a LEFT JOIN outbox o ON o.event_id = a.id WHERE o.event_id IS NULL').get();
      assert.equal(pend, audits, 'un evento pendiente por cada entrada de bitácora');
      assert.equal(orphan, 0);
    } finally { db.close(); }
    const h = await call('GET', '/api/health');
    assert.equal(h.body.database.counts.outboxPending, h.body.database.counts.auditEntries);
  });
});

describe('F-02 Consulta y filtros', () => {
  it('filtra por prioridad, categoría, nodo, texto y fecha', async () => {
    const tag = `etiqueta-${Date.now()}`;
    await call('POST', '/api/incidents', { user: OP, body: validIncident({ priority: 'CRITICA', category: 'RIESGO_AMBIENTAL', description: `Humo en laboratorio ${tag}`, reportedAt: '2026-01-15T10:00:00Z' }) });
    await call('POST', '/api/incidents', { user: OP, body: validIncident({ priority: 'BAJA', category: 'SERVICIOS_TI', description: `Proyector sin señal ${tag}` }) });

    const byText = await call('GET', `/api/incidents?q=${tag}`, { user: AU });
    assert.equal(byText.body.total, 2);
    const crit = await call('GET', `/api/incidents?q=${tag}&priority=CRITICA&category=RIESGO_AMBIENTAL`, { user: AU });
    assert.equal(crit.body.total, 1);
    assert.equal(crit.body.items[0].priorityLabel, 'Crítica');
    const byDate = await call('GET', `/api/incidents?q=${tag}&from=2026-01-15&to=2026-01-15`, { user: AU });
    assert.equal(byDate.body.total, 1);
    const otherNode = await call('GET', '/api/incidents?node=B', { user: AU });
    assert.equal(otherNode.body.total, 0);
  });

  it('el texto de búsqueda no se interpreta como SQL', async () => {
    const r = await call('GET', `/api/incidents?q=${encodeURIComponent("' OR 1=1 --")}`, { user: AU });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
  });
});

describe('T-12 Seguridad', () => {
  it('sin usuario → 401; usuario inexistente → 401', async () => {
    assert.equal((await call('GET', '/api/incidents')).status, 401);
    assert.equal((await call('GET', '/api/incidents', { user: 'hacker' })).status, 401);
  });

  it('matriz de permisos aplicada por rol', async () => {
    const { body: inc } = await call('POST', '/api/incidents', { user: OP, body: validIncident() });
    const cases = [
      [OP, 'POST', `/api/incidents/${inc.id}/transition`, { to: 'VALIDADO' }, 403],
      [OP, 'POST', `/api/incidents/${inc.id}/assign`, { assignee: 'Brigada Ambiental' }, 403],
      [OP, 'GET', '/api/audit', undefined, 403],
      [AU, 'POST', '/api/incidents', validIncident(), 403],
      [AU, 'POST', `/api/incidents/${inc.id}/transition`, { to: 'VALIDADO' }, 403],
      [AU, 'GET', '/api/audit', undefined, 200],
      [AU, 'GET', '/api/incidents', undefined, 200],
      [CO, 'POST', '/api/incidents', validIncident(), 201],
    ];
    for (const [user, method, p, body, expected] of cases) {
      const r = await call(method, p, { user, body });
      assert.equal(r.status, expected, `${user} ${method} ${p}`);
      if (expected === 403) assert.equal(r.body.error, 'FORBIDDEN');
    }
  });

  it('la matriz de permisos se lee de la base de datos', async () => {
    const r = await call('GET', '/api/users');
    const coord = r.body.roles.find((x) => x.code === 'COORDINADOR');
    assert.ok(coord.permissions.includes('incident:transition'));
    const aud = r.body.roles.find((x) => x.code === 'AUDITOR');
    assert.ok(!aud.permissions.includes('incident:create'));
  });

  it('los errores no exponen trazas internas', async () => {
    const r = await call('GET', '/api/incidents/no-es-uuid', { user: AU });
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).includes('at '), 'sin stack trace');
  });

  it('el cliente web se sirve con CSP estricta y sin código inline', async () => {
    const res = await fetch(`${A.url}/`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const html = await res.text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'sin <script> inline');
    assert.doesNotMatch(html, /\sstyle=/i, 'sin atributos style inline');
    for (const f of fs.readdirSync(path.join(ROOT, 'public/js/views'))) {
      const src = fs.readFileSync(path.join(ROOT, 'public/js/views', f), 'utf8');
      assert.doesNotMatch(src, /\sstyle="/, `${f} no debe usar style inline (lo bloquea la CSP)`);
    }
  });

  it('la configuración versionada no contiene secretos', () => {
    const allowed = new Set(['NODE_ID', 'NODE_NAME', 'HOST', 'PORT', 'DB_PATH', 'PEERS', 'PEER_TIMEOUT_MS', 'HEARTBEAT_MS', 'SYNC_INTERVAL_MS']);
    for (const f of ['config/nodeA.env', 'config/nodeB.env', '.env.example']) {
      const keys = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]);
      for (const k of keys) assert.ok(allowed.has(k), `${f}: variable inesperada ${k}`);
    }
  });
});
