// Utilidades de presentación. TODO texto dinámico pasa por esc() antes de ir al DOM.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_ICON = { NUEVO: '✦', VALIDADO: '✔', ASIGNADO: '👤', EN_ATENCION: '⚙', RESUELTO: '☑', CERRADO: '■', CANCELADO: '✕' };
const PRIORITY_ICON = { BAJA: '▽', MEDIA: '◆', ALTA: '▲', CRITICA: '‼' };

export const statusBadge = (code, label) =>
  `<span class="badge st-${esc(code)}"><span aria-hidden="true">${STATUS_ICON[code] ?? ''}</span>${esc(label ?? code)}</span>`;

export const priorityBadge = (code, label) =>
  `<span class="badge pr-${esc(code)}"><span aria-hidden="true">${PRIORITY_ICON[code] ?? ''}</span>Prioridad ${esc(label ?? code)}</span>`;

export const originBadge = (node, isLocal) =>
  `<span class="badge origin ${isLocal ? '' : 'remote'}" title="Nodo donde se registró">Origen: Nodo ${esc(node)}${isLocal ? ' (local)' : ''}</span>`;

export function syncBadge(sync) {
  if (sync?.state === 'SINCRONIZADO') {
    return `<span class="badge sync-ok" title="Última sincronización ${esc(fmt(sync.lastSyncedAt))}"><span aria-hidden="true">✓</span>Sincronizado${sync.lastSyncedAt ? ` · ${esc(fmtTime(sync.lastSyncedAt))}` : ''}</span>`;
  }
  return '<span class="badge sync-pend" title="Cambios aún no confirmados por todos los nodos"><span aria-hidden="true">⏳</span>Pendiente de sincronizar</span>';
}

export function sourceBadge(source) {
  if (!source) return '';
  if (source.servedFrom === 'REPLICA_LOCAL') {
    return `<span class="badge src-replica" title="El nodo ${esc(source.node)} no respondió; se muestra la copia local"><span aria-hidden="true">⚠</span>Réplica local (Nodo ${esc(source.node)} sin respuesta)</span>`;
  }
  return `<span class="badge src-live" title="Respondido en vivo por el nodo ${esc(source.respondedBy)}"><span aria-hidden="true">⇄</span>En vivo desde Nodo ${esc(source.respondedBy)}</span>`;
}

export function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'medium' });
}
export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

/** Reemplaza el contenido solo si cambió: los refrescos periódicos no roban foco ni clics. */
export function setHtml(el, html) {
  if (!el || el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
}

export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  box.append(t);
  setTimeout(() => t.remove(), 4500);
}

export function errorMessage(e) {
  if (e?.details?.length) return `${e.message}: ${e.details.map((d) => `${d.field} — ${d.message}`).join('; ')}`;
  return e?.message || String(e);
}

export function optionList(items, selected, { empty } = {}) {
  const opts = items.map(({ value, label }) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`);
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') + opts.join('');
}
