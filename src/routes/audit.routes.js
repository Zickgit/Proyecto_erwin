import { Router } from 'express';
import { auditToApi } from '../repositories/audit.repo.js';
import { isUuid } from '../domain/validation.js';
import { httpError } from '../middleware/errors.js';

const ACTIONS = ['CREAR', 'ASIGNAR', 'TRANSICION', 'SYNC_CONFLICTO'];
const SOURCES = ['LOCAL', 'REPLICADO'];

function parseQuery(q) {
  const errors = [];
  const f = {};
  if (q.incident) { if (isUuid(q.incident)) f.incident = q.incident.toLowerCase(); else errors.push({ field: 'incident', message: 'UUID inválido' }); }
  if (q.node) { if (/^[A-Za-z0-9_-]{1,16}$/.test(q.node)) f.node = q.node; else errors.push({ field: 'node', message: 'Nodo inválido' }); }
  if (q.actor) f.actor = String(q.actor).slice(0, 32);
  if (q.action) { if (ACTIONS.includes(q.action)) f.action = q.action; else errors.push({ field: 'action', message: `Permitidos: ${ACTIONS.join(', ')}` }); }
  if (q.source) { if (SOURCES.includes(q.source)) f.source = q.source; else errors.push({ field: 'source', message: `Permitidos: ${SOURCES.join(', ')}` }); }
  for (const k of ['from', 'to']) {
    if (q[k]) {
      const t = Date.parse(q[k]);
      if (Number.isNaN(t)) errors.push({ field: k, message: 'Fecha ISO-8601 inválida' });
      else f[k] = new Date(t).toISOString();
    }
  }
  f.limit = Number.parseInt(q.limit ?? '100', 10);
  f.offset = Number.parseInt(q.offset ?? '0', 10);
  if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > 500) errors.push({ field: 'limit', message: 'Entre 1 y 500' });
  if (!Number.isInteger(f.offset) || f.offset < 0) errors.push({ field: 'offset', message: 'Entero >= 0' });
  if (errors.length) throw httpError(400, 'VALIDATION_ERROR', 'Filtros de bitácora inválidos', errors);
  return f;
}

export function auditRoutes({ audit, auth, config }) {
  const r = Router();
  // F-08 Bitácora del nodo (cambios locales y replicados), filtrable.
  r.get('/audit', auth.authenticate, auth.authorize('audit:read'), (req, res) => {
    const f = parseQuery(req.query);
    const { total, rows } = audit.list(f);
    res.json({ node: config.nodeId, total, limit: f.limit, offset: f.offset, items: rows.map(auditToApi) });
  });
  return r;
}
