#!/bin/sh
# Sobe a API do checkout (Node) e o nginx no mesmo container.
# O Node roda em loop: se cair, volta em 2 segundos. O nginx fica em
# primeiro plano, que é o processo que o Docker acompanha.
set -e

(
  while true; do
    node --disable-warning=ExperimentalWarning /app/server.js
    echo "[checkout] a API saiu com código $?; reiniciando em 2s" >&2
    sleep 2
  done
) &

exec nginx -g 'daemon off;'
