// Aplica schema.sql (idempotente) y siembra catálogos de seguridad y nodos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx } from './tx.js';
import { CATEGORIES, PRIORITIES, STATES, ROLES, PERMISSIONS, TEST_USERS } from '../domain/rules.js';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
export const SCHEMA_VERSION = 3;

export function migrate(db, config) {
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  verifyCatalogs(db);

  const now = new Date().toISOString();
  tx(db, () => {
    // Nodos conocidos
    const upNode = db.prepare(`
      INSERT INTO nodes (node_id, name, base_url, is_self, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
        is_self = excluded.is_self, updated_at = excluded.updated_at`);
    upNode.run(config.nodeId, config.nodeName, `http://${config.host}:${config.port}`, 1, now);
    for (const p of config.peers) upNode.run(p.id, `Nodo ${p.id}`, p.url, 0, now);

    // Roles, permisos y matriz (se re-sincroniza con rules.js en cada arranque)
    const upRole = db.prepare('INSERT INTO roles (role_code, description) VALUES (?, ?) ON CONFLICT(role_code) DO UPDATE SET description = excluded.description');
    for (const [code, desc] of Object.entries(ROLES)) upRole.run(code, desc);

    const upPerm = db.prepare('INSERT INTO permissions (permission_code, description) VALUES (?, ?) ON CONFLICT(permission_code) DO UPDATE SET description = excluded.description');
    db.exec('DELETE FROM role_permissions');
    const insRP = db.prepare('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?)');
    for (const [code, { description, roles }] of Object.entries(PERMISSIONS)) {
      upPerm.run(code, description);
      for (const r of roles) insRP.run(r, code);
    }

    // Usuarios de prueba ficticios
    const upUser = db.prepare(`
      INSERT INTO users (username, display_name, role_code, home_node, active) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role_code = excluded.role_code, home_node = excluded.home_node`);
    for (const u of TEST_USERS) upUser.run(u.username, u.displayName, u.role, u.homeNode);
  });
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// Garantiza que los CHECK del SQL y las constantes de rules.js no diverjan.
function verifyCatalogs(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'incidents'").get().sql;
  const missing = [
    ...Object.keys(CATEGORIES), ...Object.keys(PRIORITIES), ...Object.keys(STATES),
  ].filter((code) => !sql.includes(`'${code}'`));
  if (missing.length) {
    throw new Error(`schema.sql no coincide con rules.js; faltan en los CHECK: ${missing.join(', ')}`);
  }
}
