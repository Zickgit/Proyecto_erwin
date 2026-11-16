import { Router } from 'express';
import { relPath } from '../config.js';
import { dbInfo } from '../db/connection.js';

export function healthRoutes({ config, db }) {
  const r = Router();
  const startedAt = new Date();

  // GET /api/health — liveness + identidad del nodo + estado de su base SQLite.
  r.get('/health', (req, res) => {
    let database;
    try {
      const counts = db.prepare(`SELECT
          (SELECT COUNT(*) FROM incidents) AS incidents,
          (SELECT COUNT(*) FROM incidents WHERE origin_node = ?) AS localIncidents,
          (SELECT COUNT(*) FROM audit_log) AS auditEntries,
          (SELECT COUNT(*) FROM outbox WHERE state = 'PENDIENTE') AS outboxPending`).get(config.nodeId);
      const { user_version } = db.prepare('PRAGMA user_version').get();
      database = { ok: true, file: relPath(config.dbPath), schemaVersion: user_version, ...dbInfo(db), counts: { ...counts } };
    } catch (e) {
      database = { ok: false, error: e.message };
    }
    res.status(database.ok ? 200 : 503).json({
      status: database.ok ? 'ok' : 'degraded',
      node: { id: config.nodeId, name: config.nodeName, port: config.port, version: config.version },
      database,
      time: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
    });
  });

  return r;
}
