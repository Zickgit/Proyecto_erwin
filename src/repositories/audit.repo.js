// Bitácora append-only (los triggers de la BD impiden UPDATE/DELETE).
import { STATES } from '../domain/rules.js';

export function createAuditRepo(db) {
  const ins = db.prepare(`INSERT INTO audit_log
    (id, incident_id, action, actor, actor_role, node_id, at, from_status, to_status, details, source, recorded_at)
    VALUES (:id, :incident_id, :action, :actor, :actor_role, :node_id, :at, :from_status, :to_status, :details, :source, :recorded_at)`);
  const insIgnore = db.prepare(`INSERT OR IGNORE INTO audit_log
    (id, incident_id, action, actor, actor_role, node_id, at, from_status, to_status, details, source, recorded_at)
    VALUES (:id, :incident_id, :action, :actor, :actor_role, :node_id, :at, :from_status, :to_status, :details, :source, :recorded_at)`);
  const byIncident = db.prepare('SELECT * FROM audit_log WHERE incident_id = ? ORDER BY at, recorded_at');

  return {
    insert(entry) { ins.run(entry); },
    /** Para réplicas: si la entrada ya existe (mismo UUID) no se duplica. Devuelve true si se insertó. */
    insertIfAbsent(entry) { return insIgnore.run(entry).changes === 1; },
    byIncident(id) { return byIncident.all(id); },
    list(f) {
      const where = [];
      const p = {};
      if (f.incident) { where.push('incident_id = :incident'); p.incident = f.incident; }
      if (f.node) { where.push('node_id = :node'); p.node = f.node; }
      if (f.actor) { where.push('actor = :actor'); p.actor = f.actor; }
      if (f.action) { where.push('action = :action'); p.action = f.action; }
      if (f.source) { where.push('source = :source'); p.source = f.source; }
      if (f.from) { where.push('at >= :from'); p.from = f.from; }
      if (f.to) { where.push('at <= :to'); p.to = f.to; }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_log ${w}`).get(p);
      const rows = db.prepare(`SELECT * FROM audit_log ${w} ORDER BY at DESC, recorded_at DESC LIMIT :limit OFFSET :offset`)
        .all({ ...p, limit: f.limit, offset: f.offset });
      return { total, rows };
    },
  };
}

export function auditToApi(r) {
  return {
    id: r.id,
    incidentId: r.incident_id,
    action: r.action,
    actor: r.actor,
    actorRole: r.actor_role,
    node: r.node_id,
    at: r.at,
    fromStatus: r.from_status,
    fromStatusLabel: r.from_status ? STATES[r.from_status]?.label : null,
    toStatus: r.to_status,
    toStatusLabel: r.to_status ? STATES[r.to_status]?.label : null,
    details: JSON.parse(r.details),
    source: r.source,
    recordedAt: r.recorded_at,
  };
}
