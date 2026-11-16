// Punto de entrada de UN nodo. El mismo código levanta el Nodo A y el Nodo B;
// solo cambia el archivo de entorno (config/nodeA.env | config/nodeB.env).
import path from 'node:path';
import express from 'express';
import { config, relPath } from './config.js';
import { openDatabase } from './db/connection.js';
import { createNetwork } from './network/netsim.js';
import { healthRoutes } from './routes/health.routes.js';
import { networkRoutes } from './routes/network.routes.js';
import { incidentsRoutes } from './routes/incidents.routes.js';
import { catalogRoutes } from './routes/catalog.routes.js';
import { auditRoutes } from './routes/audit.routes.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { createAuth } from './middleware/auth.js';
import { migrate } from './db/migrate.js';
import { createIncidentsRepo } from './repositories/incidents.repo.js';
import { createAuditRepo } from './repositories/audit.repo.js';
import { createOutboxRepo } from './repositories/outbox.repo.js';
import { createIncidentsService } from './services/incidents.service.js';
import { createSyncService } from './services/sync.service.js';
import { createAggregateService } from './services/aggregate.service.js';
import { syncRoutes } from './routes/sync.routes.js';

let db;
try {
  db = openDatabase(config);
  migrate(db, config);
} catch (e) {
  console.error(`[nodo ${config.nodeId}] no se pudo preparar la base de datos: ${e.message}`);
  process.exit(1);
}
const net = createNetwork(config);
const auth = createAuth(db);
const incidents = createIncidentsRepo(db);
const audit = createAuditRepo(db);
const outbox = createOutboxRepo(db);
const service = createIncidentsService({ db, config, incidents, audit, outbox });
const sync = createSyncService({ db, config, net });
const aggregate = createAggregateService({ config, net, incidents });

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Sin scripts/estilos inline ni orígenes externos: mitiga XSS en el cliente web.
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Node-Id': config.nodeId,
  });
  next();
});
// Los lotes de sincronización entre nodos pueden ser grandes; el resto de la API no.
app.use('/api/sync/receive', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '100kb' }));

// Todo lo que entra por /api pasa primero por el guardián de la partición simulada.
app.use('/api', net.inboundGuard);
app.use('/api', healthRoutes({ config, db }));
app.use('/api', networkRoutes({ net }));
app.use('/api', catalogRoutes({ db, auth, config }));
app.use('/api', incidentsRoutes({ service, auth }));
app.use('/api', auditRoutes({ audit, auth, config }));
app.use('/api', syncRoutes({ config, sync, aggregate, auth }));
app.use('/api', notFound);

// Cliente web (cada nodo sirve la misma interfaz).
app.use(express.static(path.join(config.root, 'public')));

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`[nodo ${config.nodeId}] "${config.nodeName}" escuchando en http://${config.host}:${config.port}`);
  console.log(`[nodo ${config.nodeId}] base de datos: ${relPath(config.dbPath)}`);
  console.log(`[nodo ${config.nodeId}] peers: ${config.peers.map((p) => `${p.id}=${p.url}`).join(', ') || '(ninguno)'}`);
  net.logEvent('NODE_STARTED', null, { port: config.port, pid: process.pid });
  net.heartbeat();
  sync.start(); // envía lo que haya quedado pendiente en disco (p. ej. tras una caída)
});
server.on('error', (e) => {
  console.error(`[nodo ${config.nodeId}] no se pudo iniciar: ${e.code === 'EADDRINUSE' ? `el puerto ${config.port} ya está en uso` : e.message}`);
  process.exit(1);
});

const hb = setInterval(() => net.heartbeat(), config.heartbeatMs);
hb.unref();

function shutdown(signal) {
  console.log(`[nodo ${config.nodeId}] ${signal} recibido, cerrando...`);
  clearInterval(hb);
  sync.stop();
  server.close(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, db, net };
