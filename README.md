# maternidadesemculpa.com.br

Landing page e checkout do e-book **“Mãe não vem com manual — mas se viesse?”**, de Juliana Martins.
Vendido por R$ 19,90 com Pix, boleto e cartão de crédito, via Asaas.

Um único container: o nginx serve o site estático e repassa `/api` para uma API
Node (sem dependências) que fala com a Asaas, guarda os pedidos em SQLite e
libera o download do PDF quando o pagamento é confirmado.

---

## Estrutura

```
Dockerfile                 imagem: nginx + Node no mesmo container
nginx.conf                 nginx completo: URLs limpas, cache, gzip, proxy /api, página do pedido
security-headers.conf      cabeçalhos de segurança (incluído por location)
checkout/
  server.js                API do checkout: Asaas, SQLite, download do PDF, webhook
  start.sh                 sobe a API e o nginx
  dev/asaas-mock.js        Asaas de mentira, só para testar localmente (não vai para a imagem)
site/                      raiz pública
  index.html               landing page, com o checkout no fim
  checkout.js              formulário, Pix, boleto, cartão e página do pedido
  pedido.html              página do pedido: /pedido/<token>
  politica-de-privacidade.html
  404.html
  robots.txt  sitemap.xml  favicon.svg
  capa-mae-nao-vem-com-manual.webp   capa do e-book (topo da página)
  juliana-perfil.webp                foto com as filhas (seção “O que tem dentro”)
  juliana-retrato.webp               retrato (seção “Quem escreveu”)
  juliana-og.webp                    preview ao compartilhar o link
  placeholder-*.svg        fallback caso um .webp falhe ao carregar
```

---

## Como a venda funciona

1. A compradora preenche nome, e-mail, WhatsApp e CPF e escolhe Pix, cartão ou boleto.
2. A API (`POST /api/checkout`) cria o cliente e a cobrança na Asaas e guarda o
   pedido em `/data/checkout.sqlite`, com um token secreto por pedido.
3. **Pix:** a página mostra o QR code e o “copia e cola” e consulta o pedido a
   cada 4 segundos. **Cartão:** aprovação na hora. **Boleto:** link do PDF e
   linha digitável.
4. A Asaas avisa o pagamento pelo webhook (`POST /api/webhooks/asaas`). Se o
   webhook atrasar, a consulta do pedido confere o status direto na Asaas.
5. Com o pedido pago, a página libera **Baixar o manual (PDF)**
   (`GET /api/pedidos/<token>/download`). O link permanente é
   `/pedido/<token>`, que vai na descrição da cobrança e por isso aparece no
   boleto e nos e-mails que a Asaas manda para a compradora.
6. Se `FUNNEL_API_URL` estiver configurada, cada pedido criado e cada pagamento
   confirmado são enviados para lá (detalhes em *Integração com o funil*).

Os dados do cartão passam pela API só para chegar à Asaas: não são gravados
no banco nem escritos no log.

---

## Configuração (variáveis de ambiente no Coolify)

| Variável              | Obrigatória | O que é |
|-----------------------|-------------|---------|
| `ASAAS_API_KEY`       | sim | Chave de API da Asaas. Sem ela o checkout responde “pagamento não configurado”. |
| `ASAAS_ENV`           | sim | `sandbox` (padrão) ou `production`. Só mude para `production` depois de testar. |
| `ASAAS_WEBHOOK_TOKEN` | sim | Um segredo que você inventa e cadastra no webhook da Asaas. Eventos sem ele são recusados. |
| `PUBLIC_URL`          | sim | `https://maternidadesemculpa.com.br`. Usado nos links do pedido. |
| `PRECO_CENTAVOS`      | não | Preço em centavos. Padrão `1990`. |
| `EBOOK_PATH`          | não | Caminho do PDF dentro do container. Padrão `/data/ebook.pdf`. |
| `EBOOK_FILENAME`      | não | Nome do arquivo que a compradora baixa. Padrão `mae-nao-vem-com-manual.pdf`. |
| `FUNNEL_API_URL`      | não | URL base da API do funil de WhatsApp. Vazio = não envia nada. |
| `DATA_DIR`            | não | Pasta dos dados (banco e PDF). Padrão `/data`. |

`GET /api/health` mostra o que está configurado, sem expor segredos:
`{"ok":true,"asaas":true,"ambiente":"production","webhook":true,"ebook":true}`.

### Passo a passo na Asaas

1. **Chave de API.** Na conta Asaas (ou no sandbox, em sandbox.asaas.com, para
   testar), vá em *Integrações → API* e gere uma chave. Coloque em `ASAAS_API_KEY`.
2. **Chave Pix.** Cadastre uma chave Pix na conta. Sem isso a Asaas não gera
   cobranças Pix.
3. **Cartão.** Confirme que a conta está liberada para receber cartão pela API;
   isso depende da aprovação cadastral da Asaas.
4. **Webhook.** Em *Integrações → Webhooks*, crie um webhook com:
   - URL: `https://maternidadesemculpa.com.br/api/webhooks/asaas`
   - Token de acesso: o mesmo valor que você colocou em `ASAAS_WEBHOOK_TOKEN`
   - Eventos: todos os de cobrança (`PAYMENT_*`). A API usa o status da cobrança,
     não o nome do evento, e responde `200` até para o que ignora, para a fila
     da Asaas não pausar.
5. Faça o deploy e confira `https://maternidadesemculpa.com.br/api/health`.

### O arquivo do e-book

O PDF **não fica no repositório**, que é público. Ele precisa estar no servidor,
na pasta de dados do container:

1. No Coolify, dentro da aplicação: *Storages → Add → Volume Mount*.
   Source: `/data/maternidadesemculpa` (uma pasta na VPS). Destination: `/data`.
   Salve e faça redeploy. Esse mesmo volume guarda o banco de pedidos, então
   **sem ele os pedidos somem a cada deploy**.
2. Copie o PDF para a VPS:
   ```bash
   scp mae-nao-vem-com-manual.pdf root@IP_DA_VPS:/data/maternidadesemculpa/ebook.pdf
   ```
3. Confira: `curl https://maternidadesemculpa.com.br/api/health` deve responder `"ebook":true`.

### Testar no sandbox antes de vender

Com `ASAAS_ENV=sandbox` e uma chave do sandbox, faça um pedido de cada tipo. No
painel do sandbox dá para marcar um Pix ou boleto como pago; o webhook chega e o
download libera. Quando tudo estiver certo, troque a chave pela de produção,
mude `ASAAS_ENV` para `production` e cadastre o webhook de novo na conta de
produção.

Os campos e endpoints da API da Asaas usados aqui (`/customers`, `/payments`,
`/payments/{id}/pixQrCode`, `/payments/{id}/identificationField`, webhook com
header `asaas-access-token`) foram escritos de memória, sem acesso à
documentação no momento. Se algum pedido do sandbox falhar, o log do container
mostra a resposta exata da Asaas, e o ajuste costuma ser de um campo.

### Integração com o funil

Com `FUNNEL_API_URL` definida, a API faz `POST {FUNNEL_API_URL}/leads` em dois
momentos, `evento: "pedido_criado"` e `evento: "pedido_pago"`, com este JSON:

```json
{
  "evento": "pedido_pago",
  "nome": "Ana", "email": "ana@exemplo.com", "telefone": "+5511990000000",
  "segmento": "GESTANTE | PUERPERA_0_3 | MAE_3_12 | null",
  "consent": true, "consent_texto": "Quero receber dicas e novidades da Juliana pelo WhatsApp.",
  "referrer": "...", "landing_page": "...",
  "utm_source": "...", "utm_medium": "...", "utm_campaign": "...", "utm_content": "...", "utm_term": "...",
  "pedido": {
    "id": "ped_...", "url": "https://maternidadesemculpa.com.br/pedido/<token>",
    "forma": "PIX | CREDIT_CARD | BOLETO", "valor_centavos": 1990, "status": "pago",
    "criado_em": "...", "pago_em": "...",
    "download_url": "https://maternidadesemculpa.com.br/api/pedidos/<token>/download"
  }
}
```

`consent` é o opt-in de mensagens com dicas; a compradora sempre pode receber
mensagens sobre o próprio pedido.

---

## Deploy no Coolify

1. **New Resource → Application → Public Repository.**
   Repositório `jorguzz-fer/juliana`, branch `claude/publish-maternidadesemculpa-m7vpc7`
   (é a branch padrão do repositório).
2. **Build Pack:** `Dockerfile`. Dockerfile Location `/Dockerfile`, Base Directory `/`.
3. **Port:** `80` (`Ports Exposes = 80`).
4. **Environment Variables:** as da tabela acima.
5. **Storages:** volume em `/data` (ver *O arquivo do e-book*).
6. **Domains:** `https://maternidadesemculpa.com.br`. O proxy do Coolify emite o
   certificado Let's Encrypt sozinho depois que o DNS estiver apontado.
7. **Health Check** (já embutido no Dockerfile): só fica *healthy* com o nginx
   (`/health`) e a API (`/api/health`) respondendo.
8. **Deploy.**

### DNS

Registros A de `@` e `www` apontando para o IP da VPS. Na Cloudflare, deixe os
dois em **DNS only** (nuvem cinza): com o proxy laranja ligado, a emissão do
certificado pode falhar e o site pode entrar em loop de redirecionamento.

```bash
dig +short maternidadesemculpa.com.br A
curl -I https://maternidadesemculpa.com.br/health
curl https://maternidadesemculpa.com.br/api/health
```

---

## Antes de mandar tráfego

1. **Asaas configurada**: `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` e o webhook
   cadastrado. `/api/health` precisa mostrar `"asaas":true,"webhook":true`.
2. **PDF no volume**: `/api/health` com `"ebook":true`. Sem isso o pedido é pago
   e o download falha.
3. **Política de privacidade**: `site/politica-de-privacidade.html`, seção 1, tem
   três campos em branco: nome/razão social do controlador, CPF/CNPJ e e-mail de
   privacidade. A LGPD exige a identificação do controlador e um canal de contato.
4. **Blocos de rascunho visíveis** (caixas tracejadas com etiqueta vermelha):
   a bio em “Quem escreveu” e os três depoimentos, que precisam ser reais e com
   autorização por escrito. Para tirar uma caixa do ar, remova a classe `ph` e o
   atributo `data-ph` do elemento correspondente em `site/index.html`.

---

## Imagens

Os quatro `.webp` em `site/` são as fotos reais, já recortadas e comprimidas
no tamanho em que a página as exibe. Para trocar alguma, mantenha o nome e a
proporção:

| Arquivo                            | Tamanho  | Onde aparece                              |
|------------------------------------|----------|-------------------------------------------|
| `capa-mae-nao-vem-com-manual.webp` | 760×1216 | capa do e-book, no topo                   |
| `juliana-perfil.webp`              | 720×900  | foto com as filhas, em “O que tem dentro” |
| `juliana-retrato.webp`             | 720×1080 | retrato, em “Quem escreveu”               |
| `juliana-og.webp`                  | 1200×630 | preview ao compartilhar o link            |

Cache das imagens é de 7 dias — a troca aparece rápido, mas peça um
*hard refresh* se estiver vendo a versão antiga. Os `placeholder-*.svg`
continuam no repositório só como fallback, caso um `.webp` falhe ao carregar.

---

## Rodar local

Com Docker, do jeito que vai ao ar (a Asaas de verdade, no sandbox):

```bash
docker build -t msc .
docker run --rm -p 8080:80 -v "$PWD/tmp-dados:/data" \
  -e ASAAS_API_KEY=... -e ASAAS_ENV=sandbox -e ASAAS_WEBHOOK_TOKEN=segredo \
  -e PUBLIC_URL=http://localhost:8080 msc
# http://localhost:8080  (coloque um PDF em tmp-dados/ebook.pdf para testar o download)
```

Sem conta na Asaas, com a Asaas de mentira em `checkout/dev/asaas-mock.js`:

```bash
# 1) Asaas de mentira
WEBHOOK_URL=http://127.0.0.1:3000/api/webhooks/asaas WEBHOOK_TOKEN=segredo node checkout/dev/asaas-mock.js

# 2) API, apontando para o mock
ASAAS_BASE_URL=http://127.0.0.1:3999/v3 ASAAS_API_KEY=chave-de-teste ASAAS_WEBHOOK_TOKEN=segredo \
DATA_DIR=./tmp-dados PUBLIC_URL=http://localhost:8080 node checkout/server.js

# 3) o site, com um nginx local apontando root para site/ e proxy de /api para 127.0.0.1:3000
```

No mock, cartão terminado em `0002` é recusado. Para simular um Pix ou boleto
pago: `curl -X POST http://127.0.0.1:3999/dev/pagar/<id_da_cobranca>` (o id está
em `GET http://127.0.0.1:3999/dev/pagamentos`); o mock dispara o webhook e o
pedido vira pago.

---

## Notas técnicas

- **Fontes:** Fraunces e Karla vêm do Google Fonts. É a única requisição a
  terceiros da página, e está declarada na política de privacidade.
- **CSP:** permite `'unsafe-inline'` para script e style porque o CSS e parte do
  JS da landing são inline. `connect-src 'self' https:` cobre a API em `/api`.
  O QR code do Pix vem como `data:` URI, liberado em `img-src`.
- **URLs limpas:** `/pagina.html` responde `301` para `/pagina`; o canonical
  aponta sempre para a versão sem extensão. `/pedido/<token>` é servido por
  `pedido.html` com `noindex`.
- **Anti-abuso:** honeypot (campo `empresa`) e limite de 8 checkouts por IP a
  cada 10 minutos. Não há captcha.
- **Pedidos:** SQLite em `/data/checkout.sqlite`, tabelas `pedidos` e
  `webhooks` (eventos já processados, para ignorar repetições).
- **Analytics:** os eventos `cta_click`, `checkout_start`, `checkout_submit`,
  `purchase_pending` e `purchase` são empilhados em `window.dataLayer`. Nenhuma
  tag está instalada; se for usar GTM, o script entra no `index.html` e o
  `script-src` da CSP em `security-headers.conf` precisa liberar o domínio.
