// Manejo de errores seguro: respuestas JSON sin trazas internas.
export function notFound(req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'El cuerpo de la petición no es JSON válido' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Cuerpo de la petición demasiado grande' });
  }
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    message: status >= 500 ? 'Error interno del nodo' : err.message,
    ...(err?.details ? { details: err.details } : {}),
  });
}

export function httpError(status, code, message, details) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (details) e.details = details;
  return e;
}
