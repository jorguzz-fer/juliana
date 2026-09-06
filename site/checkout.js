/* ------------------------------------------------------------------
   Checkout do e-book. Usado pela landing (index.html, formulário
   #checkout) e pela página do pedido (pedido.html, área #pedido).
   Fala com a API em /api (checkout/server.js). Sem dependências.
------------------------------------------------------------------ */
(function () {
  'use strict';
  var API = '/api';

  // ---------- utilidades ----------
  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function evento(nome, dados) {
    try { window.dataLayer = window.dataLayer || []; window.dataLayer.push(Object.assign({ event: nome }, dados || {})); } catch (e) {}
  }
  function cpfValido(cpf) {
    cpf = digitos(cpf);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    for (var t = 9; t < 11; t++) {
      var soma = 0;
      for (var i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
      if (((soma * 10) % 11) % 10 !== Number(cpf[t])) return false;
    }
    return true;
  }
  function luhn(n) {
    n = digitos(n);
    if (n.length < 13 || n.length > 19) return false;
    var soma = 0, alterna = false;
    for (var i = n.length - 1; i >= 0; i--) {
      var d = Number(n[i]);
      if (alterna) { d *= 2; if (d > 9) d -= 9; }
      soma += d; alterna = !alterna;
    }
    return soma % 10 === 0;
  }
  function utms() {
    var CH = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'], o = {};
    try {
      var qs = new URLSearchParams(location.search), g = {};
      try { g = JSON.parse(sessionStorage.getItem('utm') || '{}'); } catch (e) {}
      CH.forEach(function (k) { o[k] = qs.get(k) || g[k] || null; });
      try { sessionStorage.setItem('utm', JSON.stringify(o)); } catch (e) {}
    } catch (e) {}
    return o;
  }

  // ---------- máscaras ----------
  var M = {
    telefone: function (v) {
      var d = digitos(v).slice(0, 11), o = '';
      if (d.length) o = '(' + d.slice(0, 2);
      if (d.length >= 3) o += ') ' + d.slice(2, 7);
      if (d.length >= 8) o += '-' + d.slice(7, 11);
      return o;
    },
    cpf: function (v) {
      return digitos(v).slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    },
    cartao: function (v) { return digitos(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 '); },
    validade: function (v) { var d = digitos(v).slice(0, 4); return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; },
    cep: function (v) { var d = digitos(v).slice(0, 8); return d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d; }
  };
  function mascara(el, fn) {
    if (!el) return;
    el.addEventListener('input', function () { el.value = fn(el.value); });
  }

  // ---------- copiar para a área de transferência ----------
  function copiar(texto, botao) {
    var rotulo = botao.textContent;
    function ok() { botao.textContent = 'Copiado ✓'; setTimeout(function () { botao.textContent = rotulo; }, 2200); }
    function manual() {
      var ta = document.createElement('textarea');
      ta.value = texto; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(texto).then(ok, manual);
    else manual();
  }

  // ---------- telas do pedido ----------
  function render(p, el) {
    var caminho = '/pedido/' + esc(p.token);
    var linkPedido = '<a href="' + caminho + '">' + esc(location.host) + caminho + '</a>';
    var html;
    if (p.status === 'pago') {
      html = '<div class="pg pg-ok"><div class="marca" aria-hidden="true">✳</div>' +
        '<h3>Pronto. Seu manual está liberado.</h3>' +
        '<p>Baixe agora. Guarde o link do seu pedido para baixar de novo quando quiser, em qualquer aparelho.</p>' +
        '<a class="btn" href="' + esc(p.download_url) + '">Baixar o manual (PDF)</a>' +
        '<p class="mini">Link do pedido: ' + linkPedido + '</p></div>';
    } else if (p.status === 'pendente' && p.forma === 'PIX' && p.pix) {
      html = '<div class="pg"><h3>Pague com Pix</h3>' +
        '<p>Abra o app do seu banco, escolha pagar com Pix e leia o QR code. Ou copie o código e cole na opção “Pix copia e cola”.</p>' +
        '<div class="qr"><img src="data:image/png;base64,' + esc(p.pix.qr_base64) + '" width="220" height="220" alt="QR code do Pix"></div>' +
        '<div class="copia"><input readonly value="' + esc(p.pix.payload) + '" aria-label="Código Pix copia e cola">' +
        '<button type="button" class="copiar">Copiar código</button></div>' +
        '<p class="status"><span class="spin" aria-hidden="true"></span>Aguardando o pagamento. Assim que cair, esta tela libera o download sozinha.</p>' +
        (p.pix.expira_em ? '<p class="mini">Código válido até ' + esc(p.pix.expira_em) + '.</p>' : '') +
        '<p class="mini">Se fechar esta página, acompanhe em ' + linkPedido + '</p></div>';
    } else if (p.status === 'pendente' && p.forma === 'BOLETO' && p.boleto) {
      html = '<div class="pg"><h3>Boleto gerado</h3>' +
        '<p>Pague no app do seu banco ou em qualquer lotérica. O download libera assim que o banco confirmar, normalmente em até 2 dias úteis.</p>' +
        '<a class="btn" href="' + esc(p.boleto.url) + '" target="_blank" rel="noopener">Abrir o boleto (PDF)</a>' +
        (p.boleto.linha ? '<div class="copia"><input readonly value="' + esc(p.boleto.linha) + '" aria-label="Linha digitável do boleto">' +
          '<button type="button" class="copiar">Copiar linha digitável</button></div>' : '') +
        '<p class="mini">Guarde o link do seu pedido para baixar o manual quando o pagamento for confirmado: ' + linkPedido + '</p></div>';
    } else if (p.status === 'pendente') {
      html = '<div class="pg"><h3>Pagamento em análise</h3>' +
        '<p>A operadora do cartão está analisando o pagamento. Costuma levar alguns minutos. Esta tela atualiza sozinha.</p>' +
        '<p class="status"><span class="spin" aria-hidden="true"></span>Aguardando confirmação.</p>' +
        '<p class="mini">Se fechar esta página, acompanhe em ' + linkPedido + '</p></div>';
    } else if (p.status === 'vencido') {
      html = '<div class="pg"><h3>Este pagamento venceu</h3>' +
        '<p>O prazo passou sem o pagamento ser identificado. Para comprar, é só fazer um novo pedido em <a href="/#comprar">maternidadesemculpa.com.br</a>.</p></div>';
    } else if (p.status === 'estornado') {
      html = '<div class="pg"><h3>Pagamento estornado</h3>' +
        '<p>O valor foi devolvido e o download foi desativado. Dúvidas? Responda a mensagem de confirmação que você recebeu.</p></div>';
    } else {
      html = '<div class="pg"><h3>Pedido ' + esc(p.status) + '</h3><p>Se precisar de ajuda, responda a mensagem de confirmação que você recebeu.</p></div>';
    }
    el.innerHTML = html;
    var botao = $('.copiar', el);
    if (botao) botao.addEventListener('click', function () { copiar($('.copia input', el).value, botao); });
  }

  // Consulta o pedido a cada poucos segundos enquanto estiver pendente.
  var timer = null;
  function acompanhar(token, el, aoPagar) {
    clearTimeout(timer);
    var inicio = Date.now();
    function tick() {
      if (document.hidden) { timer = setTimeout(tick, 4000); return; }
      fetch(API + '/pedidos/' + encodeURIComponent(token), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.pedido && d.pedido.status !== 'pendente') {
            render(d.pedido, el);
            if (d.pedido.status === 'pago' && aoPagar) aoPagar(d.pedido);
            return;
          }
          if (Date.now() - inicio < 40 * 60 * 1000) timer = setTimeout(tick, 4000);
        })
        .catch(function () { timer = setTimeout(tick, 8000); });
    }
    timer = setTimeout(tick, 4000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { clearTimeout(timer); tick(); } });
  }

  // ---------- formulário da landing ----------
  function iniciarFormulario(form) {
    var erro = $('#erro', form), btn = $('#pagar', form), corpo = $('.form-corpo', form), pagto = $('#pagto', form);
    var camposCartao = $('.cartao-campos', form), aviso = $('#aviso-config', form);
    var precoTexto = ($('[data-preco]') || {}).textContent || 'R$ 19,90';

    mascara(form.telefone, M.telefone);
    mascara(form.cpf, M.cpf);
    mascara(form.cartao_numero, M.cartao);
    mascara(form.cartao_validade, M.validade);
    mascara(form.cartao_cep, M.cep);

    function formaAtual() { var r = form.querySelector('input[name=forma]:checked'); return r ? r.value : 'PIX'; }
    function atualizarForma() {
      var f = formaAtual();
      camposCartao.hidden = f !== 'CREDIT_CARD';
      btn.textContent = (f === 'BOLETO' ? 'Gerar boleto de ' : f === 'CREDIT_CARD' ? 'Pagar ' : 'Pagar com Pix ') + precoTexto;
    }
    Array.prototype.forEach.call(form.querySelectorAll('input[name=forma]'), function (r) { r.addEventListener('change', atualizarForma); });

    // Preço vem da API (o HTML tem o valor de fallback).
    fetch(API + '/config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (c) {
      if (c && c.preco_texto) {
        precoTexto = c.preco_texto;
        Array.prototype.forEach.call(document.querySelectorAll('[data-preco]'), function (el) { el.textContent = c.preco_texto; });
        atualizarForma();
      }
      if (c && c.ativo === false && aviso) aviso.hidden = false;
    }).catch(function () {});

    var iniciou = false;
    form.addEventListener('focusin', function () { if (!iniciou) { iniciou = true; evento('checkout_start'); } });

    function falhar(msg, campo) {
      erro.textContent = msg; erro.classList.add('on');
      btn.disabled = false; atualizarForma();
      if (campo && campo.focus) { campo.focus(); if (campo.scrollIntoView) campo.scrollIntoView({ block: 'center' }); }
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      erro.classList.remove('on');
      if (form.empresa.value) return; // honeypot

      var forma = formaAtual();
      var dados = Object.assign({
        nome: form.nome.value.trim(),
        email: form.email.value.trim(),
        telefone: digitos(form.telefone.value),
        cpf: digitos(form.cpf.value),
        forma: forma,
        segmento: (form.querySelector('input[name=segmento]:checked') || {}).value || null,
        consent_politica: form.consent_politica.checked,
        consent_whatsapp: form.consent_whatsapp.checked,
        referrer: document.referrer || null,
        landing_page: location.href
      }, utms());

      if (dados.nome.length < 2) return falhar('Escreve seu nome pra eu saber como te chamar.', form.nome);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(dados.email)) return falhar('Confere o e-mail: é nele que chega o comprovante.', form.email);
      if (dados.telefone.length < 10) return falhar('Confere o WhatsApp, com DDD.', form.telefone);
      if (!cpfValido(dados.cpf)) return falhar('Confere o CPF. Ele é obrigatório para o pagamento.', form.cpf);
      if (forma === 'CREDIT_CARD') {
        var val = digitos(form.cartao_validade.value);
        dados.cartao = {
          numero: digitos(form.cartao_numero.value), nome: form.cartao_nome.value.trim(),
          mes: val.slice(0, 2), ano: val.slice(2), cvv: digitos(form.cartao_cvv.value),
          cep: digitos(form.cartao_cep.value), numero_endereco: form.cartao_endereco.value.trim()
        };
        if (!luhn(dados.cartao.numero)) return falhar('Confere o número do cartão.', form.cartao_numero);
        if (dados.cartao.nome.length < 2) return falhar('Escreve o nome como está impresso no cartão.', form.cartao_nome);
        if (!(Number(dados.cartao.mes) >= 1 && Number(dados.cartao.mes) <= 12 && dados.cartao.ano.length === 2)) return falhar('Confere a validade, no formato MM/AA.', form.cartao_validade);
        if (dados.cartao.cvv.length < 3) return falhar('Confere o código de segurança (CVV).', form.cartao_cvv);
        if (dados.cartao.cep.length !== 8) return falhar('Confere o CEP do endereço da fatura.', form.cartao_cep);
        if (!dados.cartao.numero_endereco) return falhar('Falta o número do endereço da fatura.', form.cartao_endereco);
      }
      if (!dados.consent_politica) return falhar('Preciso que você aceite a Política de Privacidade para continuar.', form.consent_politica);

      btn.disabled = true;
      btn.textContent = forma === 'PIX' ? 'Gerando o Pix...' : forma === 'BOLETO' ? 'Gerando o boleto...' : 'Processando o pagamento...';
      evento('checkout_submit', { forma: forma });

      fetch(API + '/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok || !x.d.pedido) {
            var campo = x.d && x.d.campo ? form.elements[x.d.campo] : null;
            return falhar((x.d && x.d.mensagem) || 'Não consegui concluir. Tenta de novo em instantes.', campo);
          }
          var p = x.d.pedido;
          corpo.hidden = true; pagto.hidden = false;
          render(p, pagto);
          pagto.scrollIntoView({ block: 'start', behavior: 'smooth' });
          if (p.status === 'pago') evento('purchase', { forma: p.forma, valor: p.valor_centavos / 100, pedido: p.id });
          else {
            evento('purchase_pending', { forma: p.forma, pedido: p.id });
            acompanhar(p.token, pagto, function (pg) { evento('purchase', { forma: pg.forma, valor: pg.valor_centavos / 100, pedido: pg.id }); });
          }
        })
        .catch(function () { falhar('Não consegui falar com o servidor. Confere a conexão e tenta de novo.'); });
    });

    atualizarForma();
  }

  // ---------- página do pedido ----------
  function iniciarPedido(el) {
    var token = (location.pathname.match(/^\/pedido\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!token) {
      el.innerHTML = '<div class="pg"><h3>Pedido não encontrado</h3><p>O link parece incompleto. Confira o endereço que você recebeu.</p></div>';
      return;
    }
    fetch(API + '/pedidos/' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || !x.d.pedido) {
          el.innerHTML = '<div class="pg"><h3>Pedido não encontrado</h3><p>' + esc((x.d && x.d.mensagem) || 'Confira o link que você recebeu.') + '</p></div>';
          return;
        }
        render(x.d.pedido, el);
        if (x.d.pedido.status === 'pendente') acompanhar(token, el);
      })
      .catch(function () {
        el.innerHTML = '<div class="pg"><h3>Não consegui carregar o pedido</h3><p>Confere a conexão e recarrega a página.</p></div>';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = $('#checkout'); if (form) iniciarFormulario(form);
    var pedido = $('#pedido'); if (pedido) iniciarPedido(pedido);
  });
})();
