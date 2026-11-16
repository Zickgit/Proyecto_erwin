# API REST de un nodo

Base: `http://127.0.0.1:3001/api` (Nodo A) o `http://127.0.0.1:3002/api` (Nodo B). Los dos nodos exponen la misma API sobre sus propios datos.

## Autenticación simulada y roles

Envía la cabecera `X-User: <usuario de prueba>`. No hay contraseña. Es un **límite declarado del prototipo**; un despliegue real usaría OIDC/JWT sobre TLS.

| Usuario | Rol | Puede |
|---|---|---|
| `op.norte`, `op.sur` | OPERADOR | registrar y consultar |
| `coord` | COORDINADOR | todo lo anterior, más asignar, cambiar estado, ver bitácora y sincronización |
| `auditor` | AUDITOR | consultar incidentes, bitácora y sincronización (solo lectura) |

Respuestas de seguridad: `401 UNAUTHENTICATED` si falta el usuario o no existe, y `403 FORBIDDEN` si el rol no tiene el permiso (la respuesta incluye `required`).

## Formato de error

```json
{ "error": "VALIDATION_ERROR", "message": "La solicitud contiene datos inválidos",
  "details": [ { "field": "priority", "message": "Valor inválido. Permitidos: BAJA, MEDIA, ALTA, CRITICA" } ] }
```

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_ID` | Datos, filtros o JSON inválidos; campos desconocidos |
| 401 | `UNAUTHENTICATED` | Falta `X-User` o el usuario es desconocido |
| 403 | `FORBIDDEN`, `ADMIN_LOCAL_ONLY` | Falta el permiso; ruta admin llamada desde fuera de loopback |
| 404 | `INCIDENT_NOT_FOUND`, `NOT_FOUND` | No existe en **este** nodo |
| 409 | `INVALID_TRANSITION`, `VERSION_CONFLICT`, `ASSIGN_NOT_ALLOWED`, `NO_CHANGE`, `ID_CONFLICT` | Regla de negocio o concurrencia |
| 422 | `ASSIGNEE_REQUIRED` | Se intentó pasar a Asignado sin responsable |

## Endpoints

### Catálogos y usuarios (públicos)

- `GET /api/catalogs`: categorías, prioridades, estados (con `next`), responsables ficticios.
- `GET /api/users`: usuarios de prueba y la matriz rol→permiso **leída de la BD**.
- `GET /api/me`: usuario autenticado y sus permisos (requiere `X-User`).

### F-01 · Registrar incidente

`POST /api/incidents` (permiso `incident:create`)

```json
{
  "category": "RIESGO_AMBIENTAL",
  "priority": "ALTA",
  "description": "Árbol caído bloquea acceso peatonal sur",
  "location": "Andador Sur, puerta 3 (ficticio)",
  "reportedAt": "2026-11-13T10:30:00Z",
  "id": "5c0e8a7e-1f3b-4c1e-9a55-1d2b3c4d5e6f"
}
```

- `reportedAt` es opcional; si falta, se usa la hora actual. No se admiten fechas futuras.
- `id` es opcional. Si lo envía el cliente, funciona como **clave de idempotencia**:
  - si se repite la misma alta, la respuesta es `200` con `"idempotentReplay": true`;
  - si el mismo `id` llega de otro usuario, la respuesta es `409 ID_CONFLICT`.
- `status`, `origin_node` y cualquier otro campo se rechazan, porque el servidor los asigna.
- La respuesta es `201` con la cabecera `Location` y este cuerpo:

```json
{
  "id": "efaa1e26-…", "shortId": "efaa1e26",
  "category": "RIESGO_AMBIENTAL", "categoryLabel": "Riesgo ambiental",
  "priority": "ALTA", "priorityLabel": "Alta",
  "status": "NUEVO", "statusLabel": "Nuevo", "allowedTransitions": ["VALIDADO", "CANCELADO"],
  "assignee": null, "originNode": "B", "isLocal": true,
  "createdBy": "op.sur", "createdAt": "…", "updatedAt": "…", "updatedBy": "op.sur", "updatedNode": "B",
  "version": 1, "sync": { "state": "PENDIENTE", "lastSyncedAt": null },
  "idempotentReplay": false
}
```

### F-02 · Consultar y filtrar

`GET /api/incidents?status=&priority=&category=&node=&from=&to=&q=&limit=50&offset=0` (permiso `incident:read`)

- `node` filtra por nodo de **origen**.
- `from` y `to` aceptan `YYYY-MM-DD` o ISO-8601 y se aplican sobre `reportedAt`. Si `to` es solo una fecha, incluye el día completo.
- `q` busca texto en la descripción y la ubicación.
- La respuesta tiene la forma `{ total, limit, offset, items: [incidente…] }`.

> Esta consulta devuelve lo que **este nodo** almacena: sus incidentes y las réplicas recibidas. Para preguntar a todos los nodos en vivo, usa la consulta agregada (F-05) de abajo.

### F-05 · Consulta agregada multinodo

`GET /api/aggregate/incidents?<mismos filtros>&replicas=true|false` (permiso `incident:read`)

- Pide en vivo a cada nodo su partición y la combina con la propia.
- Si un nodo no responde, la respuesta trae `complete:false`, `warning`, `unavailableNodes` y `total:null`, y los datos de ese nodo se sirven desde la réplica local marcados `REPLICA_LOCAL`.
- Formato completo en [SINCRONIZACION.md](SINCRONIZACION.md#4-consulta-agregada-f-05).

### F-06 / F-07 · Sincronización

| Ruta | Permiso | Descripción |
|---|---|---|
| `GET /api/sync/status` | `sync:status` | Pendientes, entregados, más antiguo pendiente, último error e intentos por peer; eventos recibidos por resultado |
| `POST /api/sync/run` | `sync:run` | Fuerza el envío de la outbox ahora |
| `GET /api/sync/log?kind=&limit=` | `sync:status` | Bitácora persistente: PEER_UP/DOWN, PUSH_OK/FAIL, RECEIVED, CONFLICT, cortes simulados |
| `POST /api/sync/reconcile` | `sync:run` | Reconciliación (pull de anti-entropía) desde todos los peers. Se usa tras restaurar un respaldo y responde, por peer, `incidentsInserted`, `incidentsUpdated`, `incidentsKept`, `auditInserted` y `auditAlready` |
| `GET /api/sync/export` | Solo un peer declarado | Estado completo del nodo (incidentes y bitácora) para la reconciliación |
| `POST /api/sync/receive` | Solo un peer declarado (`X-Node-Id`, más `X-Sync-Secret` si está configurado) | Recibe un lote `{ sourceNode, events[] }` y responde `results[]` con APLICADO, DUPLICADO, CONFLICTO_GANA_LOCAL, CONFLICTO_GANA_REMOTO o RECHAZADO |

`GET /api/incidents/:id` devuelve el detalle más `history`, la secuencia completa de la bitácora (F-08).

### F-03 · Cambiar estado

`POST /api/incidents/:id/transition` (permiso `incident:transition`)

```json
{ "to": "EN_ATENCION", "note": "Cuadrilla en sitio", "expectedVersion": 3 }
```

- Solo se aceptan las transiciones de la máquina de estados ([REGLAS.md](REGLAS.md#4-ciclo-de-vida-máquina-de-estados)). Cualquier otra devuelve `409 INVALID_TRANSITION` con la lista `allowed`, y el estado no cambia.
- Pasar de `ASIGNADO` a `VALIDADO` libera al responsable.
- Para llegar a `ASIGNADO` hay que usar `/assign`; si se intenta con `/transition`, la respuesta es `422`.
- `expectedVersion` es opcional y sirve para el control optimista: si la versión no coincide, la respuesta es `409 VERSION_CONFLICT`.

### F-04 · Asignar responsable

`POST /api/incidents/:id/assign` (permiso `incident:assign`)

```json
{ "assignee": "Brigada Ambiental", "note": "turno matutino", "expectedVersion": 2 }
```

- Desde `VALIDADO`, el incidente pasa a `ASIGNADO`.
- Desde `ASIGNADO` o `EN_ATENCION` se reasigna sin cambiar el estado.
- `assignee` debe ser uno de los responsables ficticios de `/api/catalogs`.
- La bitácora registra el usuario, la fecha, el estado anterior y nuevo, y el responsable anterior y nuevo.

### F-08 · Bitácora

`GET /api/audit?incident=&node=&actor=&action=&source=&from=&to=&limit=100&offset=0` (permiso `audit:read`)

Cada entrada tiene esta forma:

```json
{ "id": "…", "incidentId": "…", "action": "ASIGNAR", "actor": "coord", "actorRole": "COORDINADOR",
  "node": "B", "at": "…", "fromStatus": "VALIDADO", "toStatus": "ASIGNADO",
  "details": { "assigneeBefore": null, "assigneeAfter": "Brigada Ambiental", "note": null, "version": 3 },
  "source": "LOCAL", "recordedAt": "…" }
```

### Infraestructura (Bloque 1)

| Ruta | Descripción |
|---|---|
| `GET /api/health` | Identidad, versión del esquema y conteos: incidentes, bitácora, `outboxPending` |
| `GET /api/network/peers` · `/probe?count=N` · `/events` | Estado, latencia y bitácora de red |
| `PUT /api/admin/links/:peer` · `POST /api/admin/isolate` | Simulación de enlaces (solo loopback) |

## Ejemplo con PowerShell

```powershell
$h = @{ 'Content-Type' = 'application/json'; 'X-User' = 'op.norte' }
$inc = Invoke-RestMethod -Method Post http://127.0.0.1:3001/api/incidents -Headers $h `
  -Body '{"category":"INFRAESTRUCTURA","priority":"MEDIA","description":"Luminaria apagada en estacionamiento","location":"Estacionamiento 2 (ficticio)"}'
$c = @{ 'Content-Type' = 'application/json'; 'X-User' = 'coord' }
Invoke-RestMethod -Method Post "http://127.0.0.1:3001/api/incidents/$($inc.id)/transition" -Headers $c -Body '{"to":"VALIDADO"}'
Invoke-RestMethod -Method Post "http://127.0.0.1:3001/api/incidents/$($inc.id)/assign" -Headers $c -Body '{"assignee":"Servicios Generales"}'
Invoke-RestMethod "http://127.0.0.1:3001/api/incidents/$($inc.id)" -Headers @{ 'X-User' = 'auditor' }
```
