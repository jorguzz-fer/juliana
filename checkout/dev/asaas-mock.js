#!/usr/bin/env node
/* ------------------------------------------------------------------
   Imitação mínima da API da Asaas, só para rodar o checkout localmente
   sem conta nem internet. NÃO vai para o container (ver .dockerignore).

   Uso:
     MOCK_PORT=3999 WEBHOOK_URL=http://127.0.0.1:3000/api/webhooks/asaas \
     WEBHOOK_TOKEN=segredo node checkout/dev/asaas-mock.js

   E na API: ASAAS_BASE_URL=http://127.0.0.1:3999/v3 ASAAS_API_KEY=chave-de-teste

   Regras:
     - Pix e boleto nascem PENDING. Cartão: aprovado (CONFIRMED), exceto
       número terminado em 0002, que é recusado como a Asaas recusaria.
     - POST /dev/pagar/:id marca a cobrança como RECEIVED e dispara o
       webhook para WEBHOOK_URL, com o header asaas-access-token.
     - POST /dev/status/:id {"status":"REFUNDED"} muda o status à mão.
------------------------------------------------------------------ */
'use strict';
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PORT = Number(process.env.MOCK_PORT || 3999);
const CHAVE = process.env.MOCK_API_KEY || 'chave-de-teste';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

const clientes = new Map();
const cobrancas = new Map();
const novoId = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const agora = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------- PNG de um "QR code" falso, gerado sem dependências ----------
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(tipo, dados) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function qrFalso(semente) {
  const modulos = 29, escala = 8, tam = modulos * escala;
  const hash = crypto.createHash('sha256').update(semente).digest();
  const olho = (x, y) => {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    return d <= 1 || d === 3;
  };
  const preto = (mx, my) => {
    const cantos = [[0, 0], [modulos - 7, 0], [0, modulos - 7]];
    for (const [cx, cy] of cantos) if (mx >= cx && mx < cx + 7 && my >= cy && my < cy + 7) return olho(mx - cx, my - cy);
    if (mx < 1 || my < 1 || mx > modulos - 2 || my > modulos - 2) return false;
    const bit = (my * modulos + mx) % 256;
    return ((hash[bit % 32] >> (bit % 8)) & 1) === 1;
  };
  const raw = Buffer.alloc((tam + 1) * tam);
  for (let y = 0; y < tam; y++) {
    raw[y * (tam + 1)] = 0;
    for (let x = 0; x < tam; x++) raw[y * (tam + 1) + 1 + x] = preto(Math.floor(x / escala), Math.floor(y / escala)) ? 0 : 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tam, 0); ihdr.writeUInt32BE(tam, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// ---------- servidor ----------
function json(res, status, corpo) {
  const s = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function ler(req) {
  return new Promise((resolve) => {
    const p = [];
    req.on('data', (c) => p.push(c));
    req.on('end', () => { try { resolve(p.length ? JSON.parse(Buffer.concat(p).toString()) : {}); } catch { resolve({}); } });
  });
}
async function dispararWebhook(evento, cobranca) {
  if (!WEBHOOK_URL) return console.log('[mock] WEBHOOK_URL não definido; não enviei', evento);
  const corpo = { id: novoId('evt'), event: evento, dateCreated: agora(), payment: cobranca };
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'asaas-access-token': WEBHOOK_TOKEN },
      body: JSON.stringify(corpo),
    });
    console.log(`[mock] webhook ${evento} -> ${r.status}`);
  } catch (e) { console.log('[mock] webhook falhou:', e.message); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rota = url.pathname;
  const m = req.method;
  console.log(`[mock] ${m} ${rota}${url.search}`);

  // rotas de desenvolvimento (sem autenticação)
  let x;
  if (m === 'POST' && (x = rota.match(/^\/dev\/pagar\/(.+)$/))) {
    const c = cobrancas.get(x[1]);
    if (!c) return json(res, 404, { erro: 'cobrança não existe' });
    c.status = 'RECEIVED'; c.paymentDate = agora().slice(0, 10);
    await dispararWebhook('PAYMENT_RECEIVED', c);
    return json(res, 200, c);
  }
  if (m === 'POST' && (x = rota.match(/^\/dev\/status\/(.+)$/))) {
    const c = cobrancas.get(x[1]);
    if (!c) return json(res, 404, { erro: 'cobrança não existe' });
    const b = await ler(req);
    c.status = b.status || c.status;
    await dispararWebhook(b.evento || 'PAYMENT_UPDATED', c);
    return json(res, 200, c);
  }
  if (m === 'GET' && rota === '/dev/pagamentos') return json(res, 200, [...cobrancas.values()]);

  if (!rota.startsWith('/v3/')) return json(res, 404, { errors: [{ code: 'not_found', description: 'rota inexistente' }] });
  if (!req.headers['user-agent']) return json(res, 403, { errors: [{ code: 'forbidden', description: 'User-Agent obrigatório' }] });
  if (req.headers.access_token !== CHAVE) return json(res, 401, { errors: [{ code: 'unauthorized', description: 'chave inválida' }] });

  if (m === 'GET' && rota === '/v3/customers') {
    const cpf = url.searchParams.get('cpfCnpj');
    const lista = [...clientes.values()].filter((c) => !cpf || c.cpfCnpj === cpf);
    return json(res, 200, { object: 'list', hasMore: false, totalCount: lista.length, limit: 10, offset: 0, data: lista });
  }
  if (m === 'POST' && rota === '/v3/customers') {
    const b = await ler(req);
    if (!b.name || !b.cpfCnpj) return json(res, 400, { errors: [{ code: 'invalid_action', description: 'Nome e CPF são obrigatórios.' }] });
    const c = Object.assign({ object: 'customer', id: novoId('cus'), dateCreated: agora().slice(0, 10) }, b);
    clientes.set(c.id, c);
    return json(res, 200, c);
  }
  if (m === 'PUT' && (x = rota.match(/^\/v3\/customers\/(.+)$/))) {
    const c = clientes.get(x[1]);
    if (!c) return json(res, 404, { errors: [{ code: 'not_found', description: 'cliente não existe' }] });
    Object.assign(c, await ler(req));
    return json(res, 200, c);
  }
  if (m === 'POST' && rota === '/v3/payments') {
    const b = await ler(req);
    if (!clientes.has(b.customer)) return json(res, 400, { errors: [{ code: 'invalid_customer', description: 'Cliente inválido.' }] });
    if (!['PIX', 'BOLETO', 'CREDIT_CARD'].includes(b.billingType)) return json(res, 400, { errors: [{ code: 'invalid_billingType', description: 'Forma de pagamento inválida.' }] });
    if (!(b.value >= 5)) return json(res, 400, { errors: [{ code: 'invalid_value', description: 'O valor mínimo é R$ 5,00.' }] });
    const id = novoId('pay');
    const c = {
      object: 'payment', id, dateCreated: agora().slice(0, 10), customer: b.customer,
      billingType: b.billingType, value: b.value, netValue: b.value, description: b.description,
      externalReference: b.externalReference || null, dueDate: b.dueDate, status: 'PENDING',
      invoiceUrl: `http://127.0.0.1:${PORT}/fatura/${id}`, invoiceNumber: String(100000 + cobrancas.size),
      bankSlipUrl: b.billingType === 'BOLETO' ? `http://127.0.0.1:${PORT}/boleto/${id}.pdf` : null,
    };
    if (b.billingType === 'CREDIT_CARD') {
      const cc = b.creditCard || {}, h = b.creditCardHolderInfo || {};
      if (!cc.number || !cc.holderName || !cc.ccv || !cc.expiryMonth || !cc.expiryYear) return json(res, 400, { errors: [{ code: 'invalid_creditCard', description: 'Dados do cartão incompletos.' }] });
      if (!h.name || !h.email || !h.cpfCnpj || !h.postalCode || !h.addressNumber || !h.phone) return json(res, 400, { errors: [{ code: 'invalid_creditCardHolderInfo', description: 'Dados do titular incompletos.' }] });
      if (!b.remoteIp) return json(res, 400, { errors: [{ code: 'invalid_remoteIp', description: 'remoteIp é obrigatório.' }] });
      if (String(cc.number).endsWith('0002')) return json(res, 400, { errors: [{ code: 'invalid_action', description: 'Transação não autorizada. Verifique os dados do cartão e tente novamente.' }] });
      c.status = 'CONFIRMED'; c.confirmedDate = agora().slice(0, 10);
      c.creditCard = { creditCardNumber: String(cc.number).slice(-4), creditCardBrand: 'VISA' };
    }
    cobrancas.set(id, c);
    return json(res, 200, c);
  }
  if (m === 'GET' && (x = rota.match(/^\/v3\/payments\/([^/]+)\/pixQrCode$/))) {
    const c = cobrancas.get(x[1]);
    if (!c) return json(res, 404, { errors: [{ code: 'not_found', description: 'cobrança não existe' }] });
    return json(res, 200, {
      encodedImage: qrFalso(c.id),
      payload: `00020126580014br.gov.bcb.pix0136${c.id}-mock-0000-0000-000000000000520400005303986540${c.value.toFixed(2)}5802BR5925MATERNIDADE SEM CULPA6009SAO PAULO62070503***6304ABCD`,
      expirationDate: `${c.dueDate} 23:59:59`,
    });
  }
  if (m === 'GET' && (x = rota.match(/^\/v3\/payments\/([^/]+)\/identificationField$/))) {
    const c = cobrancas.get(x[1]);
    if (!c) return json(res, 404, { errors: [{ code: 'not_found', description: 'cobrança não existe' }] });
    return json(res, 200, { identificationField: '23793.38128 60007.827136 95000.063305 9 84660000001990', nossoNumero: '6543210', barCode: '23799846600000019903381260007827139500006330' });
  }
  if (m === 'GET' && (x = rota.match(/^\/v3\/payments\/([^/]+)$/))) {
    const c = cobrancas.get(x[1]);
    if (!c) return json(res, 404, { errors: [{ code: 'not_found', description: 'cobrança não existe' }] });
    return json(res, 200, c);
  }
  return json(res, 404, { errors: [{ code: 'not_found', description: 'rota não implementada no mock' }] });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Asaas de mentira em http://127.0.0.1:${PORT}/v3 (chave: ${CHAVE})`);
  console.log(`[mock] webhook: ${WEBHOOK_URL || 'desligado'}`);
});
