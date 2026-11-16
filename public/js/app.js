// Arranque del cliente web: estado global, enrutador por hash, selector de usuario
// y monitor de conectividad que genera los avisos visuales (nodo propio y peers).
import { api, session } from './api.js';
import { esc, fmtTime, ago, toast, setHtml } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as detail from './views/detail.js';
import * as create from './views/create.js';
import * as syncView from './views/sync.js';
import * as audit from './views/audit.js';

const state = {
  catalogs: null,
  users: [],
  me: null,
  node: null,          // { id, name, port }
  health: null,
  peers: [],           // último /api/network/peers conocido
  reachable: true,     // ¿responde el nodo que sirvió la página?
  lastOkAt: null,
};

const routes = [
  { re: /^#\/incidentes$/, view: dashboard, tab: 'incidentes' },
  { re: /^#\/incidente\/([0-9a-f-]{36})$/i, view: detail, tab: 'incidentes' },
  { re: /^#\/nuevo$/, view: create, tab: 'nuevo' },
  { re: /^#\/sync$/, view: syncView, tab: 'sync' },
  { re: /^#\/bitacora$/, view: audit, tab: 'bitacora' },
];

let cleanup = null;
const main = document.getElementById('main');

export const ctx = {
  state,
  can: (perm) => Boolean(state.me?.permissions?.includes(perm)),
  navigate: (hash) => { if (location.hash === hash) render(); else location.hash = hash; },
  refreshConnectivity: () => pollConnectivity(),
};

function render() {
  if (cleanup) { try { cleanup(); } catch { /* vista ya desmontada */ } cleanup = null; }
  const hash = location.hash || '#/incidentes';
  const route = routes.find((r) => r.re.test(hash));
  if (!route) { location.hash = '#/incidentes'; return; }
  const params = hash.match(route.re).slice(1);
  document.querySelectorAll('.tabs a').forEach((a) => {
    const active = a.dataset.route === route.tab;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // Contenedor nuevo por vista: los listeners de la vista anterior se descartan con él.
  const container = document.createElement('div');
  container.innerHTML = '<div class="panel loading">Cargando…</div>';
  main.replaceChildren(container);
  cleanup = route.view.render(container, ctx, ...params) || null;
  main.focus({ preventScroll: true });
}

function applyPermissions() {
  document.querySelectorAll('.tabs a[data-perm]').forEach((a) => { a.hidden = !ctx.can(a.dataset.perm); });
}

async function loadMe() {
  try {
    state.me = await api('/api/me');
  } catch (e) {
    state.me = null;
    toast(`No se pudo validar el usuario: ${e.message}`, 'bad');
  }
  applyPermissions();
}

function renderUserSelect() {
  const sel = document.getElementById('user-select');
  sel.innerHTML = state.users.map((u) =>
    `<option value="${esc(u.username)}"${u.username === session.user ? ' selected' : ''}>${esc(u.displayName)} · ${esc(u.role)}</option>`).join('');
  sel.onchange = async () => {
    session.user = sel.value;
    await loadMe();
    toast(`Ahora actúa como ${state.me?.displayName ?? sel.value}`);
    render();
  };
}

// ------------------------------------------------------------ conectividad
function renderPeerBadges() {
  const box = document.getElementById('peer-badges');
  const self = state.node
    ? `<span class="peer self ${state.reachable ? 'online' : 'offline'}" title="Nodo que sirve esta página">
         <span class="dot" aria-hidden="true"></span>Nodo ${esc(state.node.id)} (este) · ${state.reachable ? 'en línea' : 'SIN RESPUESTA'}</span>`
    : '';
  const peers = state.peers.map((p) => {
    const online = p.status === 'online';
    const label = online ? `en línea${p.lastLatencyMs != null ? ` · ${Math.round(p.lastLatencyMs)} ms` : ''}` : p.status === 'unknown' ? 'comprobando…' : 'NO DISPONIBLE';
    return `<a class="peer ${esc(p.status)}" href="${esc(p.url)}/" title="Abrir la interfaz del Nodo ${esc(p.id)}">
      <span class="dot" aria-hidden="true"></span>Nodo ${esc(p.id)} · ${esc(label)}${p.link && !p.link.up ? ' (corte simulado)' : ''}</a>`;
  }).join('');
  setHtml(box, self + peers);
}

function renderBanners() {
  const out = [];
  if (!state.reachable) {
    out.push(`<div class="banner bad" role="alert"><span class="icon" aria-hidden="true">⛔</span><div>
      <strong>El Nodo ${esc(state.node?.id ?? '')} (esta página) no responde.</strong>
      Los datos en pantalla pueden estar desactualizados${state.lastOkAt ? ` (última respuesta ${esc(ago(state.lastOkAt))})` : ''}.
      ${state.peers.length ? `Puede continuar en otro nodo: ${state.peers.map((p) => `<a href="${esc(p.url)}/">Nodo ${esc(p.id)}</a>`).join(', ')}.` : ''}
    </div></div>`);
  }
  for (const p of state.peers.filter((x) => x.status === 'offline')) {
    const simulated = p.link && !p.link.up;
    out.push(`<div class="banner warn" role="status"><span class="icon" aria-hidden="true">⚠</span><div>
      <strong>Nodo ${esc(p.id)} no disponible${simulated ? ' — corte de enlace SIMULADO' : ''}.</strong>
      Motivo: ${esc(p.lastError ?? 'sin respuesta')}${p.lastOkAt ? ` · último contacto ${esc(fmtTime(p.lastOkAt))}` : ''}.
      Los cambios hechos aquí se guardan en la cola local y se enviarán al reconectar; las consultas agregadas serán <strong>parciales</strong>.
    </div></div>`);
  }
  const pending = state.health?.database?.counts?.outboxPending ?? 0;
  if (state.reachable && pending > 0) {
    out.push(`<div class="banner info" role="status"><span class="icon" aria-hidden="true">⏳</span><div>
      <strong>${pending} evento(s) pendiente(s) de enviar</strong> desde el Nodo ${esc(state.node?.id ?? '')} a otros nodos.
      ${ctx.can('sync:status') ? '<a href="#/sync">Ver sincronización</a>' : ''}
    </div></div>`);
  }
  setHtml(document.getElementById('banners'), out.join(''));
}

async function pollConnectivity() {
  try {
    const [health, net] = await Promise.all([
      api('/api/health', { timeout: 3000 }),
      api('/api/network/peers', { timeout: 3000 }),
    ]);
    const wasDown = !state.reachable;
    state.health = health;
    state.node = health.node;
    state.peers = net.peers;
    state.reachable = true;
    state.lastOkAt = new Date().toISOString();
    if (wasDown) toast(`El Nodo ${health.node.id} volvió a responder`, 'ok');
    document.getElementById('node-identity').textContent =
      `Conectado a Nodo ${health.node.id} · ${health.node.name} (puerto ${health.node.port})`;
    document.title = `Nodo ${health.node.id} · Incidentes`;
  } catch {
    state.reachable = false;
    state.peers = state.peers.map((p) => ({ ...p, status: 'unknown' }));
  }
  renderPeerBadges();
  renderBanners();
}

// ------------------------------------------------------------ arranque
async function boot() {
  try {
    const [catalogs, users] = await Promise.all([api('/api/catalogs'), api('/api/users')]);
    state.catalogs = catalogs;
    state.users = users.users;
  } catch (e) {
    main.innerHTML = `<div class="panel"><h1>No se pudo conectar con el nodo</h1><p>${esc(e.message)}</p></div>`;
    await pollConnectivity();
    setInterval(pollConnectivity, 4000);
    return;
  }
  if (!state.users.some((u) => u.username === session.user)) session.user = 'coord';
  renderUserSelect();
  await Promise.all([loadMe(), pollConnectivity()]);
  setInterval(pollConnectivity, 4000);
  window.addEventListener('hashchange', render);
  render();
}

boot();
