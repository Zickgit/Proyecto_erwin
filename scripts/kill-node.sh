#!/usr/bin/env sh
# Caída REAL de un nodo: termina el proceso que escucha en el puerto indicado (Linux/macOS).
# Uso:  ./scripts/kill-node.sh 3002
set -eu
PORT="${1:?Uso: kill-node.sh <puerto>}"
PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "$PIDS" ]; then echo "No hay ningún proceso escuchando en el puerto $PORT"; exit 0; fi
for PID in $PIDS; do
  echo "[$(date -Iseconds)] Deteniendo PID $PID que escucha en el puerto $PORT"
  kill -9 "$PID"
done
