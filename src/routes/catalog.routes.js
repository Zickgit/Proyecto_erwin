import { Router } from 'express';
import { CATEGORIES, PRIORITIES, STATES, TRANSITIONS, INITIAL_STATE, RESPONDERS, ROLES } from '../domain/rules.js';

export function catalogRoutes({ db, auth, config }) {
  const r = Router();

  // Catálogos para formularios y validación en el cliente.
  r.get('/catalogs', (req, res) => {
    res.json({
      categories: Object.entries(CATEGORIES).map(([code, label]) => ({ code, label })),
      priorities: Object.entries(PRIORITIES).map(([code, p]) => ({ code, label: p.label, rank: p.rank })),
      states: Object.entries(STATES).map(([code, s]) => ({ code, label: s.label, terminal: s.terminal, next: TRANSITIONS[code] })),
      initialState: INITIAL_STATE,
      responders: RESPONDERS,
    });
  });

  // Usuarios de prueba (ficticios) y matriz rol->permiso leída de la BD.
  r.get('/users', (req, res) => {
    const users = db.prepare('SELECT username, display_name AS displayName, role_code AS role, home_node AS homeNode FROM users WHERE active = 1 ORDER BY role_code, username').all();
    const matrix = db.prepare('SELECT role_code AS role, permission_code AS permission FROM role_permissions ORDER BY role_code, permission_code').all();
    const roles = Object.entries(ROLES).map(([code, label]) => ({
      code, label, permissions: matrix.filter((m) => m.role === code).map((m) => m.permission),
    }));
    res.json({ authentication: 'SIMULADA (cabecera X-User, sin contraseña; solo usuarios de prueba)', users, roles });
  });

  r.get('/me', auth.authenticate, (req, res) => {
    res.json({ ...req.user, node: config.nodeId });
  });

  return r;
}
