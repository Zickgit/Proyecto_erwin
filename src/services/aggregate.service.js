// Consulta agregada distribuida (F-05, T-05, T-06).
//
// El nodo que recibe la consulta actúa como coordinador: pide a cada nodo SU partición
// (incidentes cuyo origin_node es ese nodo) EN VIVO y combina los resultados.
// Si un nodo no responde:
//   * se informa explícitamente en `sources[]` con el motivo (T-06),
//   * `complete` es false y se incluye `warning`,
//   * opcionalmente se muestran las réplicas locales de esa partición, marcadas
//     como REPLICA_LOCAL con su última sincronización (pueden estar desactualizadas).
import { toApi } from '../repositories/incidents.repo.js';
import { PeerUnavailableError } from '../network/netsim.js';

const FILTER_KEYS = ['status', 'priority', 'category', 'from', 'to', 'q'];

export function createAggregateService({ config, net, incidents }) {
  const self = config.nodeId;

  function localPartition(node, filters, servedFrom) {
    const { total, rows } = incidents.list({ ...filters, node, offset: 0 });
    return {
      total,
      items: rows.map((r) => ({
        ...toApi(r, self),
        source: { node, servedFrom, respondedBy: self },
      })),
    };
  }

  async function remotePartition(peer, filters, user) {
    const qs = new URLSearchParams({ node: peer, limit: String(filters.limit) });
    for (const k of FILTER_KEYS) if (filters[k]) qs.set(k, filters[k]);
    const r = await net.peerFetch(peer, `/api/incidents?${qs}`, { headers: { 'x-user': user.username } });
    if (r.status !== 200) {
      const err = new PeerUnavailableError(peer, 'HTTP_ERROR', `HTTP ${r.status} ${r.body?.error ?? ''}`.trim());
      throw err;
    }
    return {
      total: r.body.total,
      latencyMs: r.latencyMs,
      items: r.body.items.map((i) => ({ ...i, isLocal: false, source: { node: peer, servedFrom: 'EN_VIVO', respondedBy: peer } })),
    };
  }

  async function query(user, filters, { includeReplicas = true } = {}) {
    const nodes = [self, ...net.peerIds()].filter((n) => !filters.node || n === filters.node);
    const started = Date.now();

    const sources = await Promise.all(nodes.map(async (node) => {
      if (node === self) {
        const p = localPartition(self, filters, 'EN_VIVO');
        return { node, role: 'LOCAL', status: 'OK', servedFrom: 'EN_VIVO', total: p.total, latencyMs: 0, items: p.items };
      }
      try {
        const p = await remotePartition(node, filters, user);
        return { node, role: 'REMOTO', status: 'OK', servedFrom: 'EN_VIVO', total: p.total, latencyMs: p.latencyMs, items: p.items };
      } catch (e) {
        const reason = e instanceof PeerUnavailableError ? e.reason : 'ERROR';
        const replica = includeReplicas ? localPartition(node, filters, 'REPLICA_LOCAL') : { total: 0, items: [] };
        const lastSync = replica.items.reduce((m, i) => (i.sync.lastSyncedAt && i.sync.lastSyncedAt > m ? i.sync.lastSyncedAt : m), null);
        return {
          node, role: 'REMOTO', status: 'NO_DISPONIBLE', error: reason, detail: e.message,
          servedFrom: includeReplicas ? 'REPLICA_LOCAL' : null,
          replicaTotal: replica.total, replicaLastSyncedAt: lastSync,
          total: null, latencyMs: null, items: replica.items,
        };
      }
    }));

    const merged = sources.flatMap((s) => s.items)
      .sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : a.reportedAt > b.reportedAt ? -1 : 0))
      .slice(0, filters.limit);
    const unavailable = sources.filter((s) => s.status !== 'OK').map((s) => s.node);
    const complete = unavailable.length === 0;

    return {
      coordinator: self,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      complete,
      warning: complete ? null
        : `RESULTADO PARCIAL: no respondió ${unavailable.map((n) => `el nodo ${n}`).join(', ')}. `
          + (includeReplicas ? 'Sus datos se muestran desde la réplica local y pueden estar desactualizados.' : 'Sus datos no se incluyen.'),
      unavailableNodes: unavailable,
      sources: sources.map(({ items, ...s }) => ({ ...s, returned: items.length })),
      total: complete ? sources.reduce((acc, s) => acc + s.total, 0) : null,
      limit: filters.limit,
      items: merged,
    };
  }

  return { query };
}
