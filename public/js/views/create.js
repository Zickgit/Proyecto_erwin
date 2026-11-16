// Registro de incidente (F-01). El navegador genera el UUID antes de enviar:
// si la red falla y el usuario reintenta, se reutiliza el MISMO id y el servidor
// no crea un duplicado (idempotencia).
import { api } from '../api.js';
import { esc, optionList, toast } from '../ui.js';

let draft = null; // { id, values } conserva el borrador y su UUID entre reintentos

// crypto.randomUUID solo existe en contextos seguros (https o localhost); en una LAN por http
// se usa getRandomValues para construir un UUID v4 equivalente.
function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function render(main, ctx) {
  if (!ctx.can('incident:create')) {
    main.innerHTML = '<section class="panel">Su rol no puede registrar incidentes. Cambie a un usuario Operador o Coordinador.</section>';
    return null;
  }
  const { catalogs } = ctx.state;
  if (!draft) draft = { id: uuidv4(), values: { priority: 'MEDIA' } };
  const v = draft.values;
  const peersDown = ctx.state.peers.filter((p) => p.status === 'offline');

  main.innerHTML = `
    <section class="panel">
      <h1>Registrar incidente en el Nodo ${esc(ctx.state.node?.id)}</h1>
      <p class="small muted">Use datos y ubicaciones <strong>ficticios</strong>. El incidente quedará con origen «Nodo ${esc(ctx.state.node?.id)}» y se replicará a los demás nodos.</p>
      ${peersDown.length ? `<div class="banner warn" role="status"><span class="icon" aria-hidden="true">⚠</span><div>
        ${peersDown.map((p) => `Nodo ${esc(p.id)}`).join(', ')} no disponible: el registro se guardará aquí y quedará <strong>pendiente de sincronizar</strong>.</div></div>` : ''}
      <form id="create" class="form-grid" novalidate>
        <label class="field" data-f="category"><span>Categoría *</span>
          <select name="category" required>${optionList(catalogs.categories.map((c) => ({ value: c.code, label: c.label })), v.category, { empty: 'Seleccione…' })}</select>
          <span class="err" role="alert"></span></label>
        <label class="field" data-f="priority"><span>Prioridad *</span>
          <select name="priority" required>${optionList(catalogs.priorities.map((p) => ({ value: p.code, label: p.label })), v.priority)}</select>
          <span class="err" role="alert"></span></label>
        <label class="field full" data-f="description"><span>Descripción * (10 a 1000 caracteres)</span>
          <textarea name="description" required minlength="10" maxlength="1000">${esc(v.description)}</textarea>
          <span class="err" role="alert"></span></label>
        <label class="field" data-f="location"><span>Ubicación ficticia * (3 a 120)</span>
          <input name="location" required minlength="3" maxlength="120" placeholder="Ej. Edificio C, planta baja (ficticio)" value="${esc(v.location)}">
          <span class="err" role="alert"></span></label>
        <label class="field" data-f="reportedAt"><span>Fecha y hora del suceso (opcional; por defecto, ahora)</span>
          <input type="datetime-local" name="reportedAt" value="${esc(v.reportedAt)}">
          <span class="err" role="alert"></span></label>
        <div class="field full">
          <span class="small">Identificador (clave de idempotencia): <code>${esc(draft.id)}</code></span>
        </div>
        <div class="row full">
          <button class="btn" type="submit">Registrar</button>
          <button class="btn ghost" type="button" id="reset">Limpiar</button>
        </div>
      </form>
    </section>`;

  const form = main.querySelector('#create');
  form.addEventListener('input', (ev) => { if (ev.target.name) draft.values[ev.target.name] = ev.target.value; });
  main.querySelector('#reset').addEventListener('click', () => { draft = null; render(main, ctx); });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    form.querySelectorAll('.field').forEach((f) => { f.classList.remove('invalid'); const e = f.querySelector('.err'); if (e) e.textContent = ''; });
    const fd = new FormData(form);
    const body = {
      id: draft.id,
      category: fd.get('category') || undefined,
      priority: fd.get('priority') || undefined,
      description: fd.get('description')?.trim() || undefined,
      location: fd.get('location')?.trim() || undefined,
    };
    const when = fd.get('reportedAt');
    if (when) body.reportedAt = new Date(when).toISOString();

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Registrando…';
    try {
      const inc = await api('/api/incidents', { method: 'POST', body });
      toast(inc.idempotentReplay ? 'Ya estaba registrado (reintento sin duplicar)' : `Incidente ${inc.shortId} registrado`, 'ok');
      draft = null;
      ctx.refreshConnectivity();
      ctx.navigate(`#/incidente/${inc.id}`);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Registrar';
      if (e.code === 'VALIDATION_ERROR') {
        for (const d of e.details ?? []) {
          const f = form.querySelector(`[data-f="${CSS.escape(d.field)}"]`);
          if (f) { f.classList.add('invalid'); f.querySelector('.err').textContent = d.message; }
        }
        form.querySelector('.invalid select, .invalid input, .invalid textarea')?.focus();
        toast('Revise los campos marcados', 'bad');
      } else if (e.unreachable) {
        toast('El nodo no respondió. Puede reintentar: se usará el mismo identificador y no habrá duplicados.', 'bad');
      } else {
        toast(e.message, 'bad');
      }
    }
  });
  return null;
}
