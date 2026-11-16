// Cola persistente de salida (transactional outbox). Se escribe dentro de la
// misma transacción que el cambio de negocio. El envío lo hace el sincronizador (Bloque 3).
export function createOutboxRepo(db) {
  const ins = db.prepare(`INSERT INTO outbox (event_id, target_node, incident_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const counts = db.prepare(`SELECT target_node AS node, state, COUNT(*) AS n FROM outbox GROUP BY target_node, state`);

  return {
    enqueue({ eventId, incidentId, type, payload, createdAt }, targets) {
      const json = JSON.stringify(payload);
      for (const t of targets) ins.run(eventId, t, incidentId, type, json, createdAt);
    },
    counts() { return counts.all(); },
  };
}
