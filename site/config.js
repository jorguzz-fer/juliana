/* ---------------------------------------------------------------
   Configuração do site — editar aqui, sem mexer no index.html.

   FUNNEL_API_URL
     URL base da API que recebe os leads. O site faz POST em
     {FUNNEL_API_URL}/leads com o JSON do formulário.

     Ex.: "https://api.maternidadesemculpa.com.br"

     ATENÇÃO: enquanto estiver vazio, o site roda em MODO
     DEMONSTRAÇÃO — o formulário mostra a tela de sucesso mas
     o lead NÃO é salvo em lugar nenhum.

   Este arquivo é servido com no-cache (ver nginx.conf), então a
   alteração vale no próximo carregamento, sem rebuild.
---------------------------------------------------------------- */
window.SITE_CONFIG = {
  FUNNEL_API_URL: ""
};
