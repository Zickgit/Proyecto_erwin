// Cliente HTTP del navegador. Habla SOLO con el nodo que sirvió la página (mismo origen);
// el acceso a los demás nodos lo hace el servidor (consulta agregada / sincronización).
const USER_KEY = 'lab2.user';

export const session = {
  get user() { return localStorage.getItem(USER_KEY) || 'coord'; },
  set user(v) { localStorage.setItem(USER_KEY, v); },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error || (status === 0 ? 'NODE_UNREACHABLE' : 'HTTP_ERROR');
    this.details = body?.details;
    this.body = body;
  }
  get unreachable() { return this.status === 0; }
}

export async function api(path, { method = 'GET', body, timeout = 8000 } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': session.user },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, { error: 'NODE_UNREACHABLE', message: 'El nodo no responde. Verifique que el proceso esté activo.' });
  }
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
