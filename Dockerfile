# Site estático — nginx.
# Coolify: build pack "Dockerfile", porta exposta 80.
FROM nginx:1.27-alpine

# Substitui a config padrão do nginx pela nossa.
RUN rm -f /etc/nginx/conf.d/default.conf && mkdir -p /etc/nginx/snippets
COPY nginx.conf            /etc/nginx/conf.d/site.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf

# Conteúdo do site.
COPY site/ /usr/share/nginx/html/

# Falha o build se a config estiver inválida, em vez de subir um container quebrado.
RUN nginx -t

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
