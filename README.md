# maternidadesemculpa.com.br

Landing page do e-book **“Mãe não vem com manual — mas se viesse?”**, de Juliana Martins.

Site estático servido por nginx dentro de um container. Sem build step, sem
dependências de runtime: o que está em `site/` é exatamente o que vai ao ar.

---

## Estrutura

```
Dockerfile                 imagem nginx + conteúdo
nginx.conf                 vhost: URLs limpas, cache, gzip, 404
security-headers.conf      cabeçalhos de segurança (incluído por location)
site/                      raiz pública
  index.html               landing page
  politica-de-privacidade.html
  404.html
  config.js                ⚠️ URL da API de leads — editar aqui
  robots.txt  sitemap.xml  favicon.svg
  capa-mae-nao-vem-com-manual.webp   ⚠️ placeholder
  juliana-perfil.webp                ⚠️ placeholder
  juliana-retrato.webp               ⚠️ placeholder
  juliana-og.webp                    ⚠️ placeholder (preview em links)
  placeholder-*.svg        fallback caso um .webp suma
```

---

## Deploy no Coolify

1. **New Resource → Application → Public/Private Repository**
   Repositório: `jorguzz-fer/juliana`, branch `claude/publish-maternidadesemculpa-m7vpc7`
   (o repositório estava vazio, então essa é a branch padrão dele).
   Se preferir `main`, renomeie em *Settings → General → Default branch* no
   GitHub e use `main` aqui.
2. **Build Pack:** `Dockerfile`
   Dockerfile Location: `/Dockerfile` · Base Directory: `/`
3. **Port:** `80` (`Ports Exposes = 80`).
4. **Domains:** `https://maternidadesemculpa.com.br`
   Marque *Generate SSL* / *Force HTTPS*. O Traefik/Caddy do Coolify emite o
   certificado Let's Encrypt sozinho depois que o DNS estiver apontado.
5. **Health Check** (opcional, já embutido no Dockerfile):
   Path `/health`, porta `80`, esperado `200`.
6. **Deploy.**

### DNS no registrador

Aponte o domínio para o IP da VPS **antes** de gerar o SSL:

| Tipo  | Nome  | Valor                | TTL  |
|-------|-------|----------------------|------|
| A     | `@`   | `IP_DA_SUA_VPS`      | 3600 |
| A     | `www` | `IP_DA_SUA_VPS`      | 3600 |

Se preferir que `www` redirecione, adicione `https://www.maternidadesemculpa.com.br`
também no campo Domains do Coolify — ele cria o redirect.

Conferir a propagação:

```bash
dig +short maternidadesemculpa.com.br A
curl -I https://maternidadesemculpa.com.br/health
```

### Alternativa: build pack “Static”

Se preferir não usar Dockerfile, escolha Build Pack `Static` com
Publish Directory `site`. Você perde o `nginx.conf` — ou seja, perde as URLs
limpas (`/politica-de-privacidade` passa a exigir `.html`), os cabeçalhos de
segurança e a política de cache. O Dockerfile é o caminho recomendado.

---

## Antes de mandar tráfego: 3 pendências

### 1. `site/config.js` — os leads não estão sendo salvos

Hoje `FUNNEL_API_URL` está vazio, o que deixa o site em **modo demonstração**:
o formulário valida, mostra a tela de sucesso e o lead é **descartado**. Nada é
gravado e nenhuma mensagem sai no WhatsApp.

```js
window.SITE_CONFIG = {
  FUNNEL_API_URL: "https://api.maternidadesemculpa.com.br"
};
```

O site faz `POST {FUNNEL_API_URL}/leads` com este JSON:

```json
{
  "nome": "Ana",
  "telefone": "+5511990000000",
  "segmento": "GESTANTE | PUERPERA_0_3 | MAE_3_12 | null",
  "consent": true,
  "consent_texto": "Autorizo o contato pelo WhatsApp ...",
  "referrer": "...", "landing_page": "...",
  "utm_source": "...", "utm_medium": "...", "utm_campaign": "...",
  "utm_content": "...", "utm_term": "..."
}
```

A API precisa responder `2xx` e liberar CORS para `https://maternidadesemculpa.com.br`.

`config.js` é servido com `no-store`, então basta editar, commitar e
redeployar — não é preciso mexer no `index.html`.

### 2. Imagens

Os quatro `.webp` em `site/` são **placeholders gerados**, não as fotos reais.
Substitua mantendo exatamente os mesmos nomes e proporções:

| Arquivo                            | Tamanho    | O que é                       |
|------------------------------------|------------|-------------------------------|
| `capa-mae-nao-vem-com-manual.webp` | 760×1216   | capa do e-book                |
| `juliana-perfil.webp`              | 720×1080   | foto na seção “O que tem dentro” |
| `juliana-retrato.webp`             | 720×1080   | retrato na seção “Quem escreveu” |
| `juliana-og.webp`                  | 1200×630   | preview ao compartilhar o link |

Cache das imagens é de 7 dias — a troca aparece rápido, mas peça um
*hard refresh* se estiver vendo a versão antiga.

### 3. Política de privacidade

`site/politica-de-privacidade.html`, seção 1, tem três campos em branco:
nome/razão social do controlador, CPF/CNPJ e e-mail de privacidade. A LGPD
exige a identificação do controlador e um canal de contato — preencha antes de
começar a captar leads ou rodar tráfego pago.

---

## Placeholders visíveis no site

A pedido, a página foi publicada com os blocos de rascunho à mostra
(caixas tracejadas com etiqueta vermelha):

- **“Quem escreveu”** — bio e credencial da Juliana ainda por escrever.
- **“O que outras mães disseram”** — 3 depoimentos, que precisam ser reais e
  com autorização por escrito de quem os deu.

Para tirar uma dessas caixas do ar, remova a classe `ph` e o atributo
`data-ph` do elemento correspondente em `site/index.html`.

---

## Rodar local

```bash
docker build -t msc . && docker run --rm -p 8080:80 msc
# http://localhost:8080
```

Sem Docker, qualquer servidor estático serve para conferir o visual — mas as
URLs limpas e os cabeçalhos só existem com o nginx do Dockerfile.

---

## Notas técnicas

- **Fontes:** Fraunces e Karla vêm do Google Fonts. É a única requisição a
  terceiros da página, e está declarada na política de privacidade.
- **CSP:** permite `'unsafe-inline'` para script e style porque o CSS e o JS da
  landing são inline. `connect-src` aceita `https:` para o POST na API de leads.
- **URLs limpas:** `/pagina.html` responde `301` para `/pagina`; o canonical
  aponta sempre para a versão sem extensão.
- **Anti-spam:** o formulário tem honeypot (campo `empresa`). Não há captcha.
- **Analytics:** os eventos (`form_start`, `whatsapp_click`, `lead`) são
  empilhados em `window.dataLayer`. Nenhuma tag de analytics está instalada —
  se for usar GTM, o script precisa entrar no `index.html` e o `script-src` da
  CSP em `security-headers.conf` precisa liberar o domínio do GTM.
