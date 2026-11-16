// Capa de red entre nodos con SIMULACIÓN de enlaces (Fase 2).
//
// IMPORTANTE (honestidad del alcance): los dos nodos corren en la misma máquina y se
// comunican por HTTP sobre loopback (red REAL a nivel de sockets TCP). La caída de
// enlace, la latencia y la pérdida de paquetes que se configuran aquí son SIMULADAS
// por software para emular condiciones Mesh/MANET. Matar el proceso de un nodo,
// en cambio, es una caída REAL del servicio.
//
// Toda comunicación nodo→nodo debe pasar por peerFetch() para que la simulación aplique.

export class PeerUnavailableError extends Error {
  constructor(peerId, reason, detail) {
    super(`Peer ${peerId} no disponible: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'PeerUnavailableError';
    this.peerId = peerId;
    this.reason = reason; // LINK_DOWN_SIMULATED | PACKET_LOSS_SIMULATED | TIMEOUT | CONNECTION_REFUSED | HTTP_ERROR | NETWORK_ERROR
  }
}

const MAX_EVENTS = 200;

export function createNetwork(config) {
  const self = { id: config.nodeId, name: config.nodeName };
  const events = []; // últimos eventos en memoria; los suscriptores los persisten en sync_log
  const listeners = [];

  // Estado simulado de cada enlace y estado observado de cada peer.
  const peers = new Map(
    config.peers.map((p) => [p.id, {
      id: p.id,
      url: p.url,
      link: { up: true, latencyMs: 0, jitterMs: 0, lossRate: 0 },
      status: 'unknown', // online | offline | unknown
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      lastLatencyMs: null,
      consecutiveFailures: 0,
      remote: null, // info devuelta por el /api/health del peer
    }]),
  );

  function logEvent(type, peerId, detail) {
    const ev = { at: new Date().toISOString(), node: self.id, type, peer: peerId ?? null, detail: detail ?? null };
    events.push(ev);
    if (events.length > MAX_EVENTS) events.shift();
    console.log(`[net:${self.id}] ${ev.at} ${type}${peerId ? ` peer=${peerId}` : ''}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
    for (const fn of listeners) {
      try { fn(ev); } catch (e) { console.error(`[net:${self.id}] error en suscriptor: ${e.message}`); }
    }
    return ev;
  }

  function getPeer(peerId) {
    const p = peers.get(peerId);
    if (!p) {
      const err = new Error(`Peer desconocido: ${peerId}`);
      err.status = 404;
      err.code = 'PEER_NOT_FOUND';
      throw err;
    }
    return p;
  }

  function markStatus(p, ok, info) {
    const prev = p.status;
    if (ok) {
      p.status = 'online';
      p.lastOkAt = new Date().toISOString();
      p.lastLatencyMs = info.latencyMs;
      p.consecutiveFailures = 0;
      p.lastError = null;
    } else {
      p.status = 'offline';
      p.lastErrorAt = new Date().toISOString();
      p.lastError = info.reason;
      p.consecutiveFailures += 1;
    }
    if (prev !== p.status) {
      logEvent(ok ? 'PEER_UP' : 'PEER_DOWN', p.id, ok ? { latencyMs: info.latencyMs } : { reason: info.reason });
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Petición HTTP a un peer aplicando la simulación de enlace.
   * Devuelve { status, body, latencyMs } o lanza PeerUnavailableError.
   */
  async function peerFetch(peerId, urlPath, { method = 'GET', body, headers = {}, timeoutMs = config.peerTimeoutMs } = {}) {
    const p = getPeer(peerId);
    const started = performance.now();
    try {
      if (!p.link.up) throw new PeerUnavailableError(peerId, 'LINK_DOWN_SIMULATED');
      if (p.link.lossRate > 0 && Math.random() < p.link.lossRate) {
        // Pérdida simulada: el emisor no recibe respuesta y agota su timeout (acotado para no bloquear la demo).
        await sleep(Math.min(timeoutMs, 300));
        throw new PeerUnavailableError(peerId, 'PACKET_LOSS_SIMULATED');
      }
      const delay = p.link.latencyMs + (p.link.jitterMs ? Math.random() * p.link.jitterMs : 0);
      if (delay > 0) await sleep(delay);

      let res;
      try {
        res = await fetch(`${p.url}${urlPath}`, {
          method,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'x-node-id': self.id,
            ...(config.syncSecret ? { 'x-sync-secret': config.syncSecret } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const code = e?.cause?.code;
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new PeerUnavailableError(peerId, 'TIMEOUT', `${timeoutMs} ms`);
        if (code === 'ECONNREFUSED') throw new PeerUnavailableError(peerId, 'CONNECTION_REFUSED');
        throw new PeerUnavailableError(peerId, 'NETWORK_ERROR', code || e.message);
      }
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      if (res.status === 503 && parsed?.error === 'LINK_DOWN_SIMULATED') {
        // El peer cortó el enlace desde su lado (partición simétrica).
        throw new PeerUnavailableError(peerId, 'LINK_DOWN_SIMULATED', 'rechazado por el peer');
      }
      if (res.status >= 500) throw new PeerUnavailableError(peerId, 'HTTP_ERROR', `HTTP ${res.status}`);

      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      markStatus(p, true, { latencyMs });
      return { status: res.status, body: parsed, latencyMs };
    } catch (e) {
      if (e instanceof PeerUnavailableError) markStatus(p, false, { reason: e.reason });
      throw e;
    }
  }

  /** Sondeo activo de salud a todos los peers (heartbeat). */
  async function heartbeat() {
    await Promise.all([...peers.values()].map(async (p) => {
      try {
        const r = await peerFetch(p.id, '/api/health');
        p.remote = r.body?.node ?? null;
      } catch { /* el estado ya quedó marcado como offline */ }
    }));
  }

  /** Mide latencia/fallos con N peticiones por peer (evidencia de Fase 2). */
  async function probe(count = 5) {
    const results = [];
    for (const p of peers.values()) {
      const samples = [];
      const failures = [];
      for (let i = 0; i < count; i++) {
        try {
          const r = await peerFetch(p.id, '/api/health');
          samples.push(r.latencyMs);
        } catch (e) {
          failures.push(e.reason || e.message);
        }
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
      results.push({
        peer: p.id,
        url: p.url,
        link: { ...p.link },
        sent: count,
        ok: samples.length,
        failed: failures.length,
        lossPct: Math.round((failures.length / count) * 1000) / 10,
        latencyMs: samples.length
          ? { min: sorted[0], avg: Math.round(avg * 100) / 100, max: sorted[sorted.length - 1] }
          : null,
        failureReasons: [...new Set(failures)],
      });
    }
    logEvent('PROBE', null, results.map((r) => ({ peer: r.peer, ok: r.ok, failed: r.failed, avg: r.latencyMs?.avg ?? null })));
    return results;
  }

  function setLink(peerId, patch) {
    const p = getPeer(peerId);
    const before = { ...p.link };
    if (patch.up !== undefined) p.link.up = Boolean(patch.up);
    if (patch.latencyMs !== undefined) p.link.latencyMs = patch.latencyMs;
    if (patch.jitterMs !== undefined) p.link.jitterMs = patch.jitterMs;
    if (patch.lossRate !== undefined) p.link.lossRate = patch.lossRate;
    logEvent('LINK_CHANGED_SIMULATED', peerId, { before, after: { ...p.link } });
    if (!p.link.up) markStatus(p, false, { reason: 'LINK_DOWN_SIMULATED' });
    return { ...p.link };
  }

  function isolate(isolated) {
    for (const p of peers.values()) setLink(p.id, { up: !isolated });
    logEvent(isolated ? 'NODE_ISOLATED_SIMULATED' : 'NODE_REJOINED_SIMULATED', null);
  }

  /** Middleware: rechaza tráfico entrante de un peer cuyo enlace está caído (partición simétrica). */
  function inboundGuard(req, res, next) {
    const from = req.get('x-node-id');
    if (from && peers.has(from) && !peers.get(from).link.up) {
      return res.status(503).json({ error: 'LINK_DOWN_SIMULATED', node: self.id, from });
    }
    next();
  }

  function snapshot() {
    return [...peers.values()].map((p) => ({
      id: p.id,
      url: p.url,
      status: p.status,
      link: { ...p.link },
      lastOkAt: p.lastOkAt,
      lastErrorAt: p.lastErrorAt,
      lastError: p.lastError,
      lastLatencyMs: p.lastLatencyMs,
      consecutiveFailures: p.consecutiveFailures,
      remote: p.remote,
    }));
  }

  return {
    self, peerFetch, heartbeat, probe, setLink, isolate, inboundGuard, snapshot, logEvent,
    events: () => [...events],
    peerIds: () => [...peers.keys()],
    peerStatus: (id) => peers.get(id)?.status ?? 'unknown',
    onEvent: (fn) => listeners.push(fn),
  };
}
