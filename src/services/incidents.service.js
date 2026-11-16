// Reglas de negocio de incidentes (F-01 a F-04, F-08).
// Cada cambio, en UNA transacción: (1) actualiza el incidente, (2) inserta la
// entrada de bitácora y (3) encola el evento para cada peer en la outbox.
import { randomUUID } from 'node:crypto';
import { tx } from '../db/tx.js';
import { INITIAL_STATE, TRANSITIONS, canTransition, STATES } from '../domain/rules.js';
import { httpError } from '../middleware/errors.js';
import { toApi } from '../repositories/incidents.repo.js';
import { auditToApi } from '../repositories/audit.repo.js';

export const EVENT_TYPE = 'INCIDENT_UPSERT';

export function createIncidentsService({ db, config, incidents, audit, outbox }) {
  const self = config.nodeId;
  const peerIds = config.peers.map((p) => p.id);

  /**
   * Marca de tiempo para LWW: nunca menor o igual que la última escritura
   * conocida del registro (evita empates/regresiones si el reloj retrocede
   * o si llegó una réplica con hora ligeramente adelantada).
   */
  function nextTimestamp(prev) {
    const now = Date.now();
    const p = prev ? Date.parse(prev) : 0;
    return new Date(Math.max(now, p + 1)).toISOString();
  }

  /**
   * Registra bitácora + encola evento de replicación con el estado completo resultante.
   * `prev` es el estado sobre el que se aplicó el cambio: el receptor lo compara con su
   * copia para distinguir una actualización secuencial de una CONCURRENTE (conflicto).
   */
  function recordChange(row, entry, prev) {
    audit.insert(entry);
    if (peerIds.length) {
      const base = prev ? { updatedAt: prev.updated_at, updatedNode: prev.updated_node, version: prev.version } : null;
      outbox.enqueue({
        eventId: entry.id,
        incidentId: row.id,
        type: EVENT_TYPE,
        createdAt: entry.at,
        payload: { eventId: entry.id, type: EVENT_TYPE, sourceNode: self, base, incident: { ...row }, audit: { ...entry } },
      }, peerIds);
    }
  }

  function auditEntry({ id, incidentId, action, user, at, from, to, details }) {
    return {
      id: id ?? randomUUID(),
      incident_id: incidentId,
      action,
      actor: user.username,
      actor_role: user.role,
      node_id: self,
      at,
      from_status: from ?? null,
      to_status: to ?? null,
      details: JSON.stringify(details ?? {}),
      source: 'LOCAL',
      recorded_at: at,
    };
  }

  function load(id) {
    const row = incidents.get(id);
    if (!row) throw httpError(404, 'INCIDENT_NOT_FOUND', `No existe el incidente ${id} en el nodo ${self}`);
    return row;
  }

  function checkVersion(row, expectedVersion) {
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw httpError(409, 'VERSION_CONFLICT',
        `El incidente cambió (versión actual ${row.version}, esperada ${expectedVersion}). Recargue e intente de nuevo.`,
        { currentVersion: row.version });
    }
  }

  function persistUpdate(row, prevVersion) {
    const ok = incidents.update({
      id: row.id, status: row.status, assignee: row.assignee, updated_at: row.updated_at,
      updated_by: row.updated_by, updated_node: row.updated_node, version: row.version, sync_state: row.sync_state,
    }, prevVersion);
    if (!ok) throw httpError(409, 'VERSION_CONFLICT', 'El incidente fue modificado de forma concurrente; intente de nuevo');
  }

  return {
    /** F-01. Idempotente si el cliente envía `id`: repetir la misma alta no duplica. */
    create(user, data) {
      return tx(db, () => {
        const id = data.id ?? randomUUID();
        const existing = incidents.get(id);
        if (existing) {
          if (existing.created_by === user.username && existing.origin_node === self) {
            return { created: false, incident: toApi(existing, self) }; // reintento idempotente
          }
          throw httpError(409, 'ID_CONFLICT', 'Ya existe un incidente con ese identificador');
        }
        const now = new Date().toISOString();
        const row = {
          id,
          category: data.category,
          priority: data.priority,
          description: data.description,
          location: data.location,
          reported_at: data.reportedAt ?? now,
          status: INITIAL_STATE,
          assignee: null,
          origin_node: self,
          created_by: user.username,
          created_at: now,
          updated_at: now,
          updated_by: user.username,
          updated_node: self,
          version: 1,
          sync_state: peerIds.length ? 'PENDIENTE' : 'SINCRONIZADO',
          last_synced_at: null,
        };
        incidents.insert(row);
        recordChange(row, auditEntry({
          incidentId: id, action: 'CREAR', user, at: now, from: null, to: INITIAL_STATE,
          details: { category: row.category, priority: row.priority, location: row.location, reportedAt: row.reported_at },
        }), null);
        return { created: true, incident: toApi(row, self) };
      });
    },

    /** F-03. Solo transiciones definidas en la máquina de estados. */
    transition(user, id, { to, note, expectedVersion }) {
      return tx(db, () => {
        const row = load(id);
        checkVersion(row, expectedVersion);
        const from = row.status;
        if (!canTransition(from, to)) {
          throw httpError(409, 'INVALID_TRANSITION',
            `Transición no permitida: ${STATES[from].label} → ${STATES[to].label}`,
            { from, to, allowed: TRANSITIONS[from] });
        }
        if (to === 'ASIGNADO' && !row.assignee) {
          throw httpError(422, 'ASSIGNEE_REQUIRED', 'Para pasar a Asignado use POST /api/incidents/:id/assign con un responsable');
        }
        const assigneeBefore = row.assignee;
        const assigneeAfter = to === 'VALIDADO' ? null : row.assignee; // liberar responsable
        const at = nextTimestamp(row.updated_at);
        const updated = {
          ...row, status: to, assignee: assigneeAfter, updated_at: at, updated_by: user.username,
          updated_node: self, version: row.version + 1, sync_state: peerIds.length ? 'PENDIENTE' : row.sync_state,
        };
        persistUpdate(updated, row.version);
        const details = { note: note ?? null, version: updated.version };
        if (assigneeBefore !== assigneeAfter) Object.assign(details, { assigneeBefore, assigneeAfter });
        recordChange(updated, auditEntry({ incidentId: id, action: 'TRANSICION', user, at, from, to, details }), row);
        return toApi(updated, self);
      });
    },

    /** F-04. Desde Validado pasa a Asignado; en Asignado/En atención reasigna sin cambiar estado. */
    assign(user, id, { assignee, note, expectedVersion }) {
      return tx(db, () => {
        const row = load(id);
        checkVersion(row, expectedVersion);
        const from = row.status;
        if (!['VALIDADO', 'ASIGNADO', 'EN_ATENCION'].includes(from)) {
          throw httpError(409, 'ASSIGN_NOT_ALLOWED',
            `No se puede asignar responsable en estado ${STATES[from].label}. Primero debe estar Validado.`, { status: from });
        }
        if (row.assignee === assignee) {
          throw httpError(409, 'NO_CHANGE', `El responsable ya es "${assignee}"`);
        }
        const to = from === 'VALIDADO' ? 'ASIGNADO' : from;
        const at = nextTimestamp(row.updated_at);
        const updated = {
          ...row, status: to, assignee, updated_at: at, updated_by: user.username,
          updated_node: self, version: row.version + 1, sync_state: peerIds.length ? 'PENDIENTE' : row.sync_state,
        };
        persistUpdate(updated, row.version);
        recordChange(updated, auditEntry({
          incidentId: id, action: 'ASIGNAR', user, at, from, to,
          details: { assigneeBefore: row.assignee, assigneeAfter: assignee, note: note ?? null, version: updated.version },
        }), row);
        return toApi(updated, self);
      });
    },

    list(filters) {
      const { total, rows } = incidents.list(filters);
      return { total, limit: filters.limit, offset: filters.offset, items: rows.map((r) => toApi(r, self)) };
    },

    /** F-02 + F-08: detalle con historial completo de trazabilidad. */
    detail(id) {
      const row = load(id);
      return { ...toApi(row, self), history: audit.byIncident(id).map(auditToApi) };
    },
  };
}
