// Reglas de negocio del ciclo de vida del incidente (Fase 1).
// Fuente única de verdad: la API, la interfaz y la documentación (docs/REGLAS.md) usan estas constantes.

export const CATEGORIES = Object.freeze({
  INFRAESTRUCTURA: 'Infraestructura',
  RIESGO_AMBIENTAL: 'Riesgo ambiental',
  SOLICITUD_APOYO: 'Solicitud de apoyo',
  SERVICIOS_TI: 'Servicios de TI',
  OTRO: 'Otro',
});

// `rank` permite ordenar; `label` asegura que la prioridad se distinga por texto, no solo por color.
export const PRIORITIES = Object.freeze({
  BAJA: { rank: 1, label: 'Baja' },
  MEDIA: { rank: 2, label: 'Media' },
  ALTA: { rank: 3, label: 'Alta' },
  CRITICA: { rank: 4, label: 'Crítica' },
});

export const STATES = Object.freeze({
  NUEVO: { label: 'Nuevo', terminal: false },
  VALIDADO: { label: 'Validado', terminal: false },
  ASIGNADO: { label: 'Asignado', terminal: false },
  EN_ATENCION: { label: 'En atención', terminal: false },
  RESUELTO: { label: 'Resuelto', terminal: false },
  CERRADO: { label: 'Cerrado', terminal: true },
  CANCELADO: { label: 'Cancelado', terminal: true },
});

export const INITIAL_STATE = 'NUEVO';

// Máquina de estados: origen -> destinos válidos.
export const TRANSITIONS = Object.freeze({
  NUEVO: ['VALIDADO', 'CANCELADO'],
  VALIDADO: ['ASIGNADO', 'CANCELADO'],
  ASIGNADO: ['EN_ATENCION', 'VALIDADO', 'CANCELADO'], // VALIDADO = liberar responsable
  EN_ATENCION: ['RESUELTO', 'ASIGNADO'],              // ASIGNADO = devolver/reasignar
  RESUELTO: ['CERRADO', 'EN_ATENCION'],               // EN_ATENCION = reabrir
  CERRADO: [],
  CANCELADO: [],
});

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

// Roles mínimos (usuarios de prueba ficticios) y su matriz de permisos.
export const ROLES = Object.freeze({
  OPERADOR: 'Operador',       // registra incidentes
  COORDINADOR: 'Coordinador', // valida, asigna y cambia estados
  AUDITOR: 'Auditor',         // consulta historial y bitácora
});

// Matriz rol -> permiso. Se siembra en las tablas roles/permissions/role_permissions
// y la autorización en tiempo de ejecución consulta la BASE DE DATOS.
export const PERMISSIONS = Object.freeze({
  'incident:create': { description: 'Registrar incidentes', roles: ['OPERADOR', 'COORDINADOR'] },
  'incident:read': { description: 'Consultar y filtrar incidentes', roles: ['OPERADOR', 'COORDINADOR', 'AUDITOR'] },
  'incident:assign': { description: 'Asignar responsable', roles: ['COORDINADOR'] },
  'incident:transition': { description: 'Cambiar estado', roles: ['COORDINADOR'] },
  'audit:read': { description: 'Consultar bitácora', roles: ['COORDINADOR', 'AUDITOR'] },
  'sync:status': { description: 'Consultar estado de sincronización', roles: ['COORDINADOR', 'AUDITOR'] },
  'sync:run': { description: 'Forzar sincronización manual', roles: ['COORDINADOR'] },
});

export function hasPermission(role, permission) {
  return Boolean(PERMISSIONS[permission]?.roles.includes(role));
}

// Usuarios de prueba (personas FICTICIAS). Autenticación simulada por cabecera X-User.
export const TEST_USERS = Object.freeze([
  { username: 'op.norte', displayName: 'Ana Ficticia (Operadora, Sector Norte)', role: 'OPERADOR', homeNode: 'A' },
  { username: 'op.sur', displayName: 'Beto Ficticio (Operador, Sector Sur)', role: 'OPERADOR', homeNode: 'B' },
  { username: 'coord', displayName: 'Carla Ficticia (Coordinadora)', role: 'COORDINADOR', homeNode: null },
  { username: 'auditor', displayName: 'Dante Ficticio (Auditor)', role: 'AUDITOR', homeNode: null },
]);

// Responsables ficticios asignables (F-04).
export const RESPONDERS = Object.freeze([
  'Cuadrilla de Mantenimiento 1',
  'Cuadrilla de Mantenimiento 2',
  'Brigada Ambiental',
  'Soporte TI Campus',
  'Protección Civil (simulada)',
  'Servicios Generales',
]);
