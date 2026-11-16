import { Router } from 'express';
import { localOnly } from '../middleware/localOnly.js';
import { httpError } from '../middleware/errors.js';

export function networkRoutes({ net }) {
  const r = Router();

  // Estado observado de cada peer (último heartbeat).
  r.get('/network/peers', (req, res) => {
    res.json({ node: net.self, peers: net.snapshot() });
  });

  // Prueba activa de latencia/fallos: GET /api/network/probe?count=10
  r.get('/network/probe', async (req, res, next) => {
    try {
      const count = Number.parseInt(req.query.count ?? '5', 10);
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        throw httpError(400, 'INVALID_COUNT', 'count debe ser un entero entre 1 y 50');
      }
      res.json({ node: net.self, at: new Date().toISOString(), results: await net.probe(count) });
    } catch (e) { next(e); }
  });

  // Bitácora de red en memoria (cambios de estado de peers y de enlaces simulados).
  r.get('/network/events', (req, res) => {
    res.json({ node: net.self, events: net.events() });
  });

  // ---- Administración de la SIMULACIÓN de red (solo loopback) ----

  // PUT /api/admin/links/B  { "up": false }  |  { "latencyMs": 200, "jitterMs": 50, "lossRate": 0.2 }
  r.put('/admin/links/:peerId', localOnly, (req, res, next) => {
    try {
      const { up, latencyMs, jitterMs, lossRate } = req.body ?? {};
      const patch = {};
      if (up !== undefined) {
        if (typeof up !== 'boolean') throw httpError(400, 'INVALID_LINK', 'up debe ser booleano');
        patch.up = up;
      }
      for (const [k, v, max] of [['latencyMs', latencyMs, 10000], ['jitterMs', jitterMs, 5000]]) {
        if (v !== undefined) {
          if (!Number.isFinite(v) || v < 0 || v > max) throw httpError(400, 'INVALID_LINK', `${k} debe estar entre 0 y ${max}`);
          patch[k] = v;
        }
      }
      if (lossRate !== undefined) {
        if (!Number.isFinite(lossRate) || lossRate < 0 || lossRate > 1) throw httpError(400, 'INVALID_LINK', 'lossRate debe estar entre 0 y 1');
        patch.lossRate = lossRate;
      }
      if (Object.keys(patch).length === 0) throw httpError(400, 'INVALID_LINK', 'Indique al menos uno: up, latencyMs, jitterMs, lossRate');
      res.json({ node: net.self, peer: req.params.peerId, link: net.setLink(req.params.peerId, patch), simulated: true });
    } catch (e) { next(e); }
  });

  // POST /api/admin/isolate { "isolated": true }  -> corta (o restablece) todos los enlaces del nodo
  r.post('/admin/isolate', localOnly, (req, res, next) => {
    try {
      const { isolated } = req.body ?? {};
      if (typeof isolated !== 'boolean') throw httpError(400, 'INVALID_BODY', 'isolated debe ser booleano');
      net.isolate(isolated);
      res.json({ node: net.self, isolated, peers: net.snapshot(), simulated: true });
    } catch (e) { next(e); }
  });

  return r;
}
