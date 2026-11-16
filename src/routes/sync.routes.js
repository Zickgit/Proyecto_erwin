import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { httpError } from '../middleware/errors.js';
import { validateListQuery } from '../domain/validation.js';

const MAX_EVENTS = 500;

export function syncRoutes({ config, sync, aggregate, auth }) {
  const r = Router();
  const peers = new Set(config.peers.map((p) => p.id));

  // Autenticación nodo->nodo: el emisor debe ser un peer declarado y, si se configuró
  // SYNC_SECRET (variable de entorno, nunca versionada), presentar el mismo secreto.
  function peerOnly(req, res, next) {
    const from = req.get('x-node-id');
    if (!from || !peers.has(from)) {
      return res.status(403).json({ error: 'UNKNOWN_PEER', message: 'Solo nodos declarados en PEERS pueden sincronizar' });
    }
    if (config.syncSecret) {
      const got = Buffer.from(req.get('x-sync-secret') ?? '');
      const exp = Buffer.from(config.syncSecret);
      if (got.length !== exp.length || !timingSafeEqual(got, exp)) {
        return res.status(401).json({ error: 'BAD_SYNC_SECRET', message: 'Secreto de sincronización inválido' });
      }
    }
    req.peerId = from;
    next();
  }

  // Recepción de eventos de un peer (idempotente).
  r.post('/sync/receive', peerOnly, (req, res) => {
    const { sourceNode, events } = req.body ?? {};
    if (sourceNode !== req.peerId) throw httpError(400, 'SOURCE_MISMATCH', 'sourceNode no coincide con X-Node-Id');
    if (!Array.isArray(events) || events.length > MAX_EVENTS) {
      throw httpError(400, 'INVALID_BATCH', `events debe ser un arreglo de hasta ${MAX_EVENTS} elementos`);
    }
    res.json({ node: config.nodeId, results: sync.receive(sourceNode, events) });
  });

  // Exportación completa para reconciliación (solo peers declarados).
  r.get('/sync/export', peerOnly, (req, res) => {
    res.json(sync.exportAll());
  });

  // Reconciliación (pull de anti-entropía) desde todos los peers: tras restaurar un respaldo.
  r.post('/sync/reconcile', auth.authenticate, auth.authorize('sync:run'), async (req, res) => {
    const results = await sync.reconcileAll();
    res.json({ node: config.nodeId, results });
  });

  // Estado de la cola persistente y de lo recibido.
  r.get('/sync/status', auth.authenticate, auth.authorize('sync:status'), (req, res) => {
    res.json(sync.status());
  });

  // Forzar sincronización ahora (además del ciclo periódico y del disparo al reconectar).
  r.post('/sync/run', auth.authenticate, auth.authorize('sync:run'), async (req, res) => {
    const results = await sync.pushAll('MANUAL');
    res.json({ node: config.nodeId, results, status: sync.status() });
  });

  // Bitácora persistente de red y sincronización.
  r.get('/sync/log', auth.authenticate, auth.authorize('sync:status'), (req, res) => {
    const limit = Number.parseInt(req.query.limit ?? '100', 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw httpError(400, 'VALIDATION_ERROR', 'limit entre 1 y 1000');
    const kind = typeof req.query.kind === 'string' && /^[A-Z_]{3,40}$/.test(req.query.kind) ? req.query.kind : undefined;
    res.json({ node: config.nodeId, items: sync.recentLog({ limit, kind }) });
  });

  // F-05 Consulta agregada multinodo. ?replicas=false para no rellenar con réplicas locales.
  r.get('/aggregate/incidents', auth.authenticate, auth.authorize('incident:read'), async (req, res) => {
    const { replicas, ...rest } = req.query;
    const filters = validateListQuery(rest);
    res.json(await aggregate.query(req.user, filters, { includeReplicas: replicas !== 'false' }));
  });

  return r;
}
