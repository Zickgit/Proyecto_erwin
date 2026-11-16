-- =====================================================================
-- Esquema relacional de UN nodo (SQLite). Cada nodo ejecuta este mismo
-- script sobre su propio archivo .db (data/nodeA.db, data/nodeB.db).
-- Prototipo académico UNACH · Laboratorio 2 · datos ficticios.
--
-- Convenciones:
--   * Identificadores de negocio: UUID v4 en texto (36 caracteres), generados
--     en el nodo de origen -> creación sin coordinación e idempotencia.
--   * Marcas de tiempo: ISO-8601 UTC con milisegundos ('2026-11-13T04:42:30.815Z');
--     su orden lexicográfico coincide con el cronológico.
--   * Los catálogos de los CHECK deben coincidir con src/domain/rules.js
--     (la migración lo verifica al arrancar).
-- =====================================================================

PRAGMA foreign_keys = ON;

-- Identidad del archivo: impide que un nodo abra la base de otro.
CREATE TABLE IF NOT EXISTS node_identity (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  node_id    TEXT NOT NULL,
  node_name  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Nodos conocidos (este nodo + peers declarados en PEERS).
CREATE TABLE IF NOT EXISTS nodes (
  node_id    TEXT PRIMARY KEY CHECK (length(node_id) BETWEEN 1 AND 16),
  name       TEXT NOT NULL,
  base_url   TEXT,
  is_self    INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- Seguridad: roles, permisos y usuarios de prueba (ficticios)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  role_code   TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  permission_code TEXT PRIMARY KEY,
  description     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code       TEXT NOT NULL REFERENCES roles(role_code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(permission_code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS users (
  username     TEXT PRIMARY KEY CHECK (length(username) BETWEEN 3 AND 32),
  display_name TEXT NOT NULL,
  role_code    TEXT NOT NULL REFERENCES roles(role_code),
  home_node    TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- ---------------------------------------------------------------------
-- Incidentes (estado actual; la historia completa vive en audit_log)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  category       TEXT NOT NULL CHECK (category IN ('INFRAESTRUCTURA','RIESGO_AMBIENTAL','SOLICITUD_APOYO','SERVICIOS_TI','OTRO')),
  priority       TEXT NOT NULL CHECK (priority IN ('BAJA','MEDIA','ALTA','CRITICA')),
  description    TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 1000),
  location       TEXT NOT NULL CHECK (length(location) BETWEEN 3 AND 120),
  reported_at    TEXT NOT NULL,                       -- cuándo ocurrió/se reportó
  status         TEXT NOT NULL DEFAULT 'NUEVO'
                 CHECK (status IN ('NUEVO','VALIDADO','ASIGNADO','EN_ATENCION','RESUELTO','CERRADO','CANCELADO')),
  assignee       TEXT,                                -- responsable ficticio
  origin_node    TEXT NOT NULL,                       -- nodo donde nació (inmutable)
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,                       -- base de Last Write Wins
  updated_by     TEXT NOT NULL,
  updated_node   TEXT NOT NULL,                       -- desempate de LWW
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  sync_state     TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (sync_state IN ('PENDIENTE','SINCRONIZADO')),
  last_synced_at TEXT,
  -- Integridad de negocio: en estos estados el responsable es obligatorio.
  CHECK (status NOT IN ('ASIGNADO','EN_ATENCION','RESUELTO') OR assignee IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_incidents_status   ON incidents(status);
CREATE INDEX IF NOT EXISTS ix_incidents_priority ON incidents(priority);
CREATE INDEX IF NOT EXISTS ix_incidents_category ON incidents(category);
CREATE INDEX IF NOT EXISTS ix_incidents_origin   ON incidents(origin_node);
CREATE INDEX IF NOT EXISTS ix_incidents_reported ON incidents(reported_at);

-- El nodo de origen y la fecha de creación nunca cambian.
CREATE TRIGGER IF NOT EXISTS trg_incidents_immutable_origin
BEFORE UPDATE OF origin_node, created_at, created_by ON incidents
WHEN NEW.origin_node IS NOT OLD.origin_node OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'origin_node, created_at y created_by son inmutables');
END;

-- ---------------------------------------------------------------------
-- Bitácora de cambios (append-only). Una fila = un cambio = un evento.
-- El mismo UUID identifica la entrada de bitácora y el evento replicado.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY CHECK (length(id) = 36),
  incident_id   TEXT NOT NULL REFERENCES incidents(id),
  action        TEXT NOT NULL CHECK (action IN ('CREAR','ASIGNAR','TRANSICION','SYNC_CONFLICTO')),
  actor         TEXT NOT NULL,
  actor_role    TEXT NOT NULL,
  node_id       TEXT NOT NULL,                        -- nodo donde ocurrió el cambio
  at            TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  details       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  source        TEXT NOT NULL DEFAULT 'LOCAL' CHECK (source IN ('LOCAL','REPLICADO')),
  recorded_at   TEXT NOT NULL                         -- cuándo lo guardó ESTE nodo
);
CREATE INDEX IF NOT EXISTS ix_audit_incident ON audit_log(incident_id, at);
CREATE INDEX IF NOT EXISTS ix_audit_at       ON audit_log(at);

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log es de solo inserción');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log es de solo inserción');
END;

-- ---------------------------------------------------------------------
-- Cola persistente de salida (transactional outbox). Se escribe en la
-- MISMA transacción que el cambio: si el peer no responde, el evento
-- permanece PENDIENTE en disco (F-06) hasta que se entregue (F-07).
-- Una fila por (evento, nodo destino).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,   -- orden de envío
  event_id      TEXT NOT NULL CHECK (length(event_id) = 36),
  target_node   TEXT NOT NULL,
  incident_id   TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  created_at    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (state IN ('PENDIENTE','ENTREGADO')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error    TEXT,
  delivered_at  TEXT,
  remote_result TEXT,                                -- APLICADO | DUPLICADO | CONFLICTO_*
  UNIQUE (event_id, target_node)
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(target_node, state, seq);

-- ---------------------------------------------------------------------
-- Eventos recibidos y aplicados (deduplicación por UUID, F-07).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applied_events (
  event_id     TEXT PRIMARY KEY CHECK (length(event_id) = 36),
  origin_node  TEXT NOT NULL,                        -- nodo que envió el evento
  incident_id  TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  result       TEXT NOT NULL                         -- APLICADO | CONFLICTO_GANA_LOCAL | CONFLICTO_GANA_REMOTO | RECHAZADO
);

-- ---------------------------------------------------------------------
-- Bitácora de red y sincronización (persistente): caídas/recuperaciones de
-- peers, cortes simulados, lotes enviados/recibidos, conflictos.
-- Sirve como evidencia de T-07, T-08 y T-09 y sobrevive a reinicios.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  peer        TEXT,
  kind        TEXT NOT NULL,   -- NODE_STARTED | PEER_UP | PEER_DOWN | LINK_CHANGED_SIMULATED | PUSH_OK | PUSH_FAIL | RECEIVED | CONFLICT ...
  detail      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
);
CREATE INDEX IF NOT EXISTS ix_sync_log_at ON sync_log(at);
