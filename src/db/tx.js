// Transacción explícita sobre node:sqlite (que no trae un helper propio).
// BEGIN IMMEDIATE toma el bloqueo de escritura al inicio: evita interbloqueos
// entre la API y el proceso de sincronización que escriben sobre el mismo archivo.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya terminó */ }
    throw e;
  }
}
