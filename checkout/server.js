#!/usr/bin/env node
/* ------------------------------------------------------------------
   API do checkout — maternidadesemculpa.com.br

   Node 22+, sem dependências. Fala com a Asaas (Pix, boleto e cartão),
   guarda os pedidos em SQLite e libera o download do e-book quando o
   pagamento é confirmado, pelo webhook da Asaas ou por consulta ativa.

   Rotas (todas atrás do nginx, em /api):
     GET  /api/health                     estado do serviço (sem segredos)
     GET  /api/config                     preço e formas de pagamento
     POST /api/checkout                   cria cliente + cobrança na Asaas
     GET  /api/pedidos/:token             situação do pedido
     GET  /api/pedidos/:token/download    o PDF, só com pedido pago
     POST /api/webhooks/asaas             eventos de pagamento da Asaas

   Configuração por variáveis de ambiente: ver README.md.
------------------------------------------------------------------ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- configuração ----------
const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);

// Atenção: o Coolify injeta PORT=80 e HOST=0.0.0.0 em todo container. Por isso
// a API usa CHECKOUT_PORT e CHECKOUT_HOST, e ignora PORT e HOST de propósito.
const CFG = {
  host: env('CHECKOUT_HOST', '127.0.0.1'),
  port: Number(env('CHECKOUT_PORT', 3000)),
  dataDir: env('DATA_DIR', '/data'),
  publicUrl: env('PUBLIC_URL', 'https://maternidadesemculpa.com.br').replace(/\/$/, ''),
  precoCentavos: Number(env('PRECO_CENTAVOS', 1990)),
  produtoNome: env('PRODUTO_NOME', 'E-book Mãe não vem com manual - mas se viesse?'),
  ebookFilename: env('EBOOK_FILENAME', 'mae-nao-vem-com-manual.pdf'),
  asaasKey: env('ASAAS_API_KEY', ''),
  asaasEnv: env('ASAAS_ENV', 'sandbox') === 'production' ? 'production' : 'sandbox',
  webhookToken: env('ASAAS_WEBHOOK_TOKEN', ''),
  funnelUrl: env('FUNNEL_API_URL', '').replace(/\/$/, ''),
};
CFG.ebookPath = env('EBOOK_PATH', path.join(CFG.dataDir, 'ebook.pdf'));
CFG.asaasBase = env(
  'ASAAS_BASE_URL',
  CFG.asaasEnv === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3'
).replace(/\/$/, '');

const FORMAS = { PIX: 'Pix', CREDIT_CARD: 'Cartão de crédito', BOLETO: 'Boleto' };
const SEGMENTOS = ['GESTANTE', 'PUERPERA_0_3', 'MAE_3_12'];
const UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// ---------- utilidades ----------
const agora = () => new Date().toISOString();
const log = (...a) => console.log(agora(), ...a);
const soDigitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const reais = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');

function dataSP(dias) {
  // AAAA-MM-DD no fuso de São Paulo, que é o que a Asaas espera em dueDate.
  const d = new Date(Date.now() + (dias || 0) * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function cpfValido(cpf) {
  cpf = soDigitos(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    const digito = ((soma * 10) % 11) % 10;
    if (digito !== Number(cpf[t])) return false;
  }
  return true;
}

function luhn(numero) {
  const n = soDigitos(numero);
  if (n.length < 13 || n.length > 19) return false;
  let soma = 0, alterna = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = Number(n[i]);
    if (alterna) { d *= 2; if (d > 9) d -= 9; }
    soma += d; alterna = !alterna;
  }
  return soma % 10 === 0;
}

const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;
const novoId = () => 'ped_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const novoToken = () => crypto.randomBytes(18).toString('base64url');

function ipDe(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function json(res, status, corpo) {
  const dados = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(dados),
    'Cache-Control': 'no-store',
  });
  res.end(dados);
  return status;
}

function erroHttp(status, mensagem, extra) {
  return Object.assign(new Error(mensagem), { status, expor: true }, extra || {});
}

function lerJson(req, limite) {
  limite = limite || 64 * 1024;
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) { reject(erroHttp(413, 'Requisição grande demais.')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8'))); }
      catch { reject(erroHttp(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

// ---------- limite de tentativas (por IP, em memória) ----------
const tentativas = new Map();
function dentroDoLimite(ip, max, janelaMs) {
  const t = Date.now();
  const lista = (tentativas.get(ip) || []).filter((x) => t - x < janelaMs);
  if (lista.length >= max) return false;
  lista.push(t);
  tentativas.set(ip, lista);
  return true;
}
setInterval(() => {
  const t = Date.now();
  for (const [ip, lista] of tentativas) {
    if (!lista.some((x) => t - x < 10 * 60 * 1000)) tentativas.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- banco ----------
fs.mkdirSync(CFG.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(CFG.dataDir, 'checkout.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS pedidos (
    id                TEXT PRIMARY KEY,
    token             TEXT NOT NULL UNIQUE,
    criado_em         TEXT NOT NULL,
    atualizado_em     TEXT NOT NULL,
    nome              TEXT NOT NULL,
    email             TEXT NOT NULL,
    telefone          TEXT NOT NULL,
    cpf               TEXT NOT NULL,
    segmento          TEXT,
    consent_whatsapp  INTEGER NOT NULL DEFAULT 0,
    forma             TEXT NOT NULL,
    valor_centavos    INTEGER NOT NULL,
    status            TEXT NOT NULL,
    status_asaas      TEXT,
    asaas_customer_id TEXT,
    asaas_payment_id  TEXT UNIQUE,
    invoice_url       TEXT,
    boleto_url        TEXT,
    boleto_linha      TEXT,
    pix_payload       TEXT,
    pix_qr_base64     TEXT,
    pix_expira_em     TEXT,
    pago_em           TEXT,
    verificado_em     TEXT,
    downloads         INTEGER NOT NULL DEFAULT 0,
    ip                TEXT,
    referrer          TEXT,
    landing_page      TEXT,
    utm_source        TEXT,
    utm_medium        TEXT,
    utm_campaign      TEXT,
    utm_content       TEXT,
    utm_term          TEXT
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id          TEXT PRIMARY KEY,
    recebido_em TEXT NOT NULL,
    evento      TEXT,
    payment_id  TEXT,
    payload     TEXT
  );
`);

const buscarPorToken = (t) => db.prepare('SELECT * FROM pedidos WHERE token = ?').get(t);
const buscarPorId = (id) => db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
const buscarPorPagamento = (pid) => db.prepare('SELECT * FROM pedidos WHERE asaas_payment_id = ?').get(pid);

// ---------- cliente Asaas ----------
async function asaas(rota, opcoes) {
  opcoes = opcoes || {};
  const url = new URL(CFG.asaasBase + rota);
  if (opcoes.query) {
    for (const [k, v] of Object.entries(opcoes.query)) if (v != null) url.searchParams.set(k, v);
  }
  let resposta;
  try {
    resposta = await fetch(url, {
      method: opcoes.method || 'GET',
      headers: {
        access_token: CFG.asaasKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'maternidadesemculpa-checkout/1.0',
      },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw Object.assign(new Error('Asaas inacessível: ' + e.message), { status: 502, asaas: null });
  }
  const texto = await resposta.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = { raw: texto.slice(0, 500) }; }
  if (!resposta.ok) {
    const descricoes = Array.isArray(dados.errors) ? dados.errors.map((e) => e.description).filter(Boolean) : [];
    const err = new Error(`Asaas ${resposta.status} em ${opcoes.method || 'GET'} ${rota}: ${descricoes.join(' | ') || texto.slice(0, 300)}`);
    err.status = resposta.status;
    err.asaas = dados;
    err.descricoes = descricoes;
    throw err;
  }
  return dados;
}

async function obterOuCriarCliente(d) {
  const busca = await asaas('/customers', { query: { cpfCnpj: d.cpf, limit: 1 } });
  const dados = { name: d.nome, cpfCnpj: d.cpf, email: d.email, mobilePhone: d.telefone, notificationDisabled: false };
  if (busca && Array.isArray(busca.data) && busca.data.length) {
    const id = busca.data[0].id;
    // Mantém e-mail e telefone atualizados para as notificações da Asaas. Falha aqui não impede a compra.
    try { await asaas('/customers/' + id, { method: 'PUT', body: dados }); }
    catch (e) { log('aviso: não atualizei o cliente', id, '-', e.message); }
    return id;
  }
  const criado = await asaas('/customers', { method: 'POST', body: Object.assign({ externalReference: d.pedidoId }, dados) });
  return criado.id;
}

async function criarCobranca(p) {
  const corpo = {
    customer: p.customerId,
    billingType: p.forma,
    value: Number((CFG.precoCentavos / 100).toFixed(2)),
    dueDate: dataSP(p.forma === 'BOLETO' ? 3 : p.forma === 'PIX' ? 1 : 0),
    description: `${CFG.produtoNome}. Acompanhe seu pedido em ${CFG.publicUrl}/pedido/${p.token}`,
    externalReference: p.pedidoId,
  };
  if (p.forma === 'CREDIT_CARD') {
    corpo.creditCard = {
      holderName: p.cartao.nome,
      number: p.cartao.numero,
      expiryMonth: p.cartao.mes,
      expiryYear: p.cartao.ano,
      ccv: p.cartao.cvv,
    };
    corpo.creditCardHolderInfo = {
      name: p.nome,
      email: p.email,
      cpfCnpj: p.cpf,
      postalCode: p.cartao.cep,
      addressNumber: p.cartao.numeroEndereco,
      phone: p.telefone,
      mobilePhone: p.telefone,
    };
    corpo.remoteIp = p.ip;
  }
  const cobranca = await asaas('/payments', { method: 'POST', body: corpo });
  const extra = {};
  if (p.forma === 'PIX') {
    const qr = await asaas(`/payments/${cobranca.id}/pixQrCode`);
    extra.pix_qr_base64 = qr.encodedImage || null;
    extra.pix_payload = qr.payload || null;
    extra.pix_expira_em = qr.expirationDate || null;
  } else if (p.forma === 'BOLETO') {
    try {
      const linha = await asaas(`/payments/${cobranca.id}/identificationField`);
      extra.boleto_linha = linha.identificationField || null;
    } catch (e) { log('aviso: sem linha digitável para', cobranca.id, '-', e.message); }
    extra.boleto_url = cobranca.bankSlipUrl || cobranca.invoiceUrl || null;
  }
  return Object.assign({ cobranca }, extra);
}

// ---------- pedidos ----------
function mapearStatus(s) {
  switch (s) {
    case 'RECEIVED': case 'CONFIRMED': case 'RECEIVED_IN_CASH': return 'pago';
    case 'PENDING': case 'AWAITING_RISK_ANALYSIS': return 'pendente';
    case 'OVERDUE': return 'vencido';
    case 'REFUNDED': case 'REFUND_REQUESTED': case 'REFUND_IN_PROGRESS':
    case 'CHARGEBACK_REQUESTED': case 'CHARGEBACK_DISPUTE': case 'AWAITING_CHARGEBACK_REVERSAL': return 'estornado';
    default: return null; // status que não conhecemos: não mexe no pedido
  }
}

function aplicarStatus(pedido, statusAsaas, origem) {
  const t = agora();
  const novo = mapearStatus(statusAsaas);
  if (!novo) {
    db.prepare('UPDATE pedidos SET status_asaas = ?, verificado_em = ? WHERE id = ?').run(statusAsaas, t, pedido.id);
    return buscarPorId(pedido.id);
  }
  const virouPago = novo === 'pago' && pedido.status !== 'pago';
  db.prepare(`UPDATE pedidos SET status = ?, status_asaas = ?, atualizado_em = ?, verificado_em = ?,
              pago_em = COALESCE(pago_em, ?) WHERE id = ?`)
    .run(novo, statusAsaas, t, t, virouPago ? t : null, pedido.id);
  const atual = buscarPorId(pedido.id);
  if (novo !== pedido.status) log(`pedido ${pedido.id}: ${pedido.status} -> ${novo} (${origem}, asaas=${statusAsaas})`);
  if (virouPago) enviarFunil(atual, 'pedido_pago');
  return atual;
}

function publico(p) {
  const pendente = p.status === 'pendente';
  return {
    id: p.id,
    token: p.token,
    status: p.status,
    forma: p.forma,
    forma_nome: FORMAS[p.forma] || p.forma,
    valor_centavos: p.valor_centavos,
    valor_texto: reais(p.valor_centavos),
    criado_em: p.criado_em,
    pago_em: p.pago_em || null,
    url: `${CFG.publicUrl}/pedido/${p.token}`,
    download_url: p.status === 'pago' ? `/api/pedidos/${p.token}/download` : null,
    pix: p.forma === 'PIX' && pendente && p.pix_payload
      ? { payload: p.pix_payload, qr_base64: p.pix_qr_base64, expira_em: p.pix_expira_em }
      : null,
    boleto: p.forma === 'BOLETO' && p.boleto_url ? { url: p.boleto_url, linha: p.boleto_linha } : null,
    invoice_url: p.invoice_url || null,
  };
}

// Encaminha o pedido para a API do funil (WhatsApp), se configurada. Nunca bloqueia a resposta.
function enviarFunil(p, evento) {
  if (!CFG.funnelUrl) return;
  const corpo = {
    evento,
    nome: p.nome,
    email: p.email,
    telefone: '+55' + p.telefone,
    segmento: p.segmento,
    consent: !!p.consent_whatsapp,
    consent_texto: p.consent_whatsapp ? 'Quero receber dicas e novidades da Juliana pelo WhatsApp.' : null,
    referrer: p.referrer, landing_page: p.landing_page,
    utm_source: p.utm_source, utm_medium: p.utm_medium, utm_campaign: p.utm_campaign,
    utm_content: p.utm_content, utm_term: p.utm_term,
    pedido: {
      id: p.id, url: `${CFG.publicUrl}/pedido/${p.token}`, forma: p.forma, valor_centavos: p.valor_centavos,
      status: p.status, criado_em: p.criado_em, pago_em: p.pago_em || null,
      download_url: p.status === 'pago' ? `${CFG.publicUrl}/api/pedidos/${p.token}/download` : null,
    },
  };
  fetch(CFG.funnelUrl + '/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'maternidadesemculpa-checkout/1.0' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(10000),
  }).then((r) => {
    if (!r.ok) log(`funil respondeu ${r.status} para ${evento} do pedido ${p.id}`);
  }).catch((e) => log(`funil indisponível (${evento}, pedido ${p.id}): ${e.message}`));
}

// ---------- rotas ----------
function health(res) {
  return json(res, 200, {
    ok: true,
    asaas: !!CFG.asaasKey,
    ambiente: CFG.asaasEnv,
    webhook: !!CFG.webhookToken,
    ebook: fs.existsSync(CFG.ebookPath),
  });
}

function config(res) {
  return json(res, 200, {
    ativo: !!CFG.asaasKey,
    ambiente: CFG.asaasEnv,
    preco_centavos: CFG.precoCentavos,
    preco_texto: reais(CFG.precoCentavos),
    formas: Object.keys(FORMAS),
  });
}

function campoInvalido(campo, mensagem) {
  return erroHttp(422, mensagem, { campo, erro: 'campo_invalido' });
}

function validarCheckout(b) {
  const d = {};
  d.nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
  if (d.nome.length < 2 || d.nome.length > 120) throw campoInvalido('nome', 'Escreve seu nome pra eu saber como te chamar.');
  d.email = String(b.email || '').trim().toLowerCase();
  if (!emailValido(d.email)) throw campoInvalido('email', 'Confere o e-mail: é nele que chega o comprovante.');
  d.telefone = soDigitos(b.telefone);
  if (d.telefone.length === 13 && d.telefone.startsWith('55')) d.telefone = d.telefone.slice(2);
  if (d.telefone.length < 10 || d.telefone.length > 11) throw campoInvalido('telefone', 'Confere o WhatsApp, com DDD.');
  d.cpf = soDigitos(b.cpf);
  if (!cpfValido(d.cpf)) throw campoInvalido('cpf', 'Confere o CPF. Ele é obrigatório para o pagamento.');
  d.forma = String(b.forma || '');
  if (!FORMAS[d.forma]) throw campoInvalido('forma', 'Escolhe como você quer pagar.');
  if (b.consent_politica !== true) throw campoInvalido('consent_politica', 'Preciso que você aceite a Política de Privacidade para continuar.');
  d.consentWhatsapp = b.consent_whatsapp === true ? 1 : 0;
  d.segmento = SEGMENTOS.includes(b.segmento) ? b.segmento : null;
  d.referrer = b.referrer ? String(b.referrer).slice(0, 500) : null;
  d.landingPage = b.landing_page ? String(b.landing_page).slice(0, 500) : null;
  for (const k of UTMS) d[k] = b[k] ? String(b[k]).slice(0, 200) : null;

  if (d.forma === 'CREDIT_CARD') {
    const c = b.cartao || {};
    const numero = soDigitos(c.numero);
    if (!luhn(numero)) throw campoInvalido('cartao_numero', 'Confere o número do cartão.');
    const nome = String(c.nome || '').trim().replace(/\s+/g, ' ');
    if (nome.length < 2 || nome.length > 80) throw campoInvalido('cartao_nome', 'Escreve o nome como está impresso no cartão.');
    const mes = soDigitos(c.mes).padStart(2, '0');
    let ano = soDigitos(c.ano);
    if (ano.length === 2) ano = '20' + ano;
    if (!(Number(mes) >= 1 && Number(mes) <= 12) || ano.length !== 4) throw campoInvalido('cartao_validade', 'Confere a validade, no formato MM/AA.');
    const hoje = dataSP(0);
    if (ano + '-' + mes < hoje.slice(0, 7)) throw campoInvalido('cartao_validade', 'Esse cartão já venceu.');
    const cvv = soDigitos(c.cvv);
    if (cvv.length < 3 || cvv.length > 4) throw campoInvalido('cartao_cvv', 'Confere o código de segurança (CVV).');
    const cep = soDigitos(c.cep);
    if (cep.length !== 8) throw campoInvalido('cartao_cep', 'Confere o CEP do endereço da fatura.');
    const numeroEndereco = String(c.numero_endereco || '').trim().slice(0, 10);
    if (!numeroEndereco) throw campoInvalido('cartao_endereco', 'Falta o número do endereço da fatura.');
    d.cartao = { numero, nome, mes, ano, cvv, cep, numeroEndereco };
  }
  return d;
}

async function criarPedido(req, res) {
  if (!CFG.asaasKey) {
    return json(res, 503, { erro: 'pagamento_nao_configurado', mensagem: 'O pagamento ainda não está configurado. Tente de novo mais tarde.' });
  }
  const ip = ipDe(req);
  if (!dentroDoLimite(ip, 8, 10 * 60 * 1000)) {
    return json(res, 429, { erro: 'muitas_tentativas', mensagem: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.' });
  }
  const b = await lerJson(req);
  if (b.empresa) return json(res, 200, { ok: true }); // honeypot preenchido: finge sucesso e descarta

  const d = validarCheckout(b);
  const pedidoId = novoId();
  const token = novoToken();
  const t = agora();

  let customerId, resultado;
  try {
    customerId = await obterOuCriarCliente({ nome: d.nome, cpf: d.cpf, email: d.email, telefone: d.telefone, pedidoId });
    resultado = await criarCobranca({
      customerId, forma: d.forma, pedidoId, token, ip,
      nome: d.nome, email: d.email, cpf: d.cpf, telefone: d.telefone, cartao: d.cartao,
    });
  } catch (e) {
    return responderErroAsaas(res, e, pedidoId);
  }

  const cob = resultado.cobranca;
  const status = mapearStatus(cob.status) || 'pendente';
  db.prepare(`INSERT INTO pedidos (id, token, criado_em, atualizado_em, nome, email, telefone, cpf, segmento,
      consent_whatsapp, forma, valor_centavos, status, status_asaas, asaas_customer_id, asaas_payment_id,
      invoice_url, boleto_url, boleto_linha, pix_payload, pix_qr_base64, pix_expira_em, pago_em, verificado_em,
      ip, referrer, landing_page, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(pedidoId, token, t, t, d.nome, d.email, d.telefone, d.cpf, d.segmento,
      d.consentWhatsapp, d.forma, CFG.precoCentavos, status, cob.status || null, customerId, cob.id,
      cob.invoiceUrl || null, resultado.boleto_url || null, resultado.boleto_linha || null,
      resultado.pix_payload || null, resultado.pix_qr_base64 || null, resultado.pix_expira_em || null,
      status === 'pago' ? t : null, t,
      ip, d.referrer, d.landingPage, d.utm_source, d.utm_medium, d.utm_campaign, d.utm_content, d.utm_term);

  const pedido = buscarPorId(pedidoId);
  log(`pedido ${pedidoId} criado: ${d.forma}, ${reais(CFG.precoCentavos)}, status ${status}, cobrança ${cob.id}`);
  enviarFunil(pedido, status === 'pago' ? 'pedido_pago' : 'pedido_criado');
  return json(res, 201, { pedido: publico(pedido) });
}

function responderErroAsaas(res, e, pedidoId) {
  log(`falha na Asaas ao criar o pedido ${pedidoId}: ${e.message}`);
  if (e.status === 400 && e.descricoes && e.descricoes.length) {
    // A Asaas devolve mensagens em português prontas para o comprador
    // (ex.: "Transação não autorizada. Verifique os dados do cartão.").
    return json(res, 422, { erro: 'recusado', mensagem: e.descricoes.join(' ').slice(0, 300) });
  }
  if (e.status === 401) {
    return json(res, 503, { erro: 'pagamento_nao_configurado', mensagem: 'O pagamento está temporariamente indisponível. Tente de novo em instantes.' });
  }
  return json(res, 502, { erro: 'asaas_indisponivel', mensagem: 'Não consegui falar com o sistema de pagamento. Tente de novo em instantes.' });
}

async function consultar(req, res, token) {
  let p = buscarPorToken(token);
  if (!p) return json(res, 404, { erro: 'nao_encontrado', mensagem: 'Não achei esse pedido. Confira o link que você recebeu.' });
  // Pedido pendente: confere na Asaas de tempos em tempos, caso o webhook não tenha chegado.
  const idade = p.verificado_em ? Date.now() - Date.parse(p.verificado_em) : Infinity;
  if (p.status === 'pendente' && p.asaas_payment_id && CFG.asaasKey && idade > 15000) {
    try {
      const cob = await asaas('/payments/' + p.asaas_payment_id);
      p = aplicarStatus(p, cob.status, 'consulta');
    } catch (e) {
      log(`não consegui consultar a cobrança ${p.asaas_payment_id}: ${e.message}`);
    }
  }
  return json(res, 200, { pedido: publico(p) });
}

function download(req, res, token) {
  const p = buscarPorToken(token);
  if (!p) return json(res, 404, { erro: 'nao_encontrado', mensagem: 'Não achei esse pedido.' });
  if (p.status !== 'pago') return json(res, 403, { erro: 'nao_pago', mensagem: 'O download é liberado assim que o pagamento for confirmado.' });
  let stat;
  try { stat = fs.statSync(CFG.ebookPath); }
  catch {
    log(`ERRO: pedido ${p.id} pago, mas o arquivo do e-book não existe em ${CFG.ebookPath}`);
    return json(res, 503, { erro: 'sem_arquivo', mensagem: 'O arquivo ainda não foi publicado no servidor. Avise a Juliana respondendo a mensagem de confirmação.' });
  }
  db.prepare('UPDATE pedidos SET downloads = downloads + 1 WHERE id = ?').run(p.id);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${CFG.ebookFilename}"`,
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex',
  });
  fs.createReadStream(CFG.ebookPath).pipe(res);
  return 200;
}

async function webhook(req, res) {
  if (!CFG.webhookToken) {
    log('webhook recusado: ASAAS_WEBHOOK_TOKEN não configurado');
    return json(res, 503, { erro: 'webhook_nao_configurado' });
  }
  const recebido = String(req.headers['asaas-access-token'] || '');
  const esperado = CFG.webhookToken;
  const igual = recebido.length === esperado.length
    && crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado));
  if (!igual) {
    log('webhook recusado: token inválido, ip', ipDe(req));
    return json(res, 401, { erro: 'nao_autorizado' });
  }
  const b = await lerJson(req, 256 * 1024);
  const pagamento = b && b.payment;
  if (!pagamento || !pagamento.id) return json(res, 200, { ok: true, ignorado: 'sem pagamento' });

  const eventoId = String(b.id || crypto.createHash('sha256')
    .update(`${b.event}|${pagamento.id}|${pagamento.status}|${b.dateCreated || ''}`).digest('hex'));
  const inserido = db.prepare('INSERT OR IGNORE INTO webhooks (id, recebido_em, evento, payment_id, payload) VALUES (?, ?, ?, ?, ?)')
    .run(eventoId, agora(), b.event || null, pagamento.id, JSON.stringify(b).slice(0, 20000));
  if (!inserido.changes) return json(res, 200, { ok: true, ignorado: 'evento repetido' });

  const pedido = buscarPorPagamento(pagamento.id)
    || (pagamento.externalReference ? buscarPorId(pagamento.externalReference) : null);
  if (!pedido) {
    log(`webhook ${b.event} para cobrança ${pagamento.id} sem pedido correspondente`);
    return json(res, 200, { ok: true, ignorado: 'pedido desconhecido' });
  }
  aplicarStatus(pedido, pagamento.status, 'webhook ' + b.event);
  return json(res, 200, { ok: true });
}

// ---------- servidor ----------
const servidor = http.createServer(async (req, res) => {
  const inicio = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const rota = url.pathname;
  let status = 500;
  try {
    const pedido = rota.match(/^\/api\/pedidos\/([A-Za-z0-9_-]{16,64})(\/download)?$/);
    if (req.method === 'GET' && rota === '/api/health') status = health(res);
    else if (req.method === 'GET' && rota === '/api/config') status = config(res);
    else if (req.method === 'POST' && rota === '/api/checkout') status = await criarPedido(req, res);
    else if (req.method === 'POST' && rota === '/api/webhooks/asaas') status = await webhook(req, res);
    else if (req.method === 'GET' && pedido && pedido[2]) status = download(req, res, pedido[1]);
    else if (req.method === 'GET' && pedido) status = await consultar(req, res, pedido[1]);
    else status = json(res, 404, { erro: 'nao_encontrado' });
  } catch (e) {
    if (e.expor) {
      status = json(res, e.status || 400, { erro: e.erro || 'requisicao_invalida', mensagem: e.message, campo: e.campo || undefined });
    } else {
      log('erro inesperado em', req.method, rota, '-', e && e.stack ? e.stack : e);
      if (!res.headersSent) status = json(res, 500, { erro: 'interno', mensagem: 'Deu um erro aqui do nosso lado. Tente de novo em instantes.' });
    }
  } finally {
    if (rota !== '/api/health') log(req.method, rota, status, (Date.now() - inicio) + 'ms');
  }
});

servidor.listen(CFG.port, CFG.host, () => {
  log(`checkout ouvindo em http://${CFG.host}:${CFG.port}`);
  log(`Asaas: ${CFG.asaasEnv} (${CFG.asaasBase}) | chave: ${CFG.asaasKey ? 'ok' : 'AUSENTE - checkout desligado'} | webhook: ${CFG.webhookToken ? 'ok' : 'AUSENTE - eventos serão recusados'}`);
  log(`preço: ${reais(CFG.precoCentavos)} | e-book: ${fs.existsSync(CFG.ebookPath) ? CFG.ebookPath : 'AUSENTE em ' + CFG.ebookPath + ' - downloads vão falhar'}`);
  log(`funil: ${CFG.funnelUrl || 'não configurado'} | dados: ${CFG.dataDir}`);
});

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    log(`recebi ${sinal}, encerrando`);
    servidor.close(() => { try { db.close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
