# Informe de pruebas técnicas T-01 a T-12

Prototipo académico (UNACH · Cómputo distribuido · Laboratorio 2). Datos ficticios.

**Entorno de ejecución de las pruebas registradas:** Windows 11, Node.js 24.14.0, SQLite 3.51.2 (`node:sqlite`), dos nodos en la misma máquina sobre loopback. Fecha: 2026-11-13 (UTC).

## 0. Cómo ejecutar las pruebas

| Tipo | Comando | Qué hace |
|---|---|---|
| Automáticas (34 casos) | `npm test` | Levanta **procesos reales** de nodos en los puertos 3101, 3111/3112 y 3121/3122, con bases temporales. No toca `data/` ni los nodos 3001/3002 |
| Automáticas con evidencia | `npm run test:evidence` | Igual que la anterior, y además guarda la salida en [`docs/evidencias/pruebas-automaticas.txt`](evidencias/pruebas-automaticas.txt) |
| Guion de demostración | `powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 [-Pausa]` | Recorre el guion de la sección 11 del laboratorio contra los nodos 3001/3002 y guarda la transcripción en `docs/evidencias/demo-<fecha>.txt` |
| Conectividad | `npm run net:test` | Mide la latencia cliente→nodo y nodo→nodo (Fase 2) |
| Manuales | Ver cada prueba | Se usan la interfaz web, PowerShell y los scripts de `scripts/` |

**Resultado de la última corrida automática:** `tests 34 · pass 34 · fail 0` en 7.8 s. Detalle por caso en [`pruebas-automaticas.txt`](evidencias/pruebas-automaticas.txt).

Encabezados que se usan en los ejemplos de PowerShell:

```powershell
$A = 'http://127.0.0.1:3001'; $B = 'http://127.0.0.1:3002'
function Hdr($u) { @{ 'Content-Type' = 'application/json'; 'X-User' = $u } }
```

---

## 1. Cómo simular la caída de red y evidenciar la recuperación

### 1.1 Caída REAL del nodo: matar el proceso que escucha en su puerto

Elige **una** de estas formas:

```powershell
# a) Script del proyecto (Windows): busca el PID que escucha en el puerto y lo termina
.\scripts\kill-node.ps1 -Port 3002

# b) Manual en Windows
Get-NetTCPConnection -LocalPort 3002 -State Listen | Select-Object OwningProcess
Stop-Process -Id <PID> -Force          # o: taskkill /PID <PID> /F

# c) Si el nodo se levantó con "npm run start:b" en su propia terminal: Ctrl+C en esa terminal
```

```bash
# d) Linux / macOS
./scripts/kill-node.sh 3002            # equivale a: kill -9 $(lsof -t -iTCP:3002 -sTCP:LISTEN)
```

**Reconexión:** vuelve a iniciar el nodo con `npm run start:b`. Usa la **misma** base `data/nodeB.db`, así que no pierde nada.

> Consejo: para la demostración, levanta cada nodo en **su propia terminal** (`npm run start:a` y `npm run start:b`) en lugar de `start:all`. Así puedes tirar y reiniciar B sin afectar a A.

### 1.2 Corte de enlace SIMULADO: los dos procesos siguen vivos

```powershell
Invoke-RestMethod -Method Put "$A/api/admin/links/B" -Headers (Hdr 'coord') -Body '{"up":false}'   # cortar
Invoke-RestMethod -Method Put "$A/api/admin/links/B" -Headers (Hdr 'coord') -Body '{"up":true}'    # restablecer
Invoke-RestMethod -Method Put "$A/api/admin/links/B" -Headers (Hdr 'coord') -Body '{"latencyMs":300,"jitterMs":50,"lossRate":0.2}'  # degradar
Invoke-RestMethod -Method Post "$A/api/admin/isolate" -Headers (Hdr 'coord') -Body '{"isolated":true}'   # aislar de todos
```

También se puede hacer desde la interfaz: **Red y sincronización → Simulación de red**. Estas rutas solo se aceptan desde la misma máquina (loopback). El corte es simétrico: A deja de llamar a B y además rechaza las peticiones de B.

### 1.3 Evidenciar la recuperación en la bitácora

1. **Bitácora persistente de red y sincronización** (tabla `sync_log`, sobrevive a reinicios):
   ```powershell
   (Invoke-RestMethod "$A/api/sync/log?limit=20" -Headers (Hdr 'auditor')).items |
     Select-Object at, peer, kind, @{n='detalle';e={$_.detail | ConvertTo-Json -Compress -Depth 4}} | Format-Table -Wrap
   ```
   La secuencia esperada es `PEER_DOWN (CONNECTION_REFUSED)` → `PUSH_FAIL` → `PEER_UP` → `PUSH_OK (reason: RECONEXION o PERIODICO, results: {APLICADO: n})`.
2. **En la interfaz:** pestaña **Red y sincronización**, tabla «Bitácora de red y sincronización». Se puede filtrar por «Peer caído», «Peer recuperado», etc.
3. **Directo en SQL** (con cualquier cliente SQLite):
   ```sql
   SELECT at, peer, kind, detail FROM sync_log ORDER BY id DESC LIMIT 20;      -- en data/nodeA.db
   SELECT event_id, origin_node, result, received_at FROM applied_events ORDER BY received_at DESC LIMIT 20;  -- en data/nodeB.db
   ```
4. **Bitácora de negocio:** en el detalle del incidente, o en `GET /api/audit?source=REPLICADO`, cada entrada replicada indica `recordedAt`, es decir, cuándo la recibió el nodo. Si se compara con `at`, la hora del cambio, se ve el retraso causado por la desconexión.

---

## 2. Fichas de prueba

### T-01 · Registro

| Campo | Contenido |
|---|---|
| Requisito | F-01 |
| Precondiciones | Nodo A activo; usuario `op.norte` (Operador) |
| Pasos | 1. `POST /api/incidents` con categoría, prioridad, descripción y ubicación ficticia (o con la UI: «+ Nuevo»). 2. Repetir el mismo POST con el mismo `id` (UUID enviado por el cliente) |
| Resultado esperado | `201` con un `id` UUID v4, `createdAt`, `originNode = A`, `status = NUEVO`, `version = 1`, `sync.state = PENDIENTE` y la cabecera `Location`. El reintento con el mismo `id` responde `200` con `idempotentReplay: true` y no duplica |
| Resultado observado | Así fue. Demo: `A: d9284733 origen=A estado=NUEVO sync=PENDIENTE`. Automática: 3/3 casos ✔ (incluido el `409 ID_CONFLICT` cuando otro usuario reutiliza el UUID) |
| Evidencia | `pruebas-automaticas.txt` (T-01); `demo-2026-11-12T23-29-44.txt`, paso 1; UI: `T11-detalle-movil.jpg` |
| Conclusión | **Aprobada** |

### T-02 · Validación

| Campo | Contenido |
|---|---|
| Requisito | F-01, Seguridad |
| Precondiciones | Nodo A activo |
| Pasos | Enviar: cuerpo vacío; `priority: "URGENTE"` y `category: "ALIENS"`; `status: "CERRADO"` (impuesto por el cliente); descripción de 5 caracteres; fecha futura; `id` no UUID; JSON roto; transición a `"ARCHIVADO"`; filtro `?status=FOO` |
| Resultado esperado | `400 VALIDATION_ERROR` con `details[]`, un elemento **por campo**. JSON roto → `400 INVALID_JSON`. Nada se guarda |
| Resultado observado | Así fue. Ejemplo: cuerpo vacío → campos `category, description, location, priority`. En la UI móvil, «corta» y una ubicación vacía se marcaron en rojo con el mensaje del servidor |
| Evidencia | `pruebas-automaticas.txt` (T-02, 7 casos ✔) |
| Conclusión | **Aprobada** |

### T-03 · Transición

| Campo | Contenido |
|---|---|
| Requisito | F-03 |
| Precondiciones | Incidente en `NUEVO`; usuario `coord` |
| Pasos | 1. Pedir `NUEVO → CERRADO`. 2. Consultar el incidente. 3. Pedir `NUEVO → VALIDADO`. 4. Recorrer `ASIGNADO → EN_ATENCION → RESUELTO → CERRADO`. 5. Intentar salir de `CERRADO`. 6. Enviar un `expectedVersion` desactualizado |
| Resultado esperado | 1 → `409 INVALID_TRANSITION` con `allowed: [VALIDADO, CANCELADO]`, **sin cambio** de estado ni de versión ni de bitácora. 3 → `200`, versión 2. 4 → todo `200`. 5 → `409`. 6 → `409 VERSION_CONFLICT` |
| Resultado observado | Así fue. Demo, paso 3: `Transición no permitida: Nuevo → Cerrado ... "allowed":["VALIDADO","CANCELADO"]` y luego la transición válida |
| Evidencia | `pruebas-automaticas.txt` (T-03, 4 casos ✔); demo, paso 3 |
| Conclusión | **Aprobada** |

### T-04 · Auditoría

| Campo | Contenido |
|---|---|
| Requisito | F-04, F-08, Trazabilidad |
| Precondiciones | Incidente con alta, validación, asignación y reasignación |
| Pasos | `GET /api/incidents/:id` (historial) y `GET /api/audit?incident=:id` con `auditor`. Intentar `UPDATE`/`DELETE` sobre `audit_log` directamente en SQLite |
| Resultado esperado | Cada entrada tiene `actor`, `actorRole`, `node`, `at`, `fromStatus`, `toStatus` y los detalles (nota, responsable anterior y nuevo). Las marcas de tiempo son estrictamente crecientes. La BD rechaza modificar o borrar la bitácora |
| Resultado observado | Así fue. Demo, paso 3: `CREAR op.norte OPERADOR A → NUEVO`, `TRANSICION coord COORDINADOR A NUEVO→VALIDADO`, `ASIGNAR coord ... VALIDADO→ASIGNADO`. Trigger: `audit_log es de solo inserción` |
| Evidencia | `pruebas-automaticas.txt` (T-04, 3 casos ✔); demo, paso 3; UI: historial en `T09-conflicto-historial-movil.jpg` |
| Conclusión | **Aprobada** |

### T-05 · Consulta distribuida

| Campo | Contenido |
|---|---|
| Requisito | F-05 |
| Precondiciones | A y B activos; un incidente creado en cada nodo |
| Pasos | `GET $A/api/aggregate/incidents` (o el Tablero en modo «Agregada») |
| Resultado esperado | `complete: true`; `sources` con A y B en `OK / EN_VIVO`; cada elemento lleva `originNode` y `source.respondedBy` |
| Resultado observado | Demo, paso 2: `complete=True total=2`; A `LOCAL OK EN_VIVO`, B `REMOTO OK EN_VIVO 3.18 ms`; `63fb10a6` con origen B respondido por B, `d9284733` con origen A respondido por A |
| Evidencia | demo, paso 2; `T05-T11-tablero-escritorio.jpg`; automática T-05 ✔ |
| Conclusión | **Aprobada** |

### T-06 · Nodo no disponible

| Campo | Contenido |
|---|---|
| Requisito | F-05, Transparencia |
| Precondiciones | A activo; B detenido (sección 1.1) o con el enlace cortado (1.2) |
| Pasos | `GET $A/api/aggregate/incidents`; abrir el Tablero en la UI de A |
| Resultado esperado | `complete: false`, `total: null` (no se presenta como completo), `warning` «RESULTADO PARCIAL…», `unavailableNodes: [B]`; fuente B `NO_DISPONIBLE` con el motivo; sus datos marcados `REPLICA_LOCAL`. En la UI: aviso amarillo y fuente B con ✖ |
| Resultado observado | Demo, paso 4: `complete=False total=` (nulo), `B NO_DISPONIBLE CONNECTION_REFUSED REPLICA_LOCAL`. Automáticas: corte simulado → `LINK_DOWN_SIMULATED`; caída real → `CONNECTION_REFUSED` |
| Evidencia | `T06-consulta-parcial-escritorio.jpg`; demo, paso 4; automáticas T-06/T-07 (2 escenarios ✔) |
| Conclusión | **Aprobada** |

### T-07 · Desconexión

| Campo | Contenido |
|---|---|
| Requisito | F-06, Resiliencia |
| Precondiciones | A y B activos |
| Pasos | 1. Tirar B (`.\scripts\kill-node.ps1 -Port 3002`). 2. Crear un incidente en A. 3. Esperar más de 3 s. 4. `GET $A/api/sync/status`. 5. Revisar la barra y los avisos de la UI |
| Resultado esperado | El alta funciona en A con `sync.state = PENDIENTE`. La cola A→B muestra pendientes ≥ 1 con `lastError` (motivo). La UI muestra «Nodo B · NO DISPONIBLE» y «N evento(s) pendiente(s)». `sync_log` registra `PEER_DOWN` y `PUSH_FAIL`. Los eventos sobreviven en el `.db` aunque A se reinicie |
| Resultado observado | Demo, paso 4: `cf7790be sync=PENDIENTE`; `Cola A->B: pendientes=3 error=CONNECTION_REFUSED peer=offline`. Bitácora: `PEER_DOWN {"reason":"CONNECTION_REFUSED"}`, `PUSH_FAIL {...}` |
| Evidencia | demo, pasos 4 y 5 (tabla de `sync_log`); automáticas T-06/T-07 ✔ |
| Conclusión | **Aprobada** |

### T-08 · Sincronización

| Campo | Contenido |
|---|---|
| Requisito | F-07, Integridad |
| Precondiciones | Escenario T-07 con eventos pendientes |
| Pasos | 1. Reiniciar B (`npm run start:b`). 2. Esperar el heartbeat (≤ 5 s). 3. Verificar en B el incidente creado durante la caída. 4. Ejecutar `POST /api/sync/run` dos veces más y comparar los conteos de B. 5. Reenviar a mano un evento ya entregado (`POST $B/api/sync/receive`) |
| Resultado esperado | B recibe todo sin intervención; la cola de A queda en 0; el incidente pasa a `SINCRONIZADO`; los conteos no cambian al repetir; el reenvío responde `DUPLICADO` |
| Resultado observado | Demo, paso 5: `B recibió el incidente pendiente: True`; `incidentes 6/6 · bitácora 11/11 (sin duplicados)`; bitácora de A: `PEER_UP` → `PUSH_OK {"sent":3,"delivered":3,"results":{"APLICADO":3}}`. Automática: reenvío → `['DUPLICADO','DUPLICADO']` |
| Evidencia | demo, paso 5; automática T-08 (4 casos ✔) |
| Conclusión | **Aprobada** |

### T-09 · Conflicto

| Campo | Contenido |
|---|---|
| Requisito | F-07, política de conflictos ([SINCRONIZACION.md](SINCRONIZACION.md#3-sincronización-al-reconectar-f-07)) |
| Precondiciones | Incidente replicado en A y B |
| Pasos | 1. Cortar el enlace en ambos sentidos (1.2). 2. En A: transición a VALIDADO. 3. Después, en B: transición a CANCELADO. 4. Restablecer los enlaces. 5. Comparar el incidente en A y B y revisar el historial |
| Resultado esperado | Ambos convergen a la **última escritura** (CANCELADO, desde B) con la misma `version` y el mismo `updatedAt`. Cada nodo registra `SYNC_CONFLICTO` con el valor local, el remoto y el ganador. Las dos transiciones se conservan en el historial |
| Resultado observado | Demo, paso 6: durante la partición `A ve: VALIDADO   B ve: CANCELADO`; tras reconectar `A=CANCELADO (v2, B)   B=CANCELADO (v2, B)`; `Nodo A: ganó REMOTO (local=VALIDADO, remoto=CANCELADO)`; `Nodo B: ganó LOCAL (local=CANCELADO, remoto=VALIDADO)` |
| Evidencia | `T09-conflicto-historial-movil.jpg` (recuadro «Conflicto de sincronización resuelto»); demo, paso 6; automática T-09 ✔ |
| Conclusión | **Aprobada**. Límite declarado: LWW descarta la escritura perdedora del estado actual, aunque la conserva en la bitácora |

### T-10 · Restauración

| Campo | Contenido |
|---|---|
| Requisito | Fase 3 «Probar transacciones y recuperación desde respaldo» |
| Precondiciones | A y B activos con datos |
| Pasos | 1. Respaldo en caliente: `npm run backup -- B` (genera `backups/nodeB-<fecha>.db` y un `.json` con sha256, integridad y conteos). 2. Hacer cambios nuevos en A y B. 3. Intentar `npm run restore -- B backups/nodeB-<fecha>.db` con B encendido. 4. Detener B (`.\scripts\kill-node.ps1 -Port 3002`) y repetir la restauración. 5. `npm run start:b`. 6. Verificar que B volvió al estado del respaldo. 7. Reconciliar: `Invoke-RestMethod -Method Post "$B/api/sync/reconcile" -Headers (Hdr 'coord')` (o el botón «Reconciliar desde peers» en la UI). 8. Comparar los conteos de A y B y repetir la reconciliación |
| Resultado esperado | 3 → el script se **niega** («sigue activo»). 4 → verifica `integrity_check`, la identidad del nodo y los triggers de bitácora, y guarda `pre-restore-*` (reversible). 6 → B no tiene lo posterior al respaldo. 7 → recupera desde A los incidentes y la bitácora (`incidentsInserted`, `incidentsUpdated`, `auditInserted`). 8 → conteos iguales y sin duplicados al repetir |
| Resultado observado | Automática T-10 ✔: negativa con el nodo activo, `integridad=ok`, triggers `trg_audit_no_delete, trg_audit_no_update` presentes; tras restaurar faltaban 2 incidentes; la reconciliación los recuperó junto con la transición posterior (nota «post-respaldo»); la segunda reconciliación devolvió `incidentsInserted=0, auditInserted=0`; conteos de B iguales a los de A; `sync_log` con 2 `RECONCILE` |
| Evidencia | `pruebas-automaticas.txt` (T-10); manifiesto `.json` de cada respaldo |
| Conclusión | **Aprobada** |

### T-11 · Responsividad

| Campo | Contenido |
|---|---|
| Requisito | F-09 |
| Precondiciones | A y B activos |
| Pasos | Abrir http://127.0.0.1:3001 con anchos de 375 px (móvil), 736 px y 1280 px (DevTools → dispositivo). Registrar (con un error de validación y después válido), consultar en modo agregado, abrir el detalle, cambiar el estado con una nota, usar la vista Red y sincronización |
| Resultado esperado | Todos los flujos operables sin desplazamiento horizontal de la página (solo las tablas de bitácora se desplazan dentro de su contenedor). Tarjetas en móvil y tabla en escritorio. Estados y prioridades con texto e ícono |
| Resultado observado | Verificado con emulación de 375×812, 736 y 1280×800. En móvil no hay elementos que desborden (comprobado midiendo `getBoundingClientRect`, tras corregir el `min-width` de los filtros). Se registró, validó y transicionó desde móvil |
| Evidencia | `T11-tablero-movil.jpg`, `T11-detalle-movil.jpg`, `T05-T11-tablero-escritorio.jpg`, `T09-conflicto-historial-movil.jpg` |
| Conclusión | **Aprobada** (prueba manual) |

### T-12 · Seguridad

| Campo | Contenido |
|---|---|
| Requisito | Seguridad (roles, validación, datos ficticios, secretos) |
| Precondiciones | Nodo activo |
| Pasos | 1. Peticiones sin `X-User` o con un usuario inexistente. 2. Matriz de permisos: el Operador intenta transicionar, asignar y leer la bitácora; el Auditor intenta crear y transicionar. 3. Búsqueda con `' OR 1=1 --`. 4. Pedir un ID no UUID. 5. Revisar las cabeceras CSP. 6. Revisar los archivos de configuración versionados. 7. Un peer no declarado intenta `POST /api/sync/receive`. 8. Llamar a `/api/admin/*` desde otra máquina |
| Resultado esperado | 1 → `401`. 2 → `403 FORBIDDEN` con el permiso requerido (la matriz se lee de la BD). 3 → `200` con 0 resultados (consultas parametrizadas). 4 → `400` sin traza interna. 5 → CSP sin `unsafe-inline` y sin scripts ni estilos inline. 6 → solo variables permitidas, sin secretos. 7 → `403 UNKNOWN_PEER`. 8 → `403 ADMIN_LOCAL_ONLY` |
| Resultado observado | 1–7 verificados automáticamente (T-12, 6 casos, y T-08 «solo peers declarados»). En la UI se comprobó que Operador y Auditor no ven acciones que su rol no permite. El punto 8 se garantiza por código (`localOnly`, que compara la IP de origen con loopback); no se probó desde una segunda máquina |
| Evidencia | `pruebas-automaticas.txt` (T-12); `src/middleware/auth.js`, `src/middleware/localOnly.js` |
| Conclusión | **Aprobada**, con los límites declarados: autenticación simulada (sin contraseñas), sin TLS y secreto entre nodos opcional (`SYNC_SECRET`) |

---

## 3. Resumen

| ID | Prueba | Tipo | Resultado |
|---|---|---|---|
| T-01 | Registro | Automática + demo | ✔ Aprobada |
| T-02 | Validación | Automática + UI | ✔ Aprobada |
| T-03 | Transición | Automática + demo | ✔ Aprobada |
| T-04 | Auditoría | Automática + demo | ✔ Aprobada |
| T-05 | Consulta distribuida | Automática + demo + UI | ✔ Aprobada |
| T-06 | Nodo no disponible | Automática (simulado y real) + demo + UI | ✔ Aprobada |
| T-07 | Desconexión | Automática + demo | ✔ Aprobada |
| T-08 | Sincronización | Automática + demo | ✔ Aprobada |
| T-09 | Conflicto | Automática + demo + UI | ✔ Aprobada |
| T-10 | Restauración | Automática | ✔ Aprobada |
| T-11 | Responsividad | Manual (navegador) | ✔ Aprobada |
| T-12 | Seguridad | Automática + revisión | ✔ Aprobada, con límites declarados |

**Defectos encontrados y corregidos durante las pruebas:**
- Atributos `style` inline bloqueados por la CSP.
- Listeners de la UI que se acumulaban entre vistas.
- Refrescos periódicos que reemplazaban botones y podían perder un clic.
- El panel de simulación se cerraba con cada refresco.
- Desbordamiento horizontal de los filtros en móvil.
- `crypto.randomUUID` no disponible fuera de un contexto seguro (LAN por http).
- En el guion de PowerShell, el nombre de función `H` chocaba con el alias de `Get-History`.
