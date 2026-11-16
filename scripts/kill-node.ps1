# Caída REAL de un nodo: termina el proceso que escucha en el puerto indicado (Windows PowerShell).
# Uso:  .\scripts\kill-node.ps1 -Port 3002
param([Parameter(Mandatory = $true)][int]$Port)

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Output "No hay ningun proceso escuchando en el puerto $Port"; exit 0 }

foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  Write-Output ("[{0}] Deteniendo PID {1} ({2}) que escucha en el puerto {3}" -f (Get-Date -Format o), $procId, $p.ProcessName, $Port)
  Stop-Process -Id $procId -Force -Confirm:$false
}
