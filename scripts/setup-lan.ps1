# Configura ESTE equipo como un nodo para la prueba en DOS computadoras de una LAN de laboratorio.
# Genera config/node<X>.local.env (ignorado por git) y muestra un diagnóstico: IP, perfil de red,
# sincronización de hora, firewall y alcance del otro equipo.
#
# Uso (en el equipo del Nodo A, con la IP del equipo B):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-lan.ps1 -Nodo A -IpPeer 192.168.1.20
# Opciones:
#   -IpLocal 192.168.1.10   IP de este equipo (si no, se detecta)
#   -SyncSecret <valor>     secreto compartido entre nodos (el MISMO en ambos equipos; no se versiona)
#   -GenerarSecreto         genera un secreto aleatorio para copiarlo al otro equipo
#   -Firewall               crea la regla de entrada (requiere PowerShell como ADMINISTRADOR)
#   -QuitarFirewall         elimina la regla al terminar la práctica (ADMINISTRADOR)
#   -BloquearPeer           corte REAL de red con el firewall: bloquea el tráfico entre este nodo y el peer (ADMINISTRADOR)
#   -DesbloquearPeer        quita ese bloqueo (reconexión)
param(
  [Parameter(Mandatory = $true)][ValidateSet('A', 'B')][string]$Nodo,
  [string]$IpPeer,
  [string]$IpLocal,
  [string]$SyncSecret,
  [switch]$GenerarSecreto,
  [switch]$Firewall,
  [switch]$QuitarFirewall,
  [switch]$BloquearPeer,
  [switch]$DesbloquearPeer
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$peer = if ($Nodo -eq 'A') { 'B' } else { 'A' }
$puerto = if ($Nodo -eq 'A') { 3001 } else { 3002 }
$puertoPeer = if ($Nodo -eq 'A') { 3002 } else { 3001 }
$nombre = if ($Nodo -eq 'A') { 'Sector Norte' } else { 'Sector Sur' }
$regla = "Lab2 Nodo $Nodo ($puerto)"
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Mal($t) { Write-Host "  [X]  $t" -ForegroundColor Red }

if ($QuitarFirewall) {
  if (-not $esAdmin) { Mal 'Ejecute PowerShell como administrador para quitar la regla.'; exit 1 }
  Remove-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue
  Ok "Regla '$regla' eliminada."
  exit 0
}
$reglaBloqueo = "Lab2 BLOQUEO Nodo $Nodo <-> $peer"
if ($BloquearPeer -or $DesbloquearPeer) {
  if (-not $esAdmin) { Mal 'Ejecute PowerShell como ADMINISTRADOR.'; exit 1 }
  if ($DesbloquearPeer) {
    Remove-NetFirewallRule -DisplayName $reglaBloqueo -ErrorAction SilentlyContinue
    Ok "Bloqueo eliminado: el tráfico con el Nodo $peer vuelve a fluir (reconexión)."
    exit 0
  }
  if (-not $IpPeer) { Mal 'Falta -IpPeer (IP del otro equipo).'; exit 2 }
  # Una regla de BLOQUEO tiene prioridad sobre cualquier regla de permiso (incluida la que Windows
  # crea para node.exe), así que corta la comunicación en ambos sentidos de forma real.
  New-NetFirewallRule -DisplayName $reglaBloqueo -Direction Inbound -Protocol TCP -LocalPort $puerto -RemoteAddress $IpPeer -Action Block | Out-Null
  New-NetFirewallRule -DisplayName $reglaBloqueo -Direction Outbound -Protocol TCP -RemoteAddress $IpPeer -RemotePort $puertoPeer -Action Block | Out-Null
  Ok "Bloqueo creado ('$reglaBloqueo'): entrada TCP $puerto desde $IpPeer y salida hacia ${IpPeer}:$puertoPeer."
  Write-Host "     Para reconectar: mismo comando con -DesbloquearPeer"
  exit 0
}
if (-not $IpPeer) { Mal 'Falta -IpPeer (IP del otro equipo). Obténgala con ipconfig en ese equipo.'; exit 2 }
if ($IpPeer -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Mal "IP inválida: $IpPeer"; exit 2 }

Write-Host "`n== Nodo $Nodo ($nombre) · puerto $puerto · peer $peer en ${IpPeer}:$puertoPeer ==" -ForegroundColor Cyan

# 1) IP local
Write-Host "`n1) Dirección IP de este equipo"
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object IPAddress, InterfaceAlias, PrefixLength
$ips | ForEach-Object { Write-Host ("     {0,-16} /{1,-3} {2}" -f $_.IPAddress, $_.PrefixLength, $_.InterfaceAlias) }
if (-not $IpLocal) {
  # Preferir el adaptador con puerta de enlace (Wi-Fi/Ethernet real) y descartar adaptadores virtuales.
  $real = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback' }
  $IpLocal = ($real | ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1)
  if (-not $IpLocal) { $IpLocal = ($ips | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|WSL|Hyper-V|VirtualBox|VMware' } | Select-Object -First 1).IPAddress }
}
if ($IpLocal) { Ok "Se usará $IpLocal (indíquela con -IpLocal si es otra). El otro equipo debe usar esta IP como -IpPeer." }
else { Mal 'No se encontró una IP de red. ¿Está conectado a la red del laboratorio?' }

# 2) Perfil de red
Write-Host "`n2) Perfil de red (debe ser Privado para que aplique la regla de firewall)"
foreach ($p in Get-NetConnectionProfile) {
  if ($p.NetworkCategory -eq 'Public') {
    Aviso "'$($p.Name)' ($($p.InterfaceAlias)) es PÚBLICA. Cámbiela a Privada: Configuración → Red e Internet → (red) → Perfil de red: Privado"
    Aviso "  o como administrador: Set-NetConnectionProfile -InterfaceAlias '$($p.InterfaceAlias)' -NetworkCategory Private"
  } else { Ok "'$($p.Name)' ($($p.InterfaceAlias)) es $($p.NetworkCategory)" }
}

# 3) Hora
Write-Host "`n3) Sincronización de hora (LWW compara marcas de tiempo entre equipos)"
$w32 = (w32tm /query /status 2>&1) -join "`n"
if ($LASTEXITCODE -eq 0) {
  $fuente = ($w32 -split "`n" | Where-Object { $_ -match '^(Fuente|Source):' }) -join ''
  $ultima = ($w32 -split "`n" | Where-Object { $_ -match '^(Última sincronización|Hora de la última sincronización correcta|Last Successful Sync Time):' }) -join ''
  Ok "Servicio de hora activo. $fuente $ultima"
} else { Aviso 'No se pudo consultar el servicio de hora. Sincronice manualmente: Configuración → Hora e idioma → Sincronizar ahora.' }
Write-Host '     Tras arrancar ambos nodos, la pestaña "Red y sincronización" muestra el desfase medido (debe ser < 1000 ms).'

# 4) Firewall
Write-Host "`n4) Firewall (entrada TCP $puerto solo desde la subred local)"
$existe = Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue
if ($Firewall) {
  if (-not $esAdmin) { Mal 'Para crear la regla ejecute PowerShell como ADMINISTRADOR y repita con -Firewall.' }
  elseif ($existe) { Ok "La regla '$regla' ya existe." }
  else {
    New-NetFirewallRule -DisplayName $regla -Direction Inbound -Protocol TCP -LocalPort $puerto -RemoteAddress LocalSubnet -Action Allow -Profile Private, Domain | Out-Null
    Ok "Regla creada: '$regla' (TCP $puerto, solo LocalSubnet, perfiles Privado/Dominio). Quítela al terminar con -QuitarFirewall."
  }
} elseif ($existe) { Ok "La regla '$regla' existe." }
else { Aviso "No existe la regla. Como ADMINISTRADOR ejecute el mismo comando agregando -Firewall." }

# 5) Archivo de configuración
Write-Host "`n5) Configuración del nodo"
if ($GenerarSecreto) {
  $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $SyncSecret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Aviso "Secreto generado. Úselo TAMBIÉN en el otro equipo con:  -SyncSecret $SyncSecret"
}
$lineas = @(
  '# Generado por scripts/setup-lan.ps1 para la prueba en DOS equipos. NO versionar (ignorado por .gitignore).',
  "NODE_ID=$Nodo",
  "NODE_NAME=$nombre",
  'HOST=0.0.0.0',
  "PORT=$puerto",
  "DB_PATH=data/node$Nodo.db",
  "PEERS=$peer=http://${IpPeer}:$puertoPeer",
  'PEER_TIMEOUT_MS=2500',
  'HEARTBEAT_MS=5000',
  'SYNC_INTERVAL_MS=3000'
)
if ($SyncSecret) { $lineas += "SYNC_SECRET=$SyncSecret" }
$archivo = Join-Path $root "config/node$Nodo.local.env"
[IO.File]::WriteAllLines($archivo, $lineas, (New-Object Text.UTF8Encoding $false))
Ok "Escrito config/node$Nodo.local.env (PEERS=$peer=http://${IpPeer}:$puertoPeer$(if ($SyncSecret) { ', con SYNC_SECRET' }))"

# 6) Alcance del otro equipo
Write-Host "`n6) ¿Se alcanza el otro equipo?"
$ping = Test-Connection -ComputerName $IpPeer -Count 2 -Quiet -ErrorAction SilentlyContinue
if ($ping) { Ok "Responde a ping ($IpPeer)." } else { Aviso "No responde a ping (Windows bloquea ping por defecto; no es grave). Se probará el puerto." }
$tcp = Test-NetConnection -ComputerName $IpPeer -Port $puertoPeer -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) { Ok "Puerto ${IpPeer}:$puertoPeer abierto: el Nodo $peer está escuchando y su firewall lo permite." }
else { Aviso "Puerto ${IpPeer}:$puertoPeer cerrado: el Nodo $peer aún no arranca, o falta su regla de firewall / perfil Privado." }

Write-Host "`n== Siguiente paso ==" -ForegroundColor Cyan
Write-Host "  npm run start:lan:$($Nodo.ToLower())"
Write-Host "  Interfaz: http://localhost:$puerto  (desde otro equipo o celular: http://${IpLocal}:$puerto)"
