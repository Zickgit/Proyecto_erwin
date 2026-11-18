# Sistema distribuido de alertas y atención de incidentes

Prototipo académico. UNACH, Licenciatura en Ingeniería en Desarrollo y Tecnologías de Software, Cómputo distribuido (RE04), Laboratorio Integrador 02.

> ⚠️ **No es un servicio real de emergencias** y no sustituye a los canales oficiales. Todos los datos, personas y ubicaciones son **ficticios**. La topología Mesh/MANET y la separación física de los nodos son **simuladas** (ver [docs/RED_MESH_MANET.md](docs/RED_MESH_MANET.md)).

Dos nodos independientes (A en el **:3001** y B en el **:3002**), cada uno con su propia base **SQLite**:
- registran incidentes con UUID y bitácora inalterable;
- los replican de forma asíncrona mediante una cola persistente;
- siguen operando sin conexión y se sincronizan solos al reconectar, con deduplicación por UUID y *Last Write Wins*;
- ofrecen una consulta agregada que identifica el origen de cada dato y los nodos caídos;
- tienen una interfaz web responsiva que muestra el origen, la marca de sincronización y avisos de disponibilidad.

**Stack:** Node.js ≥ 22.13 · Express 5 · SQLite nativo (`node:sqlite`) · HTML, CSS y JS sin compilación. La única dependencia es `express`.

---

## 1. Puesta en marcha (entorno limpio)

```bash
npm install
npm test             # 35 pruebas automáticas con procesos reales (~8 s)
npm run start:all    # Nodo A :3001 + Nodo B :3002 (Ctrl+C detiene ambos)
```

Abre **http://127.0.0.1:3001** (Nodo A · Sector Norte) o **http://127.0.0.1:3002** (Nodo B · Sector Sur) y elige un usuario de prueba en la barra superior:

| Usuario | Rol | Puede |
|---|---|---|
| `op.norte`, `op.sur` | Operador | Registrar y consultar |
| `coord` | Coordinador | Todo lo anterior, más validar, asignar, cambiar estado, bitácora y sincronización |
| `auditor` | Auditor | Solo lectura: incidentes, bitácora y sincronización |

Para la demostración conviene **un nodo por terminal**, así se puede tirar y reiniciar uno sin afectar al otro:

```bash
npm run start:a      # terminal 1
npm run start:b      # terminal 2
```

## 2. Pruebas T-01 a T-12

| ID | Prueba | Cómo ejecutarla | Detalle |
|---|---|---|---|
| T-01 | Registro | `npm test` · UI «+ Nuevo» | [PRUEBAS.md#t-01](docs/PRUEBAS.md#t-01--registro) |
| T-02 | Validación | `npm test` · UI con datos inválidos | [#t-02](docs/PRUEBAS.md#t-02--validación) |
| T-03 | Transición | `npm test` · detalle del incidente | [#t-03](docs/PRUEBAS.md#t-03--transición) |
| T-04 | Auditoría | `npm test` · historial / Bitácora | [#t-04](docs/PRUEBAS.md#t-04--auditoría) |
| T-05 | Consulta distribuida | `npm test` · Tablero «Agregada» | [#t-05](docs/PRUEBAS.md#t-05--consulta-distribuida) |
| T-06 | Nodo no disponible | `npm test` · tirar B y abrir el Tablero de A | [#t-06](docs/PRUEBAS.md#t-06--nodo-no-disponible) |
| T-07 | Desconexión | `npm test` · tirar B y registrar en A | [#t-07](docs/PRUEBAS.md#t-07--desconexión) |
| T-08 | Sincronización | `npm test` · reiniciar B | [#t-08](docs/PRUEBAS.md#t-08--sincronización) |
| T-09 | Conflicto | `npm test` · `scripts/demo.ps1`, paso 6 | [#t-09](docs/PRUEBAS.md#t-09--conflicto) |
| T-10 | Restauración | `npm test` · `npm run backup` / `restore` | [#t-10](docs/PRUEBAS.md#t-10--restauración) |
| T-11 | Responsividad | Manual: navegador a 375 px y escritorio | [#t-11](docs/PRUEBAS.md#t-11--responsividad) |
| T-12 | Seguridad | `npm test` · revisión | [#t-12](docs/PRUEBAS.md#t-12--seguridad) |

```bash
npm test                 # las 35 pruebas automáticas
npm run test:evidence    # igual, y guarda docs/evidencias/pruebas-automaticas.txt
```

```powershell
# Guion completo de la defensa (sección 11 del laboratorio) contra los nodos 3001/3002.
# Guarda la transcripción en docs/evidencias/demo-<fecha>.txt
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -Pausa
```

Las pruebas automáticas usan los puertos 3101 a 3122 y bases temporales: **no tocan** `data/` ni los nodos de demostración.

## 2.1 Prueba en dos computadoras (LAN)

Cada nodo corre en su propia computadora. La red, el firewall y la desconexión (desconectar el Wi-Fi o el cable, o bloquear con el firewall) son **reales**. Guía paso a paso: **[docs/DESPLIEGUE_DOS_EQUIPOS.md](docs/DESPLIEGUE_DOS_EQUIPOS.md)**. Resumen:

```powershell
# En cada equipo, PowerShell como administrador (X = A o B; IP del OTRO equipo):
powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo X -IpPeer <IP_del_otro> -Firewall
npm run start:lan:x                                   # start:lan:a o start:lan:b
# En el equipo A:
npm run net:test -- 20 http://IP_A:3001 http://IP_B:3002
powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -UrlB http://IP_B:3002 -Pausa
```

Antes de empezar, sincroniza la hora en ambos equipos: la política *Last Write Wins* compara marcas de tiempo, y la UI avisa si el desfase supera 1 s.

## 3. Simular la caída de red y evidenciar la recuperación

**Caída real**, terminando el proceso que escucha en el puerto:

```powershell
.\scripts\kill-node.ps1 -Port 3002                 # Windows (o Ctrl+C en la terminal de B)
```
```bash
./scripts/kill-node.sh 3002                        # Linux/macOS
```

Con B caído:
1. Registra un incidente en A: queda **⏳ Pendiente de sincronizar**.
2. El Tablero de A muestra **Resultado PARCIAL** y «Nodo B · NO DISPONIBLE».
3. `GET /api/sync/status` muestra los eventos pendientes en la cola persistente.

**Reconexión:** `npm run start:b`. En 5 s o menos, A detecta `PEER_UP` y envía lo pendiente, sin intervención.

**Corte simulado** (los procesos siguen vivos): UI → *Red y sincronización* → *Simulación de red* → **Cortar enlace / Restablecer enlace**. Equivale a:

```powershell
Invoke-RestMethod -Method Put http://127.0.0.1:3001/api/admin/links/B -Headers @{'Content-Type'='application/json'} -Body '{"up":false}'
```

**Evidenciar la recuperación en la bitácora:**

```powershell
(Invoke-RestMethod "http://127.0.0.1:3001/api/sync/log?limit=10" -Headers @{ 'X-User'='auditor' }).items |
  Select-Object at, peer, kind, @{n='detalle';e={$_.detail | ConvertTo-Json -Compress}} | Format-Table -Wrap
```

Secuencia observada: `PEER_DOWN (CONNECTION_REFUSED)` → `PUSH_FAIL` → `PEER_UP` → `PUSH_OK {"reason":"RECONEXION","delivered":1,"results":{"APLICADO":1}}`. También se ve en la UI (pestaña *Red y sincronización*) y en la tabla `sync_log` del `.db`. Detalle completo en [docs/PRUEBAS.md §1](docs/PRUEBAS.md#1-cómo-simular-la-caída-de-red-y-evidenciar-la-recuperación).

## 4. Respaldo, restauración y reconciliación

```bash
npm run backup -- B                                    # en caliente → backups/nodeB-<fecha>.db (+ .json con sha256)
# detener B, después:
npm run restore -- B backups/nodeB-<fecha>.db          # verifica nodo detenido, integridad e identidad; guarda pre-restore-*
npm run start:b
```

Tras iniciar B, recupera desde los peers lo posterior al respaldo con `POST /api/sync/reconcile` (rol Coordinador) o con el botón *Reconciliar desde peers*.

## 5. Comandos

| Comando | Descripción |
|---|---|
| `npm run start:all` · `start:a` · `start:b` | Levantar los nodos |
| `npm test` · `npm run test:evidence` | Pruebas automáticas (con reporte) |
| `npm run net:test` | Latencia cliente→nodo y nodo→nodo (evidencia en `docs/evidencias/`) |
| `npm run backup -- <A\|B>` · `npm run restore -- <A\|B> <archivo>` | Respaldo y restauración |
| `scripts/kill-node.ps1 -Port N` · `scripts/kill-node.sh N` | Caída real de un nodo |
| `scripts/demo.ps1 [-Pausa] [-UrlB http://IP_B:3002]` | Guion de demostración con transcripción (un equipo o dos) |
| `scripts/setup-lan.ps1 -Nodo X -IpPeer IP [-Firewall] [-BloquearPeer]` | Configuración del modo dos computadoras |
| `npm run start:lan:a` · `start:lan:b` | Arrancar un nodo en modo LAN (`config/nodeX.local.env`) |

## 6. Estructura

```
config/            nodeA.env, nodeB.env (sin secretos) · .env.example
src/
  server.js        arranque de un nodo (CSP, rutas, heartbeat, sincronizador)
  config.js        carga y validación de variables de entorno
  db/              schema.sql (v3), migrate.js (semillas), connection.js (WAL, identidad), tx.js
  domain/          rules.js (estados, catálogos, roles, permisos), validation.js
  repositories/    incidents, audit (append-only), outbox (cola persistente)
  services/        incidents · sync (envío, recepción, LWW, reconciliación) · aggregate (F-05)
  network/         netsim.js: llamadas entre nodos, heartbeat, simulación de enlaces
  middleware/      auth (X-User + permisos desde la BD), errors, localOnly
  routes/          health, network/admin, catalogs/users, incidents, audit, sync/aggregate
public/            cliente web sin compilación: index.html, css/, js/app.js, js/views/*
scripts/           start-all, connectivity-test, kill-node, backup, restore, demo.ps1
tests/             bloque2 (T-01..T-04, T-12), bloque3 (T-05..T-09), bloque5 (T-10)
docs/              documentación + evidencias/
data/  backups/    bases y respaldos generados (ignorados por git)
```

## 7. Documentación

| Documento | Contenido |
|---|---|
| [docs/MANUAL_TECNICO.md](docs/MANUAL_TECNICO.md) | Arquitectura, instalación, configuración, despliegue, administración, diagnóstico, recuperación, seguridad, trazabilidad de requisitos, límites y **respuestas a las preguntas de la defensa** |
| [docs/DESPLIEGUE_DOS_EQUIPOS.md](docs/DESPLIEGUE_DOS_EQUIPOS.md) | Prueba en dos computadoras: IP, perfil de red, hora, firewall, arranque, verificaciones, evidencias y problemas frecuentes |
| [docs/PRUEBAS.md](docs/PRUEBAS.md) | Fichas T-01 a T-12 (precondiciones, pasos, esperado, observado, evidencia, conclusión) y procedimientos de caída y recuperación |
| [docs/MANUAL_USUARIO.md](docs/MANUAL_USUARIO.md) | Uso de la interfaz, roles, avisos e insignias |
| [docs/REGLAS.md](docs/REGLAS.md) | Fase 1: actores, estados, catálogos, identificadores y conflictos, contrato de API |
| [docs/RED_MESH_MANET.md](docs/RED_MESH_MANET.md) | Fase 2: qué es real o simulado, topología, puertos, firewall, latencias medidas |
| [docs/MODELO_DATOS.md](docs/MODELO_DATOS.md) | Fase 3: diagrama entidad-relación, diccionario, transacciones e integridad, SQL |
| [docs/API.md](docs/API.md) | Fase 4: endpoints, roles, errores y ejemplos |
| [docs/SINCRONIZACION.md](docs/SINCRONIZACION.md) | Fase 5: distribución, cola persistente, deduplicación, LWW, consulta agregada |
| [docs/evidencias/](docs/evidencias/) | Reporte de pruebas, transcripción de la demo, mediciones de red y capturas de la UI |

## 8. Lista de verificación de entrega (sección 12 del laboratorio)

- [x] Se ejecuta en un entorno limpio siguiendo este README (`npm install`, `npm test`, `npm run start:all`).
- [x] Diagramas de arquitectura (MANUAL_TECNICO §1), red (RED_MESH_MANET §2) y datos (MODELO_DATOS §1).
- [x] Pruebas con resultados observados y evidencias legibles (PRUEBAS.md y `docs/evidencias/`).
- [x] Distribución, tolerancia a fallos, seguridad y limitaciones documentadas.
- [x] Sin credenciales ni datos sensibles (verificado por la prueba T-12; `data/` y `backups/` en `.gitignore`).
- [ ] Todos los integrantes participaron y pueden explicar las decisiones técnicas: usar MANUAL_TECNICO §11 como guía de estudio.
- [ ] Completar el nombre del equipo, los integrantes, el docente y la fecha en la portada del documento de diseño.
