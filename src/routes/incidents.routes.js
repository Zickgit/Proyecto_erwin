import { Router } from 'express';
import { validateCreate, validateTransition, validateAssign, validateListQuery, isUuid } from '../domain/validation.js';
import { httpError } from '../middleware/errors.js';

export function incidentsRoutes({ service, auth }) {
  const r = Router();
  const { authenticate, authorize } = auth;

  const idParam = (req) => {
    const { id } = req.params;
    if (!isUuid(id)) throw httpError(400, 'INVALID_ID', 'El identificador debe ser un UUID v4');
    return id.toLowerCase();
  };

  // F-01 Registrar incidente
  r.post('/incidents', authenticate, authorize('incident:create'), (req, res) => {
    const data = validateCreate(req.body);
    const { created, incident } = service.create(req.user, data);
    res.status(created ? 201 : 200)
      .location(`/api/incidents/${incident.id}`)
      .json({ ...incident, idempotentReplay: !created });
  });

  // F-02 Consultar / filtrar (incidentes locales y réplicas que tiene este nodo)
  r.get('/incidents', authenticate, authorize('incident:read'), (req, res) => {
    res.json(service.list(validateListQuery(req.query)));
  });

  // F-02 + F-08 Detalle con historial
  r.get('/incidents/:id', authenticate, authorize('incident:read'), (req, res) => {
    res.json(service.detail(idParam(req)));
  });

  // F-04 Asignar responsable
  r.post('/incidents/:id/assign', authenticate, authorize('incident:assign'), (req, res) => {
    res.json(service.assign(req.user, idParam(req), validateAssign(req.body)));
  });

  // F-03 Cambiar estado
  r.post('/incidents/:id/transition', authenticate, authorize('incident:transition'), (req, res) => {
    res.json(service.transition(req.user, idParam(req), validateTransition(req.body)));
  });

  return r;
}
