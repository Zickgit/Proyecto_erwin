// Sincronización entre nodos (F-06, F-07).
//
//  EMISOR  : lee la outbox (cola persistente en SQLite) en orden `seq`, envía lotes a
//            POST /api/sync/receive del peer y marca ENTREGADO solo lo que el peer confirmó.
//            Si el peer no responde, los eventos siguen PENDIENTES en disco (sobreviven
//            reinicios) y se reintentan en el siguiente ciclo o al detectar PEER_UP.
//  RECEPTOR: por cada evento, en una transacción:
//            1) Deduplicación por UUID (applied_events). Repetido -> DUPLICADO, sin efecto.
//            2) Si el incidente no existe localmente -> se inserta la réplica.
//            3) Si existe -> ¿el cambio remoto se hizo sobre la misma versión que tengo?
//                 sí  -> actualización secuencial, se aplica.
//                 no  -> CONFLICTO (escrituras concurrentes durante la partición):
//                        Last Write Wins por (updated_at, updated_node).
//            4) La entrada de bitácora remota se guarda como REPLICADO (aunque pierda),
//               y si hubo conflicto se agrega una entrada SYNC_CONFLICTO con ambos valores.
import { randomUUID } from 'node:crypto';
import { tx } from '../db/tx.js';
import { CATEGORIES, PRIORITIES, STATES } from '../domain/rules.js';
import { isUuid } from '../domain/validation.js';
import { PeerUnavailableError } from '../network/netsim.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INCIDENT_FIELDS = ['id', 'category', 'priority', 'description', 'location', 'reported_at', 'status', 'assignee',
  'origin_node', 'created_by', 'created_at', 'updated_at', 'updated_by', 'updated_node', 'version'];
const AUDIT_FIELDS = ['id', 'incident_id', 'action', 'actor', 'actor_role', 'node_id', 'at', 'from_status', 'to_status', 'details'];

/** Orden total para LWW: primero la marca de tiempo, luego el id de nodo (desempate determinista). */
export function lwwCompare(a, b) {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? 1 : -1;
  if (a.updated_node !== b.updated_node) return a.updated_node > b.updated_node ? 1 : -1;
  return 0;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f] ?? null;
  return out;
}

function validateEvent(ev, sourceNode) {
  const problems = [];
  if (!ev || typeof ev !== 'object') return ['evento no es un objeto'];
  if (!isUuid(ev.eventId)) problems.push('eventId inválido');
  if (ev.sourceNode !== sourceNode) problems.push('sourceNode no coincide con X-Node-Id');
  const i = ev.incident;
  const a = ev.audit;
  if (!i || !isUuid(i.id)) problems.push('incident.id inválido');
  else {
    if (!Object.hasOwn(CATEGORIES, i.category)) problems.push('category inválida');
    if (!Object.hasOwn(PRIORITIES, i.priority)) problems.push('priority inválida');
    if (!Object.hasOwn(STATES, i.status)) problems.push('status inválido');
    if (!ISO_RE.test(i.updated_at ?? '')) problems.push('updated_at inválido');
    if (!Number.isInteger(i.version) || i.version < 1) problems.push('version inválida');
    if (typeof i.updated_node !== 'string' || typeof i.origin_node !== 'string') problems.push('nodos inválidos');
  }
  if (!a || a.id !== ev.eventId || a.incident_id !== i?.id) problems.push('audit no corresponde al evento');
  return problems;
}

export function createSyncService({ db, config, net }) {
  const self = config.nodeId;
  const running = new Map(); // peerId -> Promise (evita envíos concurrentes al mismo peer)
  const lastPushOk = new Map(); // para registrar en sync_log solo los CAMBIOS de resultado

  const q = {
    log: db.prepare('INSERT INTO sync_log (at, peer, kind, detail) VALUES (?, ?, ?, ?)'),
    pending: db.prepare(`SELECT seq, event_id, incident_id, payload FROM outbox
      WHERE target_node = ? AND state = 'PENDIENTE' ORDER BY seq LIMIT ?`),
    markDelivered: db.prepare(`UPDATE outbox SET state = 'ENTREGADO', delivered_at = ?, remote_result = ?,
      attempts = attempts + 1, last_attempt_at = ?, last_error = NULL WHERE event_id = ? AND target_node = ?`),
    markFailed: db.prepare(`UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
      WHERE target_node = ? AND state = 'PENDIENTE' AND seq <= ?`),
    stillPending: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE incident_id = ? AND state = 'PENDIENTE'"),
    markIncidentSynced: db.prepare("UPDATE incidents SET sync_state = 'SINCRONIZADO', last_synced_at = ? WHERE id = ?"),
    applied: db.prepare('SELECT result FROM applied_events WHERE event_id = ?'),
    insApplied: db.prepare(`INSERT INTO applied_events (event_id, origin_node, incident_id, event_type, received_at, result)
      VALUES (?, ?, ?, ?, ?, ?)`),
    getIncident: db.prepare('SELECT * FROM incidents WHERE id = ?'),
    insIncident: db.prepare(`INSERT INTO incidents (id, category, priority, description, location, reported_at, status, assignee,
      origin_node, created_by, created_at, updated_at, updated_by, updated_node, version, sync_state, last_synced_at)
      VALUES (:id, :category, :priority, :description, :location, :reported_at, :status, :assignee,
      :origin_node, :created_by, :created_at, :updated_at, :updated_by, :updated_node, :version, 'SINCRONIZADO', :now)`),
    overwrite: db.prepare(`UPDATE incidents SET category = :category, priority = :priority, description = :description,
      location = :location, reported_at = :reported_at, status = :status, assignee = :assignee, updated_at = :updated_at,
      updated_by = :updated_by, updated_node = :updated_node, version = :version, sync_state = :sync_state, last_synced_at = :now
      WHERE id = :id`),
    bumpVersion: db.prepare('UPDATE incidents SET version = ?, last_synced_at = ? WHERE id = ?'),
    insAudit: db.prepare(`INSERT OR IGNORE INTO audit_log
      (id, incident_id, action, actor, actor_role, node_id, at, from_status, to_status, details, source, recorded_at)
      VALUES (:id, :incident_id, :action, :actor, :actor_role, :node_id, :at, :from_status, :to_status, :details, 'REPLICADO', :recorded_at)`),
    insConflictAudit: db.prepare(`INSERT INTO audit_log
      (id, incident_id, action, actor, actor_role, node_id, at, from_status, to_status, details, source, recorded_at)
      VALUES (?, ?, 'SYNC_CONFLICTO', 'sistema', 'SISTEMA', ?, ?, ?, ?, ?, 'LOCAL', ?)`),
  };

  function log(kind, peer, detail = {}) {
    q.log.run(new Date().toISOString(), peer ?? null, kind, JSON.stringify(detail));
  }

  // Persistir la bitácora de red (caídas, recuperaciones, cortes simulados) y
  // disparar la sincronización en cuanto un peer vuelve (F-07).
  net.onEvent((ev) => {
    if (ev.type === 'PROBE') return; // las mediciones no son eventos de estado
    log(ev.type, ev.peer, ev.detail ?? {});
    if (ev.type === 'PEER_UP' && ev.peer) setImmediate(() => pushTo(ev.peer, 'RECONEXION').catch(() => {}));
  });

  // ------------------------------------------------------------------ EMISOR
  async function pushOnce(peerId, reason) {
    const summary = { peer: peerId, reason, sent: 0, delivered: 0, results: {}, error: null };
    for (;;) {
      const batch = q.pending.all(peerId, config.syncBatchSize);
      if (!batch.length) break;
      const maxSeq = batch[batch.length - 1].seq;
      const now = () => new Date().toISOString();
      let res;
      try {
        res = await net.peerFetch(peerId, '/api/sync/receive', {
          method: 'POST',
          body: { sourceNode: self, events: batch.map((b) => JSON.parse(b.payload)) },
          timeoutMs: Math.max(config.peerTimeoutMs, 3000),
        });
        if (res.status !== 200 || !Array.isArray(res.body?.results)) {
          throw new PeerUnavailableError(peerId, 'HTTP_ERROR', `HTTP ${res.status} ${res.body?.error ?? ''}`.trim());
        }
      } catch (e) {
        summary.error = e.reason ?? e.message;
        q.markFailed.run(now(), summary.error, peerId, maxSeq);
        break;
      }
      summary.sent += batch.length;
      const at = now();
      const touched = new Set();
      tx(db, () => {
        for (const r of res.body.results) {
          const row = batch.find((b) => b.event_id === r.eventId);
          if (!row) continue;
          q.markDelivered.run(at, r.result, at, r.eventId, peerId);
          summary.delivered += 1;
          summary.results[r.result] = (summary.results[r.result] ?? 0) + 1;
          touched.add(row.incident_id);
        }
        // Marca de sincronización: SINCRONIZADO cuando ya no quedan eventos pendientes del incidente.
        for (const id of touched) {
          if (q.stillPending.get(id).n === 0) q.markIncidentSynced.run(at, id);
        }
      });
      if (res.body.results.length < batch.length) break; // el peer procesó parcialmente; reintentar luego
    }

    const ok = !summary.error;
    if (summary.sent > 0 || ok !== lastPushOk.get(peerId)) {
      log(ok ? 'PUSH_OK' : 'PUSH_FAIL', peerId, summary);
    }
    lastPushOk.set(peerId, ok);
    return summary;
  }

  function pushTo(peerId, reason = 'PERIODICO') {
    if (running.has(peerId)) return running.get(peerId);
    const p = pushOnce(peerId, reason).finally(() => running.delete(peerId));
    running.set(peerId, p);
    return p;
  }

  async function pushAll(reason) {
    return Promise.all(net.peerIds().map((id) => pushTo(id, reason)));
  }

  // ---------------------------------------------------------------- RECEPTOR
  function applyEvent(ev, sourceNode) {
    const now = new Date().toISOString();
    const prior = q.applied.get(ev.eventId);
    if (prior) return { eventId: ev.eventId, result: 'DUPLICADO', previous: prior.result };

    const problems = validateEvent(ev, sourceNode);
    if (problems.length) {
      return tx(db, () => {
        if (isUuid(ev?.eventId)) q.insApplied.run(ev.eventId, sourceNode, ev.incident?.id ?? '-', ev.type ?? '-', now, 'RECHAZADO');
        return { eventId: ev?.eventId ?? null, result: 'RECHAZADO', problems };
      });
    }

    return tx(db, () => {
      const remote = pick(ev.incident, INCIDENT_FIELDS);
      const local = q.getIncident.get(remote.id);
      let result;
      let conflict = null;

      if (!local) {
        q.insIncident.run({ ...remote, now });
        result = 'APLICADO';
      } else {
        // ¿El cambio remoto se construyó sobre el mismo estado que tengo? (versión base)
        const sequential = ev.base
          ? ev.base.updatedAt === local.updated_at && ev.base.updatedNode === local.updated_node
          : remote.version === local.version + 1; // eventos sin base (compatibilidad)
        const cmp = lwwCompare(remote, local);
        const version = Math.max(local.version, remote.version);
        const localPending = q.stillPending.get(remote.id).n > 0;

        if (sequential || cmp > 0) {
          q.overwrite.run({
            ...pick(remote, ['id', 'category', 'priority', 'description', 'location', 'reported_at', 'status',
              'assignee', 'updated_at', 'updated_by', 'updated_node']),
            version, sync_state: localPending ? 'PENDIENTE' : 'SINCRONIZADO', now,
          });
          result = sequential ? 'APLICADO' : 'CONFLICTO_GANA_REMOTO';
        } else {
          // Gana la copia local: no se toca el contenido; solo se alinea la versión para converger.
          q.bumpVersion.run(version, now, remote.id);
          result = 'CONFLICTO_GANA_LOCAL';
        }
        if (!sequential) {
          const snap = (r) => ({ status: r.status, assignee: r.assignee, updatedAt: r.updated_at, updatedNode: r.updated_node, updatedBy: r.updated_by, version: r.version });
          const winner = result === 'CONFLICTO_GANA_REMOTO' ? 'REMOTO' : 'LOCAL';
          const after = winner === 'REMOTO' ? remote : local;
          conflict = {
            policy: 'LAST_WRITE_WINS(updated_at, updated_node)',
            winner,
            local: snap(local),
            remote: snap(remote),
            eventId: ev.eventId,
            fromNode: sourceNode,
          };
          q.insConflictAudit.run(randomUUID(), remote.id, self, now, local.status, after.status, JSON.stringify(conflict), now);
        }
      }

      // La entrada de bitácora del cambio remoto siempre se conserva (trazabilidad completa).
      q.insAudit.run({ ...pick(ev.audit, AUDIT_FIELDS), recorded_at: now });
      q.insApplied.run(ev.eventId, sourceNode, remote.id, ev.type ?? 'INCIDENT_UPSERT', now, result);
      if (conflict) log('CONFLICT', sourceNode, { incidentId: remote.id, ...conflict });
      return { eventId: ev.eventId, result };
    });
  }

  function receive(sourceNode, events) {
    const results = [];
    for (const ev of events) {
      try {
        results.push(applyEvent(ev, sourceNode));
      } catch (e) {
        // Error inesperado (p. ej. restricción de BD): se detiene el lote para conservar el orden.
        console.error(`[sync:${self}] error aplicando evento ${ev?.eventId}: ${e.message}`);
        break;
      }
    }
    const counts = results.reduce((acc, r) => ({ ...acc, [r.result]: (acc[r.result] ?? 0) + 1 }), {});
    log('RECEIVED', sourceNode, { received: events.length, processed: results.length, ...counts });
    return results;
  }

  // ------------------------------------------------------------------ ESTADO
  function status() {
    const perPeer = net.peerIds().map((peer) => {
      const row = db.prepare(`SELECT
          SUM(state = 'PENDIENTE') AS pending,
          SUM(state = 'ENTREGADO') AS delivered,
          MIN(CASE WHEN state = 'PENDIENTE' THEN created_at END) AS oldestPending,
          MAX(delivered_at) AS lastDeliveredAt,
          MAX(CASE WHEN state = 'PENDIENTE' THEN last_error END) AS lastError,
          MAX(CASE WHEN state = 'PENDIENTE' THEN attempts END) AS maxAttempts
        FROM outbox WHERE target_node = ?`).get(peer);
      return {
        peer,
        peerStatus: net.peerStatus(peer),
        outbox: {
          pending: row.pending ?? 0, delivered: row.delivered ?? 0, oldestPending: row.oldestPending,
          lastDeliveredAt: row.lastDeliveredAt, lastError: row.lastError, maxAttempts: row.maxAttempts ?? 0,
        },
        syncing: running.has(peer),
      };
    });
    const received = db.prepare('SELECT origin_node AS fromNode, result, COUNT(*) AS n FROM applied_events GROUP BY origin_node, result').all();
    const incidents = db.prepare(`SELECT sync_state AS state, COUNT(*) AS n FROM incidents
      WHERE origin_node = ? GROUP BY sync_state`).all(self);
    return {
      node: self,
      at: new Date().toISOString(),
      policy: {
        deduplication: 'UUID del evento (tabla applied_events)',
        conflicts: 'Last Write Wins por updated_at; desempate por updated_node (mayor gana)',
        intervalMs: config.syncIntervalMs,
      },
      peers: perPeer,
      received: received.map((r) => ({ ...r })),
      localIncidentsBySyncState: incidents.map((r) => ({ ...r })),
    };
  }

  function recentLog({ limit = 100, kind } = {}) {
    const rows = kind
      ? db.prepare('SELECT * FROM sync_log WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit)
      : db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ id: r.id, at: r.at, peer: r.peer, kind: r.kind, detail: JSON.parse(r.detail) }));
  }

  // ------------------------------------------------- RECONCILIACIÓN (T-10)
  // La sincronización normal es "push" de eventos propios. Si un nodo se restaura desde
  // un respaldo antiguo, pierde lo ocurrido después del respaldo, y los peers ya marcaron
  // esos eventos como ENTREGADOS. La reconciliación es un "pull" de anti-entropía:
  // el nodo pide a un peer TODO su estado (incidentes + bitácora) y lo fusiona:
  //   * incidente ausente -> se inserta; presente -> LWW (gana el más reciente);
  //   * entradas de bitácora -> INSERT OR IGNORE por UUID (no hay duplicados);
  //   * se registran como aplicados los UUID recuperados para que un reenvío posterior
  //     de esos eventos se reconozca como DUPLICADO.
  function exportAll() {
    return {
      node: self,
      at: new Date().toISOString(),
      incidents: db.prepare('SELECT * FROM incidents ORDER BY created_at').all().map((r) => ({ ...r })),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY at, recorded_at').all().map((r) => ({ ...r })),
    };
  }

  const qr = {
    insAuditIgnore: db.prepare(`INSERT OR IGNORE INTO audit_log
      (id, incident_id, action, actor, actor_role, node_id, at, from_status, to_status, details, source, recorded_at)
      VALUES (:id, :incident_id, :action, :actor, :actor_role, :node_id, :at, :from_status, :to_status, :details, 'REPLICADO', :recorded_at)`),
    insAppliedIgnore: db.prepare(`INSERT OR IGNORE INTO applied_events (event_id, origin_node, incident_id, event_type, received_at, result)
      VALUES (?, ?, ?, 'INCIDENT_UPSERT', ?, 'RECONCILIADO')`),
  };

  async function reconcileFrom(peerId) {
    const r = await net.peerFetch(peerId, '/api/sync/export', { timeoutMs: 15000 });
    if (r.status !== 200 || !Array.isArray(r.body?.incidents) || !Array.isArray(r.body?.audit)) {
      throw new PeerUnavailableError(peerId, 'HTTP_ERROR', `HTTP ${r.status}`);
    }
    const now = new Date().toISOString();
    const summary = { peer: peerId, incidentsInserted: 0, incidentsUpdated: 0, incidentsKept: 0, auditInserted: 0, auditAlready: 0 };
    tx(db, () => {
      for (const raw of r.body.incidents) {
        const remote = pick(raw, INCIDENT_FIELDS);
        if (!isUuid(remote.id)) continue;
        const local = q.getIncident.get(remote.id);
        if (!local) {
          q.insIncident.run({ ...remote, now });
          summary.incidentsInserted += 1;
        } else if (lwwCompare(remote, local) > 0) {
          q.overwrite.run({
            ...pick(remote, ['id', 'category', 'priority', 'description', 'location', 'reported_at', 'status',
              'assignee', 'updated_at', 'updated_by', 'updated_node']),
            version: Math.max(local.version, remote.version),
            sync_state: q.stillPending.get(remote.id).n > 0 ? 'PENDIENTE' : 'SINCRONIZADO',
            now,
          });
          summary.incidentsUpdated += 1;
        } else {
          summary.incidentsKept += 1;
        }
      }
      for (const a of r.body.audit) {
        if (!isUuid(a.id)) continue;
        const inserted = qr.insAuditIgnore.run({ ...pick(a, AUDIT_FIELDS), recorded_at: now }).changes === 1;
        if (inserted) summary.auditInserted += 1; else summary.auditAlready += 1;
        if (a.node_id !== self) qr.insAppliedIgnore.run(a.id, a.node_id, a.incident_id, now);
      }
    });
    log('RECONCILE', peerId, summary);
    return summary;
  }

  async function reconcileAll() {
    return Promise.all(net.peerIds().map(async (peer) => {
      try { return await reconcileFrom(peer); } catch (e) {
        log('RECONCILE_FAIL', peer, { error: e.reason ?? e.message });
        return { peer, error: e.reason ?? e.message };
      }
    }));
  }

  let timer = null;
  return {
    pushAll,
    pushTo,
    receive,
    status,
    recentLog,
    log,
    exportAll,
    reconcileAll,
    start() {
      timer = setInterval(() => pushAll('PERIODICO').catch(() => {}), config.syncIntervalMs);
      timer.unref();
      setImmediate(() => pushAll('ARRANQUE').catch(() => {}));
    },
    stop() { clearInterval(timer); },
  };
}
