// Conexión SQLite del nodo (módulo nativo node:sqlite, sin compilación).
// Cada nodo abre SU PROPIO archivo .db: así se simula la distribución física.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase({ dbPath, nodeId, nodeName }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // WAL: lecturas concurrentes y mejor recuperación ante caída del proceso.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  // Identidad del nodo dentro del propio archivo: evita que el nodo B
  // abra por error la base del nodo A (integridad de la partición).
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_identity (
      singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
      node_id    TEXT NOT NULL,
      node_name  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const row = db.prepare('SELECT node_id FROM node_identity WHERE singleton = 1').get();
  if (!row) {
    db.prepare('INSERT INTO node_identity (singleton, node_id, node_name, created_at) VALUES (1, ?, ?, ?)')
      .run(nodeId, nodeName, new Date().toISOString());
  } else if (row.node_id !== nodeId) {
    db.close();
    throw new Error(`El archivo ${dbPath} pertenece al nodo ${row.node_id}, no a ${nodeId}. Revise DB_PATH.`);
  }
  return db;
}

export function dbInfo(db) {
  const { v } = db.prepare('SELECT sqlite_version() AS v').get();
  const { journal_mode } = db.prepare('PRAGMA journal_mode').get();
  const ident = db.prepare('SELECT node_id, node_name, created_at FROM node_identity').get();
  return { sqliteVersion: v, journalMode: journal_mode, identity: { ...ident } };
}
