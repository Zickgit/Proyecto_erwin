// Bitácora del nodo (F-08): cambios locales y replicados con actor, hora, nodo y estados.
import { api, qs } from '../api.js';
import { esc, fmt, statusBadge, errorMessage, optionList, setHtml } from '../ui.js';

const f = { action: '', source: '', node: '', actor: '' };
const ACTIONS = [
  { value: 'CREAR', label: 'Registro' }, { value: 'ASIGNAR', label: 'Asignación' },
  { value: 'TRANSICION', label: 'Cambio de estado' }, { value: 'SYNC_CONFLICTO', label: 'Conflicto de sincronización' },
];

export function render(main, ctx) {
  if (!ctx.can('audit:read')) {
    main.innerHTML = '<section class="panel">Su rol no puede consultar la bitácora.</section>';
    return null;
  }
  const nodes = [ctx.state.node?.id, ...ctx.state.peers.map((p) => p.id)].filter(Boolean).map((n) => ({ value: n, label: `Nodo ${n}` }));
  main.innerHTML = `
    <section class="panel">
      <h1>Bitácora del Nodo ${esc(ctx.state.node?.id)}</h1>
      <p class="small muted">Registro de solo inserción. «Local» = el cambio ocurrió en este nodo; «Replicado» = llegó por sincronización (se indica cuándo se recibió).</p>
      <form id="af" class="filters">
        <label class="field"><span>Acción</span><select name="action">${optionList(ACTIONS, f.action, { empty: 'Todas' })}</select></label>
        <label class="field"><span>Procedencia</span><select name="source">${optionList([{ value: 'LOCAL', label: 'Local' }, { value: 'REPLICADO', label: 'Replicado' }], f.source, { empty: 'Todas' })}</select></label>
        <label class="field"><span>Nodo donde ocurrió</span><select name="node">${optionList(nodes, f.node, { empty: 'Todos' })}</select></label>
        <label class="field"><span>Actor</span><select name="actor">${optionList([...ctx.state.users.map((u) => ({ value: u.username, label: u.username })), { value: 'sistema', label: 'sistema' }], f.actor, { empty: 'Todos' })}</select></label>
      </form>
      <div id="out" class="table-wrap"><div class="loading">Cargando…</div></div>
    </section>`;

  async function load() {
    try {
      const r = await api(`/api/audit${qs({ ...f, limit: 200 })}`);
      setHtml(main.querySelector('#out'), r.items.length ? `<p class="small muted">${esc(r.total)} entrada(s); se muestran ${esc(r.items.length)}.</p>
        <table class="simple"><thead><tr><th>Hora</th><th>Acción</th><th>Incidente</th><th>Actor</th><th>Nodo</th><th>Estado anterior → nuevo</th><th>Procedencia</th><th>Detalle</th></tr></thead><tbody>
        ${r.items.map((e) => `<tr>
          <td>${esc(fmt(e.at))}</td>
          <td>${esc(ACTIONS.find((a) => a.value === e.action)?.label ?? e.action)}</td>
          <td><a href="#/incidente/${esc(e.incidentId)}"><code>${esc(e.incidentId.slice(0, 8))}</code></a></td>
          <td>${esc(e.actor)} <span class="small muted">(${esc(e.actorRole)})</span></td>
          <td>Nodo ${esc(e.node)}</td>
          <td>${e.fromStatus ? statusBadge(e.fromStatus, e.fromStatusLabel) : '—'} → ${e.toStatus ? statusBadge(e.toStatus, e.toStatusLabel) : '—'}</td>
          <td>${e.source === 'REPLICADO' ? `<span class="badge src-replica">Replicado</span><div class="small muted">recibido ${esc(fmt(e.recordedAt))}</div>` : '<span class="badge kind">Local</span>'}</td>
          <td><code>${esc(detailText(e))}</code></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Sin entradas con estos filtros.</div>');
    } catch (e) {
      setHtml(main.querySelector('#out'), `<div class="banner bad"><span class="icon">⛔</span><div>${esc(errorMessage(e))}</div></div>`);
    }
  }
  main.querySelector('#af').addEventListener('change', (ev) => { f[ev.target.name] = ev.target.value; load(); });
  load();
  const t = setInterval(load, 6000);
  return () => clearInterval(t);
}

function detailText(e) {
  const d = e.details ?? {};
  if (e.action === 'ASIGNAR') return `${d.assigneeBefore ?? '—'} → ${d.assigneeAfter}${d.note ? ` · nota: ${d.note}` : ''}`;
  if (e.action === 'SYNC_CONFLICTO') return `ganó ${d.winner}; local=${d.local?.status}@${d.local?.updatedNode} remoto=${d.remote?.status}@${d.remote?.updatedNode}`;
  if (e.action === 'CREAR') return `${d.category ?? ''} ${d.priority ?? ''} · ${d.location ?? ''}`;
  return d.note ? `nota: ${d.note}` : '';
}
