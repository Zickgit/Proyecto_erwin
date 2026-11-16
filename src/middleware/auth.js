// Autenticación SIMULADA + autorización por rol (T-12).
//
// Límite declarado: el usuario se identifica con la cabecera `X-User: <username>`
// de una lista de usuarios de prueba ficticios, sin contraseña. Esto basta para
// demostrar el control de acceso por rol en un prototipo académico; un despliegue
// real requeriría autenticación fuerte (OIDC/JWT firmados, TLS, expiración, etc.).
//
// La autorización NO usa constantes en memoria: consulta la matriz
// role_permissions almacenada en la base del nodo.

export function createAuth(db) {
  const findUser = db.prepare(`
    SELECT u.username, u.display_name AS displayName, u.role_code AS role, u.home_node AS homeNode
    FROM users u WHERE u.username = ? AND u.active = 1`);
  const findPerms = db.prepare('SELECT permission_code AS p FROM role_permissions WHERE role_code = ?');

  function authenticate(req, res, next) {
    const username = req.get('x-user');
    if (!username) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Falta la cabecera X-User (usuario de prueba)' });
    }
    const user = findUser.get(username);
    if (!user) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Usuario de prueba desconocido o inactivo' });
    }
    req.user = { ...user, permissions: findPerms.all(user.role).map((r) => r.p) };
    next();
  }

  const authorize = (permission) => (req, res, next) => {
    if (req.user?.permissions.includes(permission)) return next();
    res.status(403).json({
      error: 'FORBIDDEN',
      message: `El rol ${req.user?.role ?? '(ninguno)'} no tiene el permiso ${permission}`,
      required: permission,
    });
  };

  return { authenticate, authorize };
}
