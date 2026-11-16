# Fase 5 · Distribución, desconexión y sincronización

Implementación:
- [`src/services/sync.service.js`](../src/services/sync.service.js): emisor, receptor, deduplicación y LWW.
- [`src/services/aggregate.service.js`](../src/services/aggregate.service.js): consulta agregada.
- [`src/routes/sync.routes.js`](../src/routes/sync.routes.js): rutas de sincronización.

## 1. Modelo de distribución

- **Partición por origen.** Cada incidente pertenece al nodo donde se registró (`origin_node`). Ese nodo es la fuente autorizada para consultas en vivo.
- **Replicación asíncrona completa.** Cada cambio se replica a todos los peers, así que cada nodo termina con una copia de los datos del otro. Gracias a eso un nodo sigue operando y consultando aunque el otro caiga. La consistencia es **eventual**: durante una partición, los nodos pueden ver versiones distintas y convergen al reconectarse.
- **Malla sin reenvío.** Cada nodo envía *sus propios* eventos directamente a cada peer declarado en `PEERS`. No se reenvían eventos ajenos, de modo que no hay ciclos ni enrutamiento multi-salto (ver los límites al final).

```mermaid
sequenceDiagram
    participant U as Usuario
    participant A as Nodo A (API + nodeA.db)
    participant B as Nodo B (API + nodeB.db)
    U->>A: POST /api/incidents
    Note over A: Transacción: incidents + audit_log + outbox(PENDIENTE)
    A-->>U: 201 (sync.state = PENDIENTE)
    loop cada SYNC_INTERVAL_MS o al detectar PEER_UP
        A->>B: POST /api/sync/receive {events[]}
        Note over B: dedupe por UUID → aplicar / LWW → audit REPLICADO
        B-->>A: results[] (APLICADO | DUPLICADO | CONFLICTO_*)
        Note over A: outbox → ENTREGADO; incidente → SINCRONIZADO
    end
```

## 2. Cola persistente durante la desconexión (F-06)

- **Patrón *transactional outbox*.** El evento se escribe en la tabla `outbox` del `.db` del nodo **en la misma transacción** que el cambio. No existe un cambio sin su evento.
- **El evento sobrevive a la caída.** Si el peer no responde, el evento sigue `PENDIENTE` en disco, aunque el proceso se reinicie: al arrancar, el nodo envía lo pendiente.
- **Lo que se puede consultar en cada momento:**
  - En el incidente: `sync.state = PENDIENTE`.
  - En `GET /api/sync/status`: pendientes por peer, el más antiguo, los intentos y el último error.

**Funciones disponibles sin conexión** (resiliencia):

| Función | Estado |
|---|---|
| Registrar, asignar y cambiar el estado de incidentes en el nodo local | ✔ Disponible; se encola |
| Consultar los incidentes que tiene el nodo (locales y réplicas) | ✔ Disponible |
| Consulta agregada en vivo | ⚠ Parcial: `complete:false`, con el nodo caído identificado y su réplica local marcada `REPLICA_LOCAL` |
| Ver cambios recientes hechos en el nodo caído | ✖ No hasta reconectar |

## 3. Sincronización al reconectar (F-07)

La sincronización se dispara de tres maneras:
1. **Periódicamente**, cada `SYNC_INTERVAL_MS` (3 s).
2. **Inmediatamente al detectar `PEER_UP`.** El heartbeat cada 5 s detecta la reconexión y la bitácora la registra con `reason: "RECONEXION"`.
3. **Manualmente** con `POST /api/sync/run` (rol Coordinador).

El emisor envía lotes de hasta 50 eventos **en orden** (`seq`) y marca `ENTREGADO` solo lo que el receptor confirmó.

### Deduplicación por UUID

Cada evento tiene un UUID, que es el mismo de su entrada de bitácora. El receptor guarda cada UUID aplicado en `applied_events`. Si un evento llega de nuevo (por un reintento tras un timeout, un reenvío manual o un `sync/run` repetido), la respuesta es `DUPLICADO` y no hay efecto. La prueba T-08 reenvía el mismo evento dos veces y comprueba que los conteos no cambian.

### Detección de conflicto y política Last Write Wins

Cada evento lleva la **instantánea completa** del incidente y su **base**: el `updated_at` y el `updated_node` del estado sobre el que se hizo el cambio. Con eso el receptor decide así:

| Situación | Cómo se detecta | Resultado |
|---|---|---|
| El incidente no existe localmente | — | Se inserta la réplica → `APLICADO` |
| Cambio **secuencial** | La base del evento coincide con mi estado actual | Se aplica → `APLICADO` |
| Cambio **concurrente** (los dos nodos editaron durante la partición) | La base no coincide | **Last Write Wins**: gana el `updated_at` mayor; si empatan, el `updated_node` mayor → `CONFLICTO_GANA_REMOTO` o `CONFLICTO_GANA_LOCAL` |

Además:
- **Convergencia.** El ganador es el mismo en ambos nodos, porque el orden es total y determinista. La `version` se alinea a `max(local, remota)`. La prueba T-09 verifica que el estado, `updatedAt`, `updatedNode` y `version` quedan iguales en A y B.
- **Ninguna escritura se pierde de la historia.** La entrada de bitácora del cambio perdedor se conserva como `REPLICADO`, y cada nodo agrega una entrada `SYNC_CONFLICTO` (actor `sistema`) con los valores local y remoto, el ganador y la política aplicada. El conflicto también queda en `sync_log`.
- **Monotonía local.** `updated_at` nunca retrocede dentro de un incidente: si el reloj va atrás, se usa la marca anterior más 1 ms.

**Limitaciones declaradas de LWW:**
- La escritura perdedora se descarta del estado actual (no se fusiona), aunque queda en la bitácora para auditarla.
- La política depende de los relojes. Aquí los dos nodos comparten el reloj del mismo equipo. En un despliegue real se necesitaría NTP o relojes lógicos híbridos (HLC), o bien CRDT o resolución manual para los campos críticos.

### Reconciliación tras restaurar un respaldo (anti-entropía)

La sincronización normal es *push*: cada nodo envía solo sus eventos, y solo una vez confirmados. Si un nodo se restaura desde un respaldo antiguo, pierde lo ocurrido después del respaldo, y los peers ya marcaron esos eventos como entregados.

`POST /api/sync/reconcile` hace un **pull** del estado completo de cada peer (`GET /api/sync/export`) y lo fusiona:
- Incidente ausente: se inserta.
- Incidente presente: LWW.
- Bitácora: `INSERT OR IGNORE` por UUID.
- Los UUID recuperados se registran en `applied_events` (`RECONCILIADO`), para que un reenvío posterior se reconozca como duplicado.

Repetirla no tiene efecto. Lo verifica la prueba T-10, y el resultado queda en `sync_log` como `RECONCILE`.

## 4. Consulta agregada (F-05)

`GET /api/aggregate/incidents?status=&priority=&category=&node=&from=&to=&q=&limit=&replicas=true|false`

El nodo que recibe la consulta actúa como **coordinador**:
1. Consulta su propia partición localmente.
2. Pide **en vivo** a cada peer su partición (`GET /api/incidents?node=<peer>`, reenviando el usuario para que el peer también aplique su autorización).
3. Combina los resultados ordenados por `reportedAt`.

Cada elemento lleva `source: { node, servedFrom: EN_VIVO | REPLICA_LOCAL, respondedBy }`. La respuesta incluye `sources[]` con el estado de cada nodo, por ejemplo:

```json
{
  "coordinator": "A", "complete": false,
  "warning": "RESULTADO PARCIAL: no respondió el nodo B. Sus datos se muestran desde la réplica local y pueden estar desactualizados.",
  "unavailableNodes": ["B"],
  "sources": [
    { "node": "A", "role": "LOCAL",  "status": "OK", "servedFrom": "EN_VIVO", "total": 1, "returned": 1 },
    { "node": "B", "role": "REMOTO", "status": "NO_DISPONIBLE", "error": "CONNECTION_REFUSED",
      "servedFrom": "REPLICA_LOCAL", "replicaTotal": 1, "replicaLastSyncedAt": "…", "total": null, "returned": 1 }
  ],
  "total": null, "items": [ … ]
}
```

Cuando el resultado es parcial, `total` vale `null` a propósito, para no presentar un conteo incompleto como si fuera completo (T-06). Con `replicas=false` se omiten las réplicas y solo se devuelven los datos en vivo.

## 5. Bitácora de red y sincronización

`GET /api/sync/log?kind=&limit=` (Coordinador o Auditor) lee la tabla persistente `sync_log`:

| `kind` | Significado |
|---|---|
| `NODE_STARTED` | El nodo arrancó |
| `PEER_DOWN` / `PEER_UP` | El heartbeat detectó la caída o la recuperación de un peer (incluye el motivo) |
| `LINK_CHANGED_SIMULATED`, `NODE_ISOLATED_SIMULATED`, `NODE_REJOINED_SIMULATED` | Cambios en la simulación de red |
| `PUSH_OK` / `PUSH_FAIL` | Resultado del envío de la outbox. Se registra cuando se envió algo o cuando el resultado cambia, para no saturar la bitácora |
| `RECEIVED` | Lote recibido de un peer, con los conteos por resultado |
| `CONFLICT` | Conflicto resuelto con LWW |

**Evidencia observada (2026-11-13, nodos de demostración).** Se mató el proceso de B, se creó un incidente en A y se reinició B. Bitácora de A, de lo más antiguo a lo más reciente:

```
05:10:31.993Z  B  PEER_DOWN  {"reason":"CONNECTION_REFUSED"}
05:10:33.036Z  B  PUSH_FAIL  {"reason":"PERIODICO","error":"CONNECTION_REFUSED"}
05:10:41.998Z  B  PEER_UP    {"latencyMs":8.75}
05:10:42.027Z  B  PUSH_OK    {"reason":"RECONEXION","sent":1,"delivered":1,"results":{"APLICADO":1}}
```

Durante la caída, la consulta agregada en A respondió `complete=false` con `B: NO_DISPONIBLE (CONNECTION_REFUSED), servedFrom=REPLICA_LOCAL`. Después de la recuperación respondió `complete=true`, `total=2`.

## 6. Seguridad entre nodos

- `POST /api/sync/receive` solo acepta peticiones con `X-Node-Id` de un **peer declarado** en `PEERS`; si no, responde `403 UNKNOWN_PEER`. El `sourceNode` del cuerpo debe coincidir con esa cabecera.
- **Secreto compartido opcional, `SYNC_SECRET`.** Si se define, el emisor lo envía en `X-Sync-Secret` y el receptor lo compara en tiempo constante. **Nunca se escribe en archivos versionados**; se define en el entorno del proceso:
  ```powershell
  $env:SYNC_SECRET = '<valor-generado-localmente>'; npm run start:a
  ```
- Los eventos recibidos se validan (UUID, catálogos, fechas, coherencia evento/bitácora). Un evento inválido se registra como `RECHAZADO` y no se aplica.
- Cuando el enlace simulado está cortado, el `inboundGuard` también rechaza la sincronización entrante (partición simétrica).

## 7. Pruebas automáticas (`npm test`)

[`tests/bloque3.sync.test.js`](../tests/bloque3.sync.test.js) levanta **dos procesos reales**, en los puertos 3111 y 3112:

| Prueba | Escenario verificado |
|---|---|
| T-08 | A → B con historial y marca SINCRONIZADO; reenviar el mismo evento devuelve DUPLICADO; `sync/run` repetido no cambia los conteos; un peer no declarado recibe 403 |
| T-05 | La consulta agregada combina A y B, con origen y `respondedBy` por elemento |
| T-06 y T-07 (simulado) | Enlace cortado: el evento queda pendiente, `lastError=LINK_DOWN_SIMULATED`, la consulta es parcial con `total=null` y la réplica marcada. Al reconectar se entrega solo y el incidente queda SINCRONIZADO |
| T-06 y T-07 (real) | Se mata el proceso B: `CONNECTION_REFUSED` y pendientes en disco. Se reinicia B con la misma base: se sincroniza y la bitácora registra `PEER_UP` y `PUSH_OK` |
| T-09 | Partición simétrica. A pasa el incidente a VALIDADO y B, después, a CANCELADO. Ambos convergen a CANCELADO con la misma versión; los dos registran `SYNC_CONFLICTO` (A: gana REMOTO; B: gana LOCAL) y conservan las dos transiciones |

## 8. Limitaciones y mejoras para un despliegue real

- No hay reenvío multi-salto: en una malla parcial, un nodo no recibe los eventos de otro nodo al que no está conectado directamente. Se mejoraría con gossip o anti-entropía basada en vectores de versión.
- La outbox entregada no se depura. En producción habría que compactarla y conservar solo un periodo.
- LWW a nivel de registro completo. Se podría fusionar campo por campo, o usar CRDT.
- La autenticación entre nodos es por identidad declarada más un secreto opcional. Lo adecuado sería mTLS.
