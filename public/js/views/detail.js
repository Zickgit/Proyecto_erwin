// Detalle (F-02, F-03, F-04, F-08): datos, origen, sincronización, acciones según el rol
// e historial de trazabilidad (cambios locales, replicados y conflictos resueltos).
import { api } from '../api.js';
import { esc, statusBadge, priorityBadge, originBadge, syncBadge, fmt, toast, errorMessage, optionList } from '../ui.js';

const ACTION_LABEL = { CREAR: 'Registro', ASIGNAR: 'Asignación de responsable', TRANSICION: 'Cambio de estado', SYNC_CONFLICTO: 'Conflicto de sincronización resuelto' };

export function render(main, ctx, id) {
  let current = null;
  let busy = false;
  let signature = '';

  async function load() {
    try {
      current = await api(`/api/incidents/${id}`);
      // Redibujar solo si algo cambió (evita perder foco/scroll en cada refresco).
      const sig = [current.version, current.updatedAt, current.sync.state, current.sync.lastSyncedAt, current.history.length, ctx.state.me?.role].join('|');
      if (sig === signature) return;
      signature = sig;
      draw();
    } catch (e) {
      signature = '';
      if (e.status === 404) {
        const links = ctx.state.peers.map((p) => `<a class="btn secondary" href="${esc(p.url)}/#/incidente/${esc(id)}">Abrir en Nodo ${esc(p.id)}</a>`).join(' ');
        main.innerHTML = `<section class="panel"><h1>Incidente no disponible en este nodo</h1>
          <p>El Nodo ${esc(ctx.state.node?.id)} todavía no tiene una réplica de <code>${esc(id)}</code>.
          Puede ocurrir si el nodo de origen no ha sincronizado (por ejemplo, estuvo desconectado).</p>
          <div class="row">${links}<a class="btn ghost" href="#/incidentes">Volver</a></div></section>`;
      } else {
        main.innerHTML = `<section class="panel"><div class="banner bad" role="alert"><span class="icon">⛔</span><div>
          <strong>No se pudo cargar el incidente.</strong> ${esc(errorMessage(e))}</div></div>
          <p><a href="#/incidentes">Volver al tablero</a></p></section>`;
      }
    }
  }

  function draw() {
    const i = current;
    const { catalogs } = ctx.state;
    const canTransition = ctx.can('incident:transition');
    const canAssign = ctx.can('incident:assign');
    const terminal = catalogs.states.find((s) => s.code === i.status)?.terminal;
    const label = (code) => catalogs.states.find((s) => s.code === code)?.label ?? code;
    const transitions = i.allowedTransitions.filter((t) => t !== 'ASIGNADO' || i.assignee);
    const assignable = ['VALIDADO', 'ASIGNADO', 'EN_ATENCION'].includes(i.status);

    main.innerHTML = `
      <section class="panel">
        <p class="small"><a href="#/incidentes">← Tablero</a></p>
        <div class="detail-head">
          <h1 class="m0">Incidente <span class="id">${esc(i.shortId)}</span></h1>
          ${statusBadge(i.status, i.statusLabel)} ${priorityBadge(i.priority, i.priorityLabel)}
        </div>
        <p>${esc(i.description)}</p>
        <div class="row">${originBadge(i.originNode, i.isLocal)} ${syncBadge(i.sync)}
          ${i.isLocal ? '' : `<span class="badge src-replica">Réplica en Nodo ${esc(ctx.state.node?.id)}</span>`}</div>
        <dl class="kv">
          <dt>ID completo</dt><dd><code>${esc(i.id)}</code></dd>
          <dt>Categoría</dt><dd>${esc(i.categoryLabel)}</dd>
          <dt>Ubicación (ficticia)</dt><dd>${esc(i.location)}</dd>
          <dt>Reportado</dt><dd>${esc(fmt(i.reportedAt))}</dd>
          <dt>Responsable</dt><dd>${esc(i.assignee ?? 'Sin asignar')}</dd>
          <dt>Registrado por</dt><dd>${esc(i.createdBy)} en Nodo ${esc(i.originNode)} · ${esc(fmt(i.createdAt))}</dd>
          <dt>Última modificación</dt><dd>${esc(i.updatedBy)} en Nodo ${esc(i.updatedNode)} · ${esc(fmt(i.updatedAt))}</dd>
          <dt>Versión</dt><dd>${esc(i.version)}</dd>
          <dt>Sincronización</dt><dd>${i.sync.state === 'SINCRONIZADO' ? `Confirmada ${esc(fmt(i.sync.lastSyncedAt))}` : 'Cambios pendientes de enviar a otros nodos'}</dd>
        </dl>

        ${(canTransition || canAssign) && !terminal ? `
        <div class="actions">
          <h2 class="mt0">Acciones (${esc(ctx.state.me?.role)})</h2>
          ${!i.isLocal ? `<p class="small muted">Está modificando una réplica: el cambio se enviará al Nodo ${esc(i.originNode)}. Si allá también se modifica durante una desconexión, se aplicará «gana la última escritura».</p>` : ''}
          <label class="field"><span>Nota (opcional)</span><input id="note" maxlength="500" placeholder="Comentario para la bitácora"></label>
          ${canTransition ? `<div class="row mt10">${transitions.map((t) =>
            `<button class="btn ${t === 'CANCELADO' ? 'danger' : 'secondary'}" data-to="${esc(t)}">Pasar a «${esc(label(t))}»</button>`).join('')
            || '<span class="muted small">Sin transiciones disponibles.</span>'}</div>` : ''}
          ${canAssign && assignable ? `
            <form id="assign" class="row mt10">
              <label class="field grow"><span>${i.assignee ? 'Reasignar responsable' : 'Asignar responsable (pasa a «Asignado»)'}</span>
                <select name="assignee" required>${optionList(catalogs.responders.filter((r) => r !== i.assignee).map((r) => ({ value: r, label: r })), '', { empty: 'Seleccione…' })}</select></label>
              <button class="btn" type="submit">${i.assignee ? 'Reasignar' : 'Asignar'}</button>
            </form>` : ''}
          ${canTransition && i.status === 'VALIDADO' ? '<p class="small muted">Para pasar a «Asignado» elija un responsable.</p>' : ''}
        </div>` : ''}
        ${terminal ? '<p class="muted">Estado terminal: ya no admite cambios.</p>' : ''}

        <h2>Historial de trazabilidad (${esc(i.history.length)})</h2>
        <ol class="timeline">${i.history.map(renderEntry).join('')}</ol>
      </section>`;

    main.querySelectorAll('button[data-to]').forEach((b) => b.addEventListener('click', () => transition(b.dataset.to)));
    main.querySelector('#assign')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const assignee = new FormData(ev.target).get('assignee');
      if (assignee) assign(assignee);
    });
  }

  async function act(path, body, okMsg) {
    if (busy) return;
    busy = true;
    main.querySelectorAll('.actions button').forEach((b) => { b.disabled = true; });
    try {
      await api(path, { method: 'POST', body: { ...body, expectedVersion: current.version } });
      toast(okMsg, 'ok');
      ctx.refreshConnectivity();
    } catch (e) {
      if (e.code === 'VERSION_CONFLICT') toast('Otro usuario o nodo modificó el incidente. Se recargó la versión actual.', 'bad');
      else toast(errorMessage(e), 'bad');
    } finally {
      busy = false;
      signature = ''; // forzar redibujo (re-habilita botones aunque la acción haya fallado)
      await load();
    }
  }

  function note() {
    const v = main.querySelector('#note')?.value.trim();
    return v ? { note: v } : {};
  }
  const transition = (to) => act(`/api/incidents/${id}/transition`, { to, ...note() }, 'Estado actualizado');
  const assign = (assignee) => act(`/api/incidents/${id}/assign`, { assignee, ...note() }, 'Responsable asignado');

  load();
  // Refresco para ver llegar réplicas/cambios remotos (sin interrumpir si el usuario escribe una nota).
  const timer = setInterval(() => {
    if (!busy && !main.querySelector('#note')?.value) load();
  }, 5000);
  return () => clearInterval(timer);
}

function renderEntry(e) {
  const d = e.details ?? {};
  const cls = e.action === 'SYNC_CONFLICTO' ? 'conflict' : e.source === 'REPLICADO' ? 'replicado' : '';
  let body = '';
  if (e.action === 'CREAR') body = `Estado inicial ${statusBadge(e.toStatus, e.toStatusLabel)}`;
  if (e.action === 'TRANSICION') body = `${statusBadge(e.fromStatus, e.fromStatusLabel)} → ${statusBadge(e.toStatus, e.toStatusLabel)}`;
  if (e.action === 'ASIGNAR') {
    body = `${esc(d.assigneeBefore ?? 'sin responsable')} → <strong>${esc(d.assigneeAfter)}</strong>`
      + (e.fromStatus !== e.toStatus ? ` · ${statusBadge(e.fromStatus, e.fromStatusLabel)} → ${statusBadge(e.toStatus, e.toStatusLabel)}` : '');
  }
  if (e.action === 'SYNC_CONFLICTO') {
    const side = (s) => `${esc(s.status)}${s.assignee ? ` / ${esc(s.assignee)}` : ''} (por ${esc(s.updatedBy)} en Nodo ${esc(s.updatedNode)}, ${esc(fmt(s.updatedAt))})`;
    body = `<div class="conflict-box">
      Escrituras concurrentes durante una desconexión. Política: <strong>gana la última escritura</strong> (${esc(d.policy)}).<br>
      Valor local: ${side(d.local)}<br>Valor remoto (de Nodo ${esc(d.fromNode)}): ${side(d.remote)}<br>
      <strong>Ganó el valor ${d.winner === 'REMOTO' ? 'remoto' : 'local'}.</strong> Ambas escrituras se conservan en este historial.</div>`;
  }
  return `<li class="${cls}">
    <div class="what">${esc(ACTION_LABEL[e.action] ?? e.action)}</div>
    <div>${body}</div>
    ${d.note ? `<div class="small">Nota: «${esc(d.note)}»</div>` : ''}
    <div class="when">${esc(fmt(e.at))} · ${esc(e.actor)} (${esc(e.actorRole)}) · Nodo ${esc(e.node)}
      · <span class="badge ${e.source === 'REPLICADO' ? 'src-replica' : 'kind'}">${e.source === 'REPLICADO' ? `Replicado · recibido ${esc(fmt(e.recordedAt))}` : 'Local'}</span></div>
  </li>`;
}
