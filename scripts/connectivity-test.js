// Prueba de conectividad y latencia entre nodos (evidencia de Fase 2).
// Uso: node scripts/connectivity-test.js [conteo]   (los nodos deben estar levantados)
// Guarda la evidencia en docs/evidencias/conectividad-<fecha>.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const count = Number.parseInt(process.argv[2] ?? '10', 10);
const NODES = [
  { id: 'A', url: 'http://127.0.0.1:3001' },
  { id: 'B', url: 'http://127.0.0.1:3002' },
];

async function get(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: r.ok, status: r.status, ms: Math.round((performance.now() - t0) * 100) / 100, body: await r.json() };
  } catch (e) {
    return { ok: false, ms: Math.round((performance.now() - t0) * 100) / 100, error: e?.cause?.code || e.name };
  }
}

const report = { at: new Date().toISOString(), count, clientToNode: [], nodeToNode: [] };

console.log('== 1) Cliente -> nodo (GET /api/health) ==');
for (const n of NODES) {
  const r = await get(`${n.url}/api/health`);
  report.clientToNode.push({ node: n.id, url: n.url, ok: r.ok, ms: r.ms, error: r.error ?? null, db: r.body?.database?.file ?? null });
  console.log(`  Nodo ${n.id} ${n.url}: ${r.ok ? `OK ${r.ms} ms · db=${r.body.database.file} · pid=${r.body.pid}` : `FALLO (${r.error ?? r.status})`}`);
}

console.log(`\n== 2) Nodo -> nodo (GET /api/network/probe?count=${count}) ==`);
for (const n of NODES) {
  const r = await get(`${n.url}/api/network/probe?count=${count}`);
  if (!r.ok) {
    console.log(`  Nodo ${n.id}: no responde (${r.error ?? r.status}); no se puede medir desde este origen`);
    report.nodeToNode.push({ from: n.id, ok: false, error: r.error ?? r.status });
    continue;
  }
  for (const x of r.body.results) {
    const lat = x.latencyMs ? `min ${x.latencyMs.min} / prom ${x.latencyMs.avg} / máx ${x.latencyMs.max} ms` : 'sin respuestas';
    console.log(`  ${n.id} -> ${x.peer}: ${x.ok}/${x.sent} OK, pérdida ${x.lossPct}% · ${lat}${x.failureReasons.length ? ` · motivos: ${x.failureReasons.join(', ')}` : ''}`);
    report.nodeToNode.push({ from: n.id, to: x.peer, ...x });
  }
}

const dir = path.join(root, 'docs', 'evidencias');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `conectividad-${report.at.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nEvidencia guardada en ${path.relative(root, file)}`);
