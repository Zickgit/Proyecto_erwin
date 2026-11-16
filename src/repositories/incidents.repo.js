// Acceso a datos de incidentes. Solo SQL parametrizado (sin concatenar entradas).
import { CATEGORIES, PRIORITIES, STATES, TRANSITIONS } from '../domain/rules.js';

const COLUMNS = `id, category, priority, description, location, reported_at, status, assignee,
  origin_node, created_by, created_at, updated_at, updated_by, updated_node, version, sync_state, last_synced_at`;

export function createIncidentsRepo(db) {
  const stmts = {
    insert: db.prepare(`INSERT INTO incidents (${COLUMNS}) VALUES
      (:id, :category, :priority, :description, :location, :reported_at, :status, :assignee,
       :origin_node, :created_by, :created_at, :updated_at, :updated_by, :updated_node, :version, :sync_state, :last_synced_at)`),
    get: db.prepare(`SELECT ${COLUMNS} FROM incidents WHERE id = ?`),
    update: db.prepare(`UPDATE incidents SET status = :status, assignee = :assignee, updated_at = :updated_at,
      updated_by = :updated_by, updated_node = :updated_node, version = :version, sync_state = :sync_state
      WHERE id = :id AND version = :prev_version`),
  };

  return {
    insert(row) { stmts.insert.run(row); },
    get(id) { return stmts.get.get(id) ?? null; },
    /** Actualización con control optimista: falla si otra escritura cambió la versión. */
    update(row, prevVersion) {
      const r = stmts.update.run({ ...row, prev_version: prevVersion });
      return r.changes === 1;
    },
    list(f) {
      const where = [];
      const params = {};
      if (f.status) { where.push('status = :status'); params.status = f.status; }
      if (f.priority) { where.push('priority = :priority'); params.priority = f.priority; }
      if (f.category) { where.push('category = :category'); params.category = f.category; }
      if (f.node) { where.push('origin_node = :node'); params.node = f.node; }
      if (f.from) { where.push('reported_at >= :from'); params.from = f.from; }
      if (f.to) { where.push('reported_at <= :to'); params.to = f.to; }
      if (f.q) {
        where.push("(description LIKE :q ESCAPE '\\' OR location LIKE :q ESCAPE '\\')");
        params.q = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM incidents ${w}`).get(params);
      const rows = db.prepare(`SELECT ${COLUMNS} FROM incidents ${w}
        ORDER BY reported_at DESC, id LIMIT :limit OFFSET :offset`).all({ ...params, limit: f.limit, offset: f.offset });
      return { total, rows };
    },
  };
}

/** Representación pública (JSON) de un incidente. Incluye etiquetas de texto para la UI. */
export function toApi(row, selfNodeId) {
  if (!row) return null;
  return {
    id: row.id,
    shortId: row.id.slice(0, 8),
    category: row.category,
    categoryLabel: CATEGORIES[row.category],
    priority: row.priority,
    priorityLabel: PRIORITIES[row.priority]?.label,
    description: row.description,
    location: row.location,
    reportedAt: row.reported_at,
    status: row.status,
    statusLabel: STATES[row.status]?.label,
    allowedTransitions: TRANSITIONS[row.status] ?? [],
    assignee: row.assignee,
    originNode: row.origin_node,
    isLocal: row.origin_node === selfNodeId,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    updatedNode: row.updated_node,
    version: row.version,
    sync: { state: row.sync_state, lastSyncedAt: row.last_synced_at },
  };
}
