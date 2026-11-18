# Guion de demostración (sección 11 del laboratorio) con evidencia en docs/evidencias/demo-<fecha>.txt
#
# UN EQUIPO (por defecto): Nodo A (3001) y Nodo B (3002) levantados en esta máquina.
#   powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 [-Pausa]
#   En el paso 4 el Nodo B se detiene DE VERDAD y en el paso 5 se reinicia en segundo plano.
#   Al terminar, B queda corriendo; deténgalo con .\scripts\kill-node.ps1 -Port 3002
#
# DOS EQUIPOS: ejecutar en el equipo del Nodo A, indicando la IP del equipo B.
#   powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1 -UrlB http://192.168.1.20:3002 [-Pausa]
#   En los pasos 4 y 5 el script le pedirá desconectar y reconectar el equipo B (detener el nodo
#   o desconectar su Wi-Fi/cable) y esperará a que A lo detecte.
param(
  [switch]$Pausa,
  [string]$UrlA = 'http://127.0.0.1:3001',
  [string]$UrlB = 'http://127.0.0.1:3002'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force docs/evidencias | Out-Null
$stamp = (Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')
Start-Transcript -Path "docs/evidencias/demo-$stamp.txt" | Out-Null

$A = $UrlA.TrimEnd('/'); $B = $UrlB.TrimEnd('/')
$bLocal = $B -match '//(127\.|localhost)'
$modo = if ($bLocal) { 'UN EQUIPO (procesos separados en la misma máquina)' } else { 'DOS EQUIPOS (LAN)' }
function Hdr($u) { @{ 'Content-Type' = 'application/json'; 'X-User' = $u } }
function Paso($n, $t) { Write-Host ""; Write-Host "==== PASO $n · $t ====" -ForegroundColor Cyan; if ($Pausa) { Read-Host 'Enter para continuar' | Out-Null } }
function Esperar($cond, $seg = 15) {
  $fin = (Get-Date).AddSeconds($seg)
  while ((Get-Date) -lt $fin) { try { if (& $cond) { return $true } } catch { }; Start-Sleep -Milliseconds 400 }
  return $false
}
function Tabla($items) { $items | Format-Table -AutoSize | Out-String -Width 200 | Write-Host }
function EstadoPeerEnA { (Invoke-RestMethod "$A/api/network/peers").peers | Where-Object id -eq 'B' | Select-Object -First 1 }

Paso 0 "Verificar nodos · modo: $modo"
foreach ($u in $A, $B) { $h = Invoke-RestMethod "$u/api/health"; Write-Host ("Nodo {0} ({1}) OK en {2} · db={3}" -f $h.node.id, $h.node.name, $u, $h.database.file) }
$pb = EstadoPeerEnA
Write-Host ("A ve a B en {0}: {1} · latencia {2} ms · desfase de reloj {3} ms" -f $pb.url, $pb.status, $pb.lastLatencyMs, $pb.clockSkewMs)
if ($pb.clockSkewMs -ne $null -and [Math]::Abs($pb.clockSkewMs) -gt 1000) { Write-Host 'ATENCIÓN: relojes desincronizados; sincronice la hora antes del paso 6 (conflicto).' -ForegroundColor Red }
Write-Host 'Prototipo académico: NO es un sistema oficial de emergencias. Datos ficticios.' -ForegroundColor Yellow

Paso 1 'Registrar un incidente en el Nodo A y otro en el Nodo B'
$iA = Invoke-RestMethod -Method Post "$A/api/incidents" -Headers (Hdr 'op.norte') -Body '{"category":"INFRAESTRUCTURA","priority":"ALTA","description":"Demo: fuga de agua en edificio ficticio C","location":"Edificio C, planta baja (ficticio)"}'
$iB = Invoke-RestMethod -Method Post "$B/api/incidents" -Headers (Hdr 'op.sur') -Body '{"category":"RIESGO_AMBIENTAL","priority":"CRITICA","description":"Demo: humo en laboratorio ficticio 2","location":"Laboratorio 2, Edificio Sur (ficticio)"}'
Write-Host "A: $($iA.shortId) origen=$($iA.originNode) estado=$($iA.status) sync=$($iA.sync.state)"
Write-Host "B: $($iB.shortId) origen=$($iB.originNode) estado=$($iB.status) sync=$($iB.sync.state)"

Paso 2 'Consulta agregada desde A: origen y fuente de cada dato (T-05)'
Esperar { (Invoke-RestMethod "$A/api/incidents/$($iB.id)" -Headers (Hdr 'auditor')).id -eq $iB.id } | Out-Null
$agg = Invoke-RestMethod "$A/api/aggregate/incidents?q=Demo" -Headers (Hdr 'auditor')
Write-Host "complete=$($agg.complete) total=$($agg.total)"
Tabla ($agg.sources | Select-Object node, role, status, servedFrom, total, latencyMs)
Tabla ($agg.items | Select-Object shortId, originNode, @{n = 'fuente'; e = { $_.source.servedFrom } }, @{n = 'respondio'; e = { $_.source.respondedBy } }, status, @{n = 'sync'; e = { $_.sync.state } })

Paso 3 'Cambiar estado y comprobar auditoría (T-03, T-04)'
try { Invoke-RestMethod -Method Post "$A/api/incidents/$($iA.id)/transition" -Headers (Hdr 'coord') -Body '{"to":"CERRADO"}' | Out-Null } catch { Write-Host "Transición inválida rechazada: $($_.ErrorDetails.Message)" -ForegroundColor Yellow }
Invoke-RestMethod -Method Post "$A/api/incidents/$($iA.id)/transition" -Headers (Hdr 'coord') -Body '{"to":"VALIDADO","note":"Verificado en sitio"}' | Out-Null
Invoke-RestMethod -Method Post "$A/api/incidents/$($iA.id)/assign" -Headers (Hdr 'coord') -Body '{"assignee":"Cuadrilla de Mantenimiento 1"}' | Out-Null
$d = Invoke-RestMethod "$A/api/incidents/$($iA.id)" -Headers (Hdr 'auditor')
Tabla ($d.history | Select-Object at, action, actor, actorRole, node, fromStatus, toStatus, source)

Paso 4 'Desconexión REAL del Nodo B (T-06, T-07)'
if ($bLocal) {
  .\scripts\kill-node.ps1 -Port 3002
} else {
  Write-Host 'En el EQUIPO B haga UNA de estas acciones:' -ForegroundColor Yellow
  Write-Host '  a) Ctrl+C en la terminal del nodo (caída del proceso), o'
  Write-Host '  b) desconecte el Wi-Fi / cable de red (caída REAL de la red).'
  Read-Host 'Pulse Enter cuando B esté desconectado' | Out-Null
}
$caido = Esperar { (EstadoPeerEnA).status -eq 'offline' } 30
Write-Host "A detectó la caída de B: $caido (motivo: $((EstadoPeerEnA).lastError))"
$iP = Invoke-RestMethod -Method Post "$A/api/incidents" -Headers (Hdr 'op.norte') -Body '{"category":"SOLICITUD_APOYO","priority":"MEDIA","description":"Demo: registrado con el Nodo B caido","location":"Auditorio Norte (ficticio)"}'
Write-Host "Creado en A con B caído: $($iP.shortId) sync=$($iP.sync.state)"
Start-Sleep -Seconds 4
$st = (Invoke-RestMethod "$A/api/sync/status" -Headers (Hdr 'auditor')).peers[0]
Write-Host "Cola A->B: pendientes=$($st.outbox.pending) error=$($st.outbox.lastError) peer=$($st.peerStatus)"
$agg = Invoke-RestMethod "$A/api/aggregate/incidents?q=Demo" -Headers (Hdr 'auditor')
Write-Host "Consulta agregada: complete=$($agg.complete) total=$($agg.total)"
Write-Host $agg.warning -ForegroundColor Yellow
Tabla ($agg.sources | Select-Object node, status, error, servedFrom, returned)

Paso 5 'Reconectar el Nodo B y verificar sincronización y deduplicación (T-08)'
if ($bLocal) {
  Start-Process -FilePath (Get-Command node).Source -ArgumentList '--disable-warning=ExperimentalWarning', '--env-file=config/nodeB.env', 'src/server.js' -WorkingDirectory $root -WindowStyle Hidden | Out-Null
} else {
  Write-Host 'En el EQUIPO B: vuelva a iniciar el nodo (npm run start:lan:b) o reconecte la red.' -ForegroundColor Yellow
  Read-Host 'Pulse Enter cuando lo haya hecho' | Out-Null
}
$ok = Esperar { try { (Invoke-RestMethod "$B/api/incidents/$($iP.id)" -Headers (Hdr 'auditor')).id -eq $iP.id } catch { $false } } 45
Write-Host "B recibió el incidente pendiente: $ok"
Esperar { (Invoke-RestMethod "$A/api/sync/status" -Headers (Hdr 'auditor')).peers[0].outbox.pending -eq 0 } | Out-Null
$c1 = (Invoke-RestMethod "$B/api/health").database.counts
Invoke-RestMethod -Method Post "$A/api/sync/run" -Headers (Hdr 'coord') | Out-Null
Invoke-RestMethod -Method Post "$A/api/sync/run" -Headers (Hdr 'coord') | Out-Null
$c2 = (Invoke-RestMethod "$B/api/health").database.counts
Write-Host "Conteos en B antes/después de sincronizar 2 veces más: incidentes $($c1.incidents)/$($c2.incidents) · bitácora $($c1.auditEntries)/$($c2.auditEntries) (sin duplicados)"
Write-Host 'Bitácora persistente de red/sincronización en A (más reciente primero):'
Tabla ((Invoke-RestMethod "$A/api/sync/log?limit=8" -Headers (Hdr 'auditor')).items | Select-Object at, peer, kind, @{n = 'detalle'; e = { $_.detail | ConvertTo-Json -Compress -Depth 4 } })

Paso 6 'Conflicto controlado: partición (corte SIMULADO en A, simétrico), edición en ambos nodos y LWW (T-09)'
# El corte en A basta: A deja de llamar a B y además rechaza lo que B le envía (partición simétrica).
# La simulación solo se acepta desde la máquina del nodo, por eso en modo LAN no se toca B.
Invoke-RestMethod -Method Put "$A/api/admin/links/B" -Headers (Hdr 'coord') -Body '{"up":false}' | Out-Null
Invoke-RestMethod -Method Post "$A/api/incidents/$($iB.id)/transition" -Headers (Hdr 'coord') -Body '{"to":"VALIDADO","note":"edicion en A durante la particion"}' | Out-Null
Start-Sleep -Milliseconds 300
Invoke-RestMethod -Method Post "$B/api/incidents/$($iB.id)/transition" -Headers (Hdr 'coord') -Body '{"to":"CANCELADO","note":"edicion en B (posterior)"}' | Out-Null
Write-Host 'Durante la partición:'
Write-Host ("  A ve: {0}   B ve: {1}" -f (Invoke-RestMethod "$A/api/incidents/$($iB.id)" -Headers (Hdr 'auditor')).status, (Invoke-RestMethod "$B/api/incidents/$($iB.id)" -Headers (Hdr 'auditor')).status)
Invoke-RestMethod -Method Put "$A/api/admin/links/B" -Headers (Hdr 'coord') -Body '{"up":true}' | Out-Null
Esperar { ((Invoke-RestMethod "$A/api/sync/status" -Headers (Hdr 'auditor')).peers[0].outbox.pending -eq 0) -and ((Invoke-RestMethod "$B/api/sync/status" -Headers (Hdr 'auditor')).peers[0].outbox.pending -eq 0) } 30 | Out-Null
$fa = Invoke-RestMethod "$A/api/incidents/$($iB.id)" -Headers (Hdr 'auditor'); $fb = Invoke-RestMethod "$B/api/incidents/$($iB.id)" -Headers (Hdr 'auditor')
Write-Host ("Tras reconectar:  A={0} (v{1}, {2})   B={3} (v{4}, {5})" -f $fa.status, $fa.version, $fa.updatedNode, $fb.status, $fb.version, $fb.updatedNode)
foreach ($pair in @(@('A', $fa), @('B', $fb))) {
  $c = $pair[1].history | Where-Object action -eq 'SYNC_CONFLICTO' | Select-Object -First 1
  Write-Host ("  Nodo {0}: conflicto registrado, ganó {1} (local={2}, remoto={3})" -f $pair[0], $c.details.winner, $c.details.local.status, $c.details.remote.status)
}

Paso 7 'Fin'
Write-Host 'Muestre además: npm test, la interfaz web y docs/. Evidencia guardada en docs/evidencias/.' -ForegroundColor Green
Stop-Transcript | Out-Null
# Privacidad: quitar del encabezado de la transcripción el usuario, el equipo y la ruta del host.
$tr = "docs/evidencias/demo-$stamp.txt"
$privado = '^(Nombre de usuario|Usuario RunAs|M.quina|Aplicaci.n host|Id\. de proceso|Username|RunAs User|Machine|Host Application|Process ID):'
(Get-Content $tr -Encoding UTF8) | ForEach-Object { if ($_ -match $privado) { ($_ -replace ':.*$', ': [omitido]') } else { $_ } } | Set-Content $tr -Encoding UTF8
