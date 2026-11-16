// Tablero (F-02, F-05): filtros, modo "Agregada (todos los nodos)" o "Solo este nodo",
// origen de cada dato, marca de sincronización, fuente (en vivo / réplica) y avisos de resultado parcial.
import { api, qs } from '../api.js';
import { esc, statusBadge, priorityBadge, originBadge, syncBadge, sourceBadge, fmt, ago, optionList, errorMessage, setHtml } from '../ui.js';

const filters = { mode: 'aggregate', status: '', priority: '', category: '', node: '', from: '', to: '', q: '' };

export function render(main, ctx) {
  const { catalogs } = ctx.state;
  if (!ctx.can('incident:read')) {
    main.innerHTML = '<div class="panel">Su rol no puede consultar incidentes.</div>';
    return null;
  }
  const nodeOpts = [ctx.state.node?.id, ...ctx.state.peers.map((p) => p.id)].filter(Boolean).map((n) => ({ value: n, label: `Nodo ${n}` }));

  main.innerHTML = `
    <section class="panel">
      <div class="row">
        <h1>Tablero de incidentes</h1>
        <span class="spacer"></span>
        ${ctx.can('incident:create') ? '<a class="btn" href="#/nuevo">+ Registrar incidente</a>' : ''}
      </div>
      <form id="filters" class="filters" role="search" aria-label="Filtros">
        <div class="field full">
          <span>Alcance de la consulta</span>
          <div class="segmented" role="radiogroup" aria-label="Alcance">
            <label><input type="radio" name="mode" value="aggregate"${filters.mode === 'aggregate' ? ' checked' : ''}><span>Agregada · todos los nodos (en vivo)</span></label>
            <label><input type="radio" name="mode" value="local"${filters.mode === 'local' ? ' checked' : ''}><span>Solo este nodo (incluye réplicas)</span></label>
          </div>
        </div>
        <label class="field"><span>Estado</span><select name="status">${optionList(catalogs.states.map((s) => ({ value: s.code, label: s.label })), filters.status, { empty: 'Todos' })}</select></label>
        <label class="field"><span>Prioridad</span><select name="priority">${optionList(catalogs.priorities.map((p) => ({ value: p.code, label: p.label })), filters.priority, { empty: 'Todas' })}</select></label>
        <label class="field"><span>Categoría</span><select name="category">${optionList(catalogs.categories.map((c) => ({ value: c.code, label: c.label })), filters.category, { empty: 'Todas' })}</select></label>
        <label class="field"><span>Nodo de origen</span><select name="node">${optionList(nodeOpts, filters.node, { empty: 'Todos' })}</select></label>
        <label class="field"><span>Desde</span><input type="date" name="from" value="${esc(filters.from)}"></label>
        <label class="field"><span>Hasta</span><input type="date" name="to" value="${esc(filters.to)}"></label>
        <label class="field wide"><span>Buscar texto</span><input type="search" name="q" maxlength="100" placeholder="Descripción o ubicación" value="${esc(filters.q)}"></label>
      </form>
      <div id="result" aria-live="polite"><div class="loading">Consultando…</div></div>
    </section>`;

  const form = main.querySelector('#filters');
  let seq = 0;

  async function load() {
    const mySeq = ++seq;
    const params = { status: filters.status, priority: filters.priority, category: filters.category, node: filters.node, from: filters.from, to: filters.to, q: filters.q, limit: 200 };
    const url = filters.mode === 'aggregate' ? `/api/aggregate/incidents${qs(params)}` : `/api/incidents${qs(params)}`;
    try {
      const data = await api(url, { timeout: 10000 });
      if (mySeq !== seq) return;
      setHtml(main.querySelector('#result'), filters.mode === 'aggregate' ? renderAggregate(data) : renderLocal(data, ctx));
    } catch (e) {
      if (mySeq !== seq) return;
      setHtml(main.querySelector('#result'), `<div class="banner bad" role="alert"><span class="icon">⛔</span><div>
        <strong>No se pudo consultar.</strong> ${esc(errorMessage(e))}</div></div>`);
    }
  }

  form.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.name) return;
    filters[el.name] = el.value;
    if (el.name === 'q') { clearTimeout(form._t); form._t = setTimeout(load, 300); } else load();
  });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); load(); });
  main.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (tr && !ev.target.closest('a')) ctx.navigate(`#/incidente/${tr.dataset.id}`);
  });
  main.addEventListener('keydown', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); ctx.navigate(`#/incidente/${tr.dataset.id}`); }
  });

  load();
  const timer = setInterval(load, 5000);
  return () => clearInterval(timer);
}

function renderSources(data) {
  const items = data.sources.map((s) => {
    if (s.status === 'OK') {
      return `<div class="source ok"><span class="badge kind-ok">✓ Nodo ${esc(s.node)}</span>
        <span>${s.role === 'LOCAL' ? 'Este nodo' : 'Respondió en vivo'}${s.latencyMs ? ` · ${esc(Math.round(s.latencyMs))} ms` : ''}</span>
        <span class="muted">${esc(s.total)} registro(s)</span></div>`;
    }
    return `<div class="source bad"><span class="badge kind-bad">✖ Nodo ${esc(s.node)} NO DISPONIBLE</span>
      <span>Motivo: <strong>${esc(s.error)}</strong></span>
      <span class="muted">${s.servedFrom === 'REPLICA_LOCAL'
        ? `Se muestran ${esc(s.returned)} registro(s) de la réplica local${s.replicaLastSyncedAt ? `, sincronizada ${esc(ago(s.replicaLastSyncedAt))}` : ''}; pueden estar desactualizados.`
        : 'Sus datos no se incluyen.'}</span></div>`;
  }).join('');
  return `<div class="sources" aria-label="Fuentes consultadas">${items}</div>`;
}

function renderAggregate(data) {
  const warn = data.complete ? '' : `<div class="banner warn" role="alert"><span class="icon" aria-hidden="true">⚠</span><div>
    <strong>Resultado PARCIAL: la consulta no está completa.</strong> ${esc(data.warning.replace(/^RESULTADO PARCIAL:\s*/, ''))}</div></div>`;
  const head = data.complete
    ? `<p class="small muted">Consulta agregada completa · coordinó el Nodo ${esc(data.coordinator)} en ${esc(data.elapsedMs)} ms · ${esc(data.total)} incidente(s) en total.</p>`
    : `<p class="small muted">Consulta agregada coordinada por el Nodo ${esc(data.coordinator)} · total desconocido mientras falte un nodo · ${esc(data.items.length)} mostrado(s).</p>`;
  return warn + renderSources(data) + head + renderStats(data.items) + renderTable(data.items, true);
}

function renderLocal(data, ctx) {
  return `<div class="banner info"><span class="icon" aria-hidden="true">ℹ</span><div>
      Mostrando lo almacenado en el <strong>Nodo ${esc(ctx.state.node?.id)}</strong>: sus incidentes y las réplicas recibidas.
      Las réplicas pueden no reflejar cambios recientes de otros nodos.</div></div>
    <p class="small muted">${esc(data.total)} incidente(s).</p>` + renderStats(data.items) + renderTable(data.items, false);
}

function renderStats(items) {
  const by = {};
  for (const i of items) by[i.statusLabel] = (by[i.statusLabel] ?? 0) + 1;
  const pending = items.filter((i) => i.sync?.state === 'PENDIENTE').length;
  return `<div class="stats">${Object.entries(by).map(([k, v]) => `<span class="stat">${esc(k)}<b>${v}</b></span>`).join('')}
    <span class="stat">Pendientes de sincronizar<b>${pending}</b></span></div>`;
}

function renderTable(items, aggregate) {
  if (!items.length) return '<div class="empty">No hay incidentes con estos filtros.</div>';
  const rows = items.map((i) => `
    <tr data-id="${esc(i.id)}" tabindex="0" aria-label="Incidente ${esc(i.shortId)}: ${esc(i.description)}">
      <td data-label="ID"><span class="id">${esc(i.shortId)}</span></td>
      <td class="desc" data-label="Descripción">${esc(i.description)}<div class="small muted">${esc(i.categoryLabel)} · ${esc(i.location)}</div></td>
      <td data-label="Estado">${statusBadge(i.status, i.statusLabel)}</td>
      <td data-label="Prioridad">${priorityBadge(i.priority, i.priorityLabel)}</td>
      <td data-label="Origen">${originBadge(i.originNode, i.isLocal)}</td>
      <td data-label="Sincronización">${syncBadge(i.sync)}</td>
      ${aggregate ? `<td data-label="Fuente">${sourceBadge(i.source)}</td>` : ''}
      <td data-label="Reportado"><span title="${esc(i.reportedAt)}">${esc(fmt(i.reportedAt))}</span></td>
      <td data-label="Responsable">${esc(i.assignee ?? '—')}</td>
    </tr>`).join('');
  return `<table class="list">
    <thead><tr><th>ID</th><th>Descripción</th><th>Estado</th><th>Prioridad</th><th>Origen</th><th>Sincronización</th>${aggregate ? '<th>Fuente</th>' : ''}<th>Reportado</th><th>Responsable</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
