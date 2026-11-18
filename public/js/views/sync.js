// Red y sincronización (F-06, F-07): estado de la cola persistente por peer, sincronización
// manual, controles de SIMULACIÓN de red (solo desde la máquina del nodo) y bitácora persistente.
import { api, qs } from '../api.js';
import { esc, fmt, ago, toast, errorMessage, setHtml } from '../ui.js';

const KIND_CLASS = {
  PEER_UP: 'kind-ok', PUSH_OK: 'kind-ok', NODE_REJOINED_SIMULATED: 'kind-ok',
  PEER_DOWN: 'kind-bad', PUSH_FAIL: 'kind-bad', CONFLICT: 'kind-bad', NODE_ISOLATED_SIMULATED: 'kind-bad',
  LINK_CHANGED_SIMULATED: 'kind-warn', RECEIVED: 'kind', NODE_STARTED: 'kind',
  RECONCILE: 'kind-ok', RECONCILE_FAIL: 'kind-bad', CLOCK_SKEW: 'kind-warn', CLOCK_OK: 'kind-ok',
};
const KIND_LABEL = {
  PEER_UP: 'Peer recuperado', PEER_DOWN: 'Peer caído', PUSH_OK: 'Envío correcto', PUSH_FAIL: 'Envío fallido',
  RECEIVED: 'Lote recibido', CONFLICT: 'Conflicto resuelto', NODE_STARTED: 'Nodo iniciado',
  LINK_CHANGED_SIMULATED: 'Enlace modificado (simulado)', NODE_ISOLATED_SIMULATED: 'Nodo aislado (simulado)',
  NODE_REJOINED_SIMULATED: 'Nodo reintegrado (simulado)',
  RECONCILE: 'Reconciliación', RECONCILE_FAIL: 'Reconciliación fallida',
  CLOCK_SKEW: 'Reloj desincronizado', CLOCK_OK: 'Reloj sincronizado',
};

let kindFilter = '';
const openSims = new Set(); // paneles de simulación abiertos (sobreviven al refresco periódico)

export function render(main, ctx) {
  if (!ctx.can('sync:status')) {
    main.innerHTML = '<section class="panel">Su rol no puede ver el estado de sincronización.</section>';
    return null;
  }
  main.innerHTML = `
    <section class="panel">
      <div class="row"><h1>Red y sincronización · Nodo ${esc(ctx.state.node?.id)}</h1><span class="spacer"></span>
        ${ctx.can('sync:run') ? '<button class="btn" id="run">⟳ Sincronizar ahora</button><button class="btn secondary" id="reconcile" title="Tras restaurar un respaldo: recupera desde los peers lo que falte">Reconciliar desde peers</button>' : ''}
        <button class="btn secondary" id="probe">Medir latencia</button></div>
      <p class="small muted">Política: deduplicación por UUID del evento; conflictos por «gana la última escritura» (marca de tiempo; desempate por id de nodo).</p>
      <div id="peers" class="cards"><div class="loading">Cargando…</div></div>
      <div id="probe-out"></div>
      <h2>Bitácora de red y sincronización (persistente)</h2>
      <div class="row"><label class="field"><span>Tipo</span><select id="kind">
        <option value="">Todos</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}"${k === kindFilter ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select></label></div>
      <div id="log" class="table-wrap"></div>
    </section>`;

  async function load() {
    try {
      const [status, net, log] = await Promise.all([
        api('/api/sync/status'), api('/api/network/peers'), api(`/api/sync/log${qs({ limit: 60, kind: kindFilter })}`),
      ]);
      setHtml(main.querySelector('#peers'), status.peers.map((p) => peerCard(p, net.peers.find((x) => x.id === p.peer), status)).join('')
        || '<div class="card">Este nodo no tiene peers configurados.</div>');
      setHtml(main.querySelector('#log'), logTable(log.items));
    } catch (e) {
      setHtml(main.querySelector('#peers'), `<div class="banner bad"><span class="icon">⛔</span><div>${esc(errorMessage(e))}</div></div>`);
    }
  }

  main.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      if (b.id === 'run') {
        b.disabled = true;
        const r = await api('/api/sync/run', { method: 'POST' });
        const msg = r.results.map((x) => (x.error ? `${x.peer}: falló (${x.error})` : `${x.peer}: ${x.delivered} entregado(s)`)).join(' · ');
        toast(msg || 'Sin peers', r.results.some((x) => x.error) ? 'bad' : 'ok');
        b.disabled = false;
      } else if (b.id === 'reconcile') {
        b.disabled = true;
        const r = await api('/api/sync/reconcile', { method: 'POST', timeout: 20000 });
        toast(r.results.map((x) => (x.error ? `${x.peer}: falló (${x.error})`
          : `${x.peer}: +${x.incidentsInserted} incidentes, ${x.incidentsUpdated} actualizados, +${x.auditInserted} entradas de bitácora`)).join(' · '),
        r.results.some((x) => x.error) ? 'bad' : 'ok');
        b.disabled = false;
      } else if (b.id === 'probe') {
        const r = await api('/api/network/probe?count=5', { timeout: 20000 });
        main.querySelector('#probe-out').innerHTML = `<div class="banner info"><span class="icon">⏱</span><div>${r.results.map((x) =>
          `<strong>${esc(r.node.id)} → ${esc(x.peer)}</strong>: ${esc(x.ok)}/${esc(x.sent)} OK, pérdida ${esc(x.lossPct)} %${x.latencyMs
            ? `, latencia mín/prom/máx ${esc(x.latencyMs.min)} / ${esc(x.latencyMs.avg)} / ${esc(x.latencyMs.max)} ms` : ''}${x.failureReasons.length ? ` (${esc(x.failureReasons.join(', '))})` : ''}`).join('<br>')}</div></div>`;
      } else if (b.dataset.link) {
        const body = JSON.parse(b.dataset.body);
        await api(`/api/admin/links/${encodeURIComponent(b.dataset.link)}`, { method: 'PUT', body });
        toast(`Simulación aplicada al enlace con Nodo ${b.dataset.link}`, 'ok');
        ctx.refreshConnectivity();
      }
      load();
    } catch (e) {
      b.disabled = false;
      toast(e.code === 'ADMIN_LOCAL_ONLY' ? 'La simulación de red solo se permite desde la máquina del nodo.' : errorMessage(e), 'bad');
    }
  });
  main.querySelector('#kind').addEventListener('change', (ev) => { kindFilter = ev.target.value; load(); });
  main.addEventListener('toggle', (ev) => {
    const peer = ev.target.dataset?.sim;
    if (peer) { if (ev.target.open) openSims.add(peer); else openSims.delete(peer); }
  }, true);

  load();
  const t = setInterval(load, 3000);
  return () => clearInterval(t);
}

function peerCard(p, net, status) {
  const online = p.peerStatus === 'online';
  const link = net?.link ?? { up: true, latencyMs: 0, lossRate: 0 };
  const recv = status.received.filter((r) => r.fromNode === p.peer);
  const btn = (label, body, cls = 'secondary') =>
    `<button class="btn ${cls}" data-link="${esc(p.peer)}" data-body='${esc(JSON.stringify(body))}'>${esc(label)}</button>`;
  return `<div class="card">
    <div class="row"><strong>Nodo ${esc(status.node)} → Nodo ${esc(p.peer)}</strong><span class="spacer"></span>
      <span class="badge ${online ? 'kind-ok' : 'kind-bad'}">${online ? '● En línea' : '✖ No disponible'}</span></div>
    <div class="row mt10">
      <div><div class="metric">${esc(p.outbox.pending)}</div><div class="small muted">Pendientes en cola</div></div>
      <div><div class="metric">${esc(p.outbox.delivered)}</div><div class="small muted">Entregados</div></div>
    </div>
    <dl class="kv small">
      <dt>Más antiguo pendiente</dt><dd>${p.outbox.oldestPending ? `${esc(fmt(p.outbox.oldestPending))} (${esc(ago(p.outbox.oldestPending))})` : '—'}</dd>
      <dt>Último error</dt><dd>${esc(p.outbox.lastError ?? '—')}${p.outbox.maxAttempts ? ` · ${esc(p.outbox.maxAttempts)} intento(s)` : ''}</dd>
      <dt>Última entrega</dt><dd>${esc(fmt(p.outbox.lastDeliveredAt))}</dd>
      <dt>Recibido de ${esc(p.peer)}</dt><dd>${recv.length ? recv.map((r) => `${esc(r.result)}: ${esc(r.n)}`).join(' · ') : '—'}</dd>
      <dt>Desfase de reloj</dt><dd>${net?.clockSkewMs == null ? '—' : `${esc(net.clockSkewMs)} ms${Math.abs(net.clockSkewMs) > net.clockSkewWarnMs ? ' <strong>(DESINCRONIZADO)</strong>' : ' (aceptable)'}`}</dd>
      <dt>URL del peer</dt><dd>${esc(net?.url ?? '—')}</dd>
      <dt>Enlace (simulación)</dt><dd>${link.up ? 'Activo' : '<strong>CORTADO</strong>'} · latencia ${esc(link.latencyMs)} ms · pérdida ${esc(Math.round(link.lossRate * 100))} %</dd>
    </dl>
    <details data-sim="${esc(p.peer)}"${openSims.has(p.peer) ? ' open' : ''}><summary class="small">Simulación de red (SIMULADO, solo desde esta máquina)</summary>
      <div class="row mt10">
        ${link.up ? btn('Cortar enlace', { up: false }, 'danger') : btn('Restablecer enlace', { up: true }, '')}
        ${btn('Degradar (300 ms, 20 % pérdida)', { latencyMs: 300, jitterMs: 50, lossRate: 0.2 })}
        ${btn('Normalizar', { latencyMs: 0, jitterMs: 0, lossRate: 0 }, 'ghost')}
      </div></details>
  </div>`;
}

function logTable(items) {
  if (!items.length) return '<div class="empty">Sin eventos.</div>';
  return `<table class="simple"><thead><tr><th>Hora</th><th>Tipo</th><th>Peer</th><th>Detalle</th></tr></thead><tbody>
    ${items.map((x) => `<tr><td>${esc(fmt(x.at))}</td>
      <td><span class="badge ${KIND_CLASS[x.kind] ?? 'kind'}">${esc(KIND_LABEL[x.kind] ?? x.kind)}</span></td>
      <td>${esc(x.peer ?? '—')}</td><td><code>${esc(summary(x))}</code></td></tr>`).join('')}
  </tbody></table>`;
}

function summary(x) {
  const d = x.detail ?? {};
  switch (x.kind) {
    case 'PUSH_OK': return `motivo=${d.reason} enviados=${d.sent} entregados=${d.delivered} ${JSON.stringify(d.results ?? {})}`;
    case 'PUSH_FAIL': return `motivo=${d.reason} error=${d.error}`;
    case 'PEER_DOWN': return `causa=${d.reason}`;
    case 'PEER_UP': return `latencia=${d.latencyMs} ms`;
    case 'CONFLICT': return `incidente=${String(d.incidentId).slice(0, 8)} ganó=${d.winner} local=${d.local?.status} remoto=${d.remote?.status}`;
    default: return JSON.stringify(d);
  }
}
