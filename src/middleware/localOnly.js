// Restringe rutas administrativas (simulación de red, respaldos) a la propia máquina.
// Privilegio mínimo: aunque el nodo escuche en 0.0.0.0, estas operaciones no se exponen a la LAN.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function localOnly(req, res, next) {
  if (LOOPBACK.has(req.socket.remoteAddress)) return next();
  res.status(403).json({ error: 'ADMIN_LOCAL_ONLY', message: 'Operación administrativa permitida solo desde la máquina del nodo' });
}
