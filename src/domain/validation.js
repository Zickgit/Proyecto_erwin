// Validación de entradas (T-02). Devuelve el objeto normalizado o lanza 400 con
// la lista de errores por campo. Se rechazan campos desconocidos (lista blanca).
import { CATEGORIES, PRIORITIES, STATES, RESPONDERS } from './rules.js';
import { httpError } from '../middleware/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function fail(errors) {
  throw httpError(400, 'VALIDATION_ERROR', 'La solicitud contiene datos inválidos', errors);
}

function checkBody(body, allowed, errors) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail([{ field: '(body)', message: 'Se esperaba un objeto JSON' }]);
  }
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) errors.push({ field: k, message: 'Campo no permitido' });
  }
}

function text(body, field, min, max, errors, { required = true } = {}) {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (required) errors.push({ field, message: 'Campo obligatorio' });
    return undefined;
  }
  if (typeof v !== 'string') { errors.push({ field, message: 'Debe ser texto' }); return undefined; }
  // Normaliza espacios y elimina caracteres de control.
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s.length < min || s.length > max) errors.push({ field, message: `Debe tener entre ${min} y ${max} caracteres` });
  return s;
}

function oneOf(body, field, catalog, errors, { required = true } = {}) {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (required) errors.push({ field, message: 'Campo obligatorio' });
    return undefined;
  }
  if (typeof v !== 'string' || !Object.hasOwn(catalog, v)) {
    errors.push({ field, message: `Valor inválido. Permitidos: ${Object.keys(catalog).join(', ')}` });
    return undefined;
  }
  return v;
}

function isoDate(value, field, errors) {
  if (typeof value !== 'string' || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push({ field, message: 'Fecha inválida; use ISO-8601, p. ej. 2026-11-13T10:30:00Z' });
    return undefined;
  }
  return new Date(value).toISOString();
}

function expectedVersion(body, errors) {
  const v = body.expectedVersion;
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 1) errors.push({ field: 'expectedVersion', message: 'Debe ser un entero >= 1' });
  return v;
}

/** F-01: alta de incidente. */
export function validateCreate(body) {
  const errors = [];
  checkBody(body, ['id', 'category', 'priority', 'description', 'location', 'reportedAt'], errors);
  const out = {
    category: oneOf(body, 'category', CATEGORIES, errors),
    priority: oneOf(body, 'priority', PRIORITIES, errors),
    description: text(body, 'description', 10, 1000, errors),
    location: text(body, 'location', 3, 120, errors),
  };
  if (body.id !== undefined) {
    if (!isUuid(body.id)) errors.push({ field: 'id', message: 'Debe ser un UUID v4 (clave de idempotencia)' });
    else out.id = body.id.toLowerCase();
  }
  if (body.reportedAt !== undefined) {
    const d = isoDate(body.reportedAt, 'reportedAt', errors);
    if (d && Date.parse(d) > Date.now() + FUTURE_TOLERANCE_MS) errors.push({ field: 'reportedAt', message: 'No puede estar en el futuro' });
    out.reportedAt = d;
  }
  if (errors.length) fail(errors);
  return out;
}

/** F-03: cambio de estado. */
export function validateTransition(body) {
  const errors = [];
  checkBody(body, ['to', 'note', 'expectedVersion'], errors);
  const out = {
    to: oneOf(body, 'to', STATES, errors),
    note: text(body, 'note', 1, 500, errors, { required: false }),
    expectedVersion: expectedVersion(body, errors),
  };
  if (errors.length) fail(errors);
  return out;
}

/** F-04: asignación de responsable. */
export function validateAssign(body) {
  const errors = [];
  checkBody(body, ['assignee', 'note', 'expectedVersion'], errors);
  const assignee = text(body, 'assignee', 3, 80, errors);
  if (assignee && !RESPONDERS.includes(assignee)) {
    errors.push({ field: 'assignee', message: `Responsable no reconocido. Permitidos: ${RESPONDERS.join(' | ')}` });
  }
  const out = {
    assignee,
    note: text(body, 'note', 1, 500, errors, { required: false }),
    expectedVersion: expectedVersion(body, errors),
  };
  if (errors.length) fail(errors);
  return out;
}

/** F-02: filtros de consulta. */
export function validateListQuery(q) {
  const errors = [];
  const out = {};
  const single = (k) => (Array.isArray(q[k]) ? q[k][0] : q[k]);
  for (const [k, cat] of [['status', STATES], ['priority', PRIORITIES], ['category', CATEGORIES]]) {
    const v = single(k);
    if (v !== undefined && v !== '') {
      if (!Object.hasOwn(cat, v)) errors.push({ field: k, message: `Valor inválido. Permitidos: ${Object.keys(cat).join(', ')}` });
      else out[k] = v;
    }
  }
  const node = single('node');
  if (node) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(node)) errors.push({ field: 'node', message: 'Identificador de nodo inválido' });
    else out.node = node;
  }
  for (const k of ['from', 'to']) {
    const v = single(k);
    if (v) out[k] = isoDate(/T/.test(v) ? v : `${v}T00:00:00Z`, k, errors);
  }
  // "to" con solo fecha incluye todo ese día.
  if (out.to && !/T/.test(single('to'))) out.to = new Date(Date.parse(out.to) + 86_399_999).toISOString();
  const qtext = single('q');
  if (qtext) out.q = String(qtext).slice(0, 100);
  const limit = Number.parseInt(single('limit') ?? '50', 10);
  const offset = Number.parseInt(single('offset') ?? '0', 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) errors.push({ field: 'limit', message: 'Entre 1 y 200' });
  if (!Number.isInteger(offset) || offset < 0) errors.push({ field: 'offset', message: 'Entero >= 0' });
  out.limit = limit;
  out.offset = offset;
  if (errors.length) fail(errors);
  return out;
}
