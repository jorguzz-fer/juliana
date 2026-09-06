#!/bin/sh
# Sobe a API do checkout (Node) e o nginx no mesmo container.
# O Node roda em loop: se cair, volta em 2 segundos. O nginx fica em
# primeiro plano, que é o processo que o Docker acompanha.
set -e

# O Coolify injeta PORT=80 e HOST=0.0.0.0. A porta 80 é do nginx; a API
# escuta em 127.0.0.1:3000 e lê só CHECKOUT_HOST/CHECKOUT_PORT.
unset PORT HOST

(
  while true; do
    node --disable-warning=ExperimentalWarning /app/server.js
    echo "[checkout] a API saiu com código $?; reiniciando em 2s" >&2
    sleep 2
  done
) &

exec nginx -g 'daemon off;'
