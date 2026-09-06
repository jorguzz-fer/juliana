# Site estático (nginx) + API do checkout (Node) no mesmo container.
# Coolify: build pack "Dockerfile", porta exposta 80, storage persistente em /data.
FROM node:22-alpine

# nginx do Alpine. A config padrão dele é substituída inteira pelo nosso nginx.conf.
RUN apk add --no-cache nginx \
 && rm -rf /etc/nginx/http.d /etc/nginx/conf.d \
 && mkdir -p /etc/nginx/snippets /usr/share/nginx/html /data /run

COPY nginx.conf            /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY site/                 /usr/share/nginx/html/
COPY checkout/server.js checkout/start.sh /app/

# Falha o build se a config do nginx estiver inválida, em vez de subir um container quebrado.
RUN chmod +x /app/start.sh && nginx -t

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 80

# Só fica "healthy" com o nginx E a API respondendo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health >/dev/null && wget -qO- http://127.0.0.1/api/health >/dev/null || exit 1

CMD ["/app/start.sh"]
