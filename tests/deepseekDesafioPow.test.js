const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENTE = fs.readFileSync(
  'gateway-overrides/token-free-gateway/src/providers/deepseek/client.ts',
  'utf8'
);
const INSTALADO = '.tools/token-free-gateway/src/providers/deepseek/client.ts';
const INSTALADOR = fs.readFileSync('scripts/install-token-free-gateway-overrides.js', 'utf8');

// Por que este arquivo existe — o log do gateway, com a aba do DeepSeek
// aberta e logada no navegador do servidor:
//
//   [DeepSeekWebClient] Creating PoW challenge for /api/v0/chat/completion...
//   [viralizeai-deepseek] resposta sem desafio:
//     {"code":40003,"msg":"Authorization Failed (invalid token)","data":null}
//
// HTTP 200, sem 401. O gateway captura o bearer UMA vez, no `webauth`, e usa
// para sempre; quando ele expira, toda matéria pedida à DeepSeek falha sem
// explicação visível.

test('o token é lido da sessão, não só do webauth', () => {
  assert.match(CLIENTE, /private async atualizarBearerDaPagina\(forcar = false\)/);
  assert.match(CLIENTE, /this\.auth\.bearer = lido\.token;/);
  // Antes de montar os headers: é neles que o bearer entra.
  const i = CLIENTE.indexOf('await this.atualizarBearerDaPagina();');
  const j = CLIENTE.indexOf('async createPowChallenge');
  assert.ok(i > j && j > 0, 'a renovação precisa acontecer dentro do createPowChallenge');
});

test('sem token no localStorage, pede um novo à própria API', () => {
  // É esta chamada que devolve token NOVO: o localStorage pode estar com um
  // já vencido, ou sequer ter a chave.
  assert.ok(CLIENTE.includes('api/v0/users/current'));
  // O caminho fixo `data.biz_data.token` saiu: ele já mudou uma vez. Agora é
  // varredura por nome de campo (coberta no teste logo abaixo).
  // Com os cookies da aba logada, que é o que o editor vê no VNC.
  assert.ok(CLIENTE.includes('credentials: "include"'));
});

test('token recusado dispara UMA nova tentativa com token renovado', () => {
  assert.ok(CLIENTE.includes('Number(codigo) === 40003'));
  assert.ok(CLIENTE.includes('await this.atualizarBearerDaPagina(true);'));
  // Uma só: insistir com credencial recusada é o caminho para o bloqueio.
  assert.match(CLIENTE, /for \(let tentativa = 0; tentativa < 2; tentativa\+\+\)/);
  assert.ok(CLIENTE.includes('tentativa === 0 && Number(codigo) === 40003'));
});

test('o desafio é procurado pelo formato, não por um caminho fixo', () => {
  // Onde ele fica na resposta já mudou uma vez.
  assert.match(CLIENTE, /private static acharDesafio\(/);
  assert.ok(CLIENTE.includes('typeof o.algorithm === "string"'));
  assert.ok(CLIENTE.includes('typeof o.salt === "string"'));
  assert.ok(CLIENTE.includes('typeof o.challenge === "string"'));
  // Os caminhos conhecidos continuam vindo primeiro, por serem mais baratos.
  const conhecido = CLIENTE.indexOf('data.data?.biz_data?.challenge');
  const varredura = CLIENTE.indexOf('DeepSeekWebClient.acharDesafio(data)');
  assert.ok(conhecido > 0 && varredura > conhecido);
});

test('a varredura não entra em recursão sem fim', () => {
  assert.ok(CLIENTE.includes('nivel > 5'));
  assert.ok(CLIENTE.includes('nivel + 1'));
});

test('o log nunca mostra o valor do token', () => {
  // Diagnóstico não pode virar vazamento de credencial: só os NOMES das
  // chaves do localStorage vão para o log.
  assert.ok(CLIENTE.includes('lido.chaves.join(", ")'));
  assert.doesNotMatch(CLIENTE, /console\.(log|warn|error)\([^)]*lido\.token/);
  assert.doesNotMatch(CLIENTE, /console\.(log|warn|error)\([^)]*this\.auth\.bearer/);
});

test('sem desafio nenhum, a resposta inteira vai para o log', () => {
  assert.ok(CLIENTE.includes('[viralizeai-deepseek] resposta sem desafio'));
  assert.ok(CLIENTE.includes('JSON.stringify(bruto).slice(0, 800)'));
  assert.ok(CLIENTE.includes('throw new Error("PoW challenge missing in response")'));
});

test('o client do DeepSeek é override inteiro, sem patch sobrando', () => {
  // Os patches antigos foram substituídos: deixá-los seria aplicar duas vezes.
  assert.ok(INSTALADOR.includes("'src/providers/deepseek/client.ts',"));
  assert.doesNotMatch(INSTALADOR, /marca: 'atualizarBearerDaPagina'/);
  assert.doesNotMatch(INSTALADOR, /marca: 'viralizeai-deepseek'/);
});

test('o override chegou ao gateway instalado', () => {
  if (!fs.existsSync(INSTALADO)) return; // gateway não instalado nesta máquina
  assert.equal(fs.readFileSync(INSTALADO, 'utf8'), CLIENTE, 'rode npm run gateway:sync');
});

test('a varredura acha o desafio onde quer que ele esteja', () => {
  // Mesma lógica do client, exercitada sobre formatos plausíveis.
  const achar = (alvo, nivel = 0) => {
    if (!alvo || typeof alvo !== 'object' || nivel > 5) return null;
    if (Array.isArray(alvo)) {
      for (const item of alvo) {
        const achado = achar(item, nivel + 1);
        if (achado) return achado;
      }
      return null;
    }
    if (
      typeof alvo.algorithm === 'string' &&
      typeof alvo.salt === 'string' &&
      typeof alvo.challenge === 'string'
    ) {
      return alvo;
    }
    for (const valor of Object.values(alvo)) {
      const achado = achar(valor, nivel + 1);
      if (achado) return achado;
    }
    return null;
  };

  const desafio = {
    algorithm: 'DeepSeekHashV1',
    challenge: 'abc',
    salt: 'xyz',
    difficulty: 144000,
    signature: 's',
  };
  assert.deepEqual(achar({ data: { biz_data: { challenge: desafio } } }), desafio);
  assert.deepEqual(achar({ data: { biz_data: { pow: { challenge: desafio } } } }), desafio);
  assert.deepEqual(achar({ result: [{ pow_challenge: desafio }] }), desafio);
  // O envelope de erro real não pode virar desafio falso.
  assert.equal(achar({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null }), null);
});

test('renovação forçada pula o localStorage e vai direto à API', () => {
  // O furo que isto fecha: o token vencido ESTÁ no localStorage (foi de lá
  // que o webauth o tirou). Reler o localStorage depois de um 40003 devolve
  // o mesmo token recusado, e a segunda tentativa falhava igual. Só a API,
  // com os cookies da sessão, emite um token novo.
  assert.ok(CLIENTE.includes('!ignorarGuardado && i < store.length'));
  assert.ok(CLIENTE.includes('}, forcar)'), 'o sinalizador precisa chegar dentro da página');
  // Mesmo pulando a busca, os nomes das chaves continuam indo para o log.
  assert.ok(CLIENTE.includes('if (ignorarGuardado) {'));
});

test('renovação que devolve o mesmo token aparece no log', () => {
  // Sem isso ela some em silêncio e a falha seguinte fica sem explicação —
  // foi exatamente o que aconteceu com a primeira versão deste conserto.
  assert.ok(CLIENTE.includes('a sessao devolveu o MESMO token'));
  assert.ok(CLIENTE.includes('} else if (forcar) {'));
});

test('o token é procurado em qualquer campo da resposta da API', () => {
  // `data.biz_data.token` é um caminho fixo e já mudou uma vez.
  const i = CLIENTE.indexOf('users/current');
  const trecho = CLIENTE.slice(i - 200, i + 1800);
  assert.match(trecho, /\/token\/i\.test\(chave\)/);
  assert.match(trecho, /nivel > 5/, 'a varredura precisa de fundo');
});

test('o corpo registrado da API vai censurado', () => {
  // Diagnóstico não pode virar vazamento: qualquer cadeia longa (que pode
  // ser credencial) sai do log.
  assert.ok(CLIENTE.includes('.replace(/[A-Za-z0-9._-]{20,}/g, "<...>")'));
  assert.ok(CLIENTE.includes('corpo: ${lido.corpo || "-"}'));
});

test('o token e capturado das requisicoes da propria pagina', () => {
  // A descoberta que fechou o caso, lida no repositorio do gateway: o app do
  // DeepSeek NAO guarda o token no localStorage. Ele fica na memoria do app e
  // entra por interceptor em cada chamada a /api/v0/. O proprio `webauth` do
  // gateway o captura assim — espiando as requisicoes da pagina.
  assert.ok(CLIENTE.includes('page.on("request"'));
  assert.ok(CLIENTE.includes('req.url().includes("/api/v0/")'));
  assert.ok(CLIENTE.includes('auth.slice(7)'));
  // E e a PRIMEIRA fonte consultada: e onde o token realmente esta.
  const captura = CLIENTE.indexOf('this.bearerCapturado && this.bearerCapturado !== this.auth.bearer');
  const storage = CLIENTE.indexOf('const store = globalThis.localStorage;');
  assert.ok(captura > 0 && storage > captura, 'a captura precisa vir antes do localStorage');
});

test('aba parada e provocada para ter o que capturar', () => {
  // Sem requisicao nenhuma nao ha cabecalho a ler. Recarregar faz o app
  // refazer as chamadas de /api/v0/ com o token vivo.
  assert.ok(CLIENTE.includes('private async provocarRequisicao('));
  assert.ok(CLIENTE.includes('page.reload('));
  // So depois de um token recusado: recarregar a aba e visivel no VNC e nao
  // pode acontecer a toa.
  assert.ok(CLIENTE.includes('if (forcar) await this.provocarRequisicao(page, this.auth.bearer);'));
});

test('o ouvinte nao e registrado duas vezes na mesma aba', () => {
  // Um ouvinte por pedido vazaria memoria no processo do gateway.
  assert.ok(CLIENTE.includes('this.paginasEscutadas.has(page)'));
  assert.ok(CLIENTE.includes('new WeakSet<object>()'));
});

test('o token capturado nunca vai para o log', () => {
  assert.doesNotMatch(CLIENTE, /console\.(log|warn|error)\([^)]*bearerCapturado/);
});

test('forcado recarrega mesmo ja tendo token capturado', () => {
  // O furo da rodada anterior: `!this.bearerCapturado` impedia a recarga
  // sempre que houvesse um token capturado — e havia, era justamente o que
  // acabara de ser recusado. A renovacao nunca acontecia.
  assert.ok(CLIENTE.includes('this.bearerCapturado = "";'), 'o recusado precisa ser descartado');
  assert.ok(CLIENTE.includes('this.bearerCapturado !== recusado'));
});

test('a espera cobre o tempo de o app hidratar', () => {
  // Com 10s a espera acabava antes e o token chegava depois de termos
  // desistido: no log, "token capturado" aparecia DEPOIS de "sem desafio".
  assert.ok(CLIENTE.includes('for (let i = 0; i < 60; i++)'));
  assert.ok(CLIENTE.includes('nao emitiu requisicao autenticada em 30s'));
});

test('uma renovacao por vez, compartilhada', () => {
  // A Biblioteca dispara dezenas de pedidos em paralelo. Sem isto cada um
  // recarregaria a aba, que nunca chegaria a emitir a requisicao esperada.
  assert.ok(CLIENTE.includes('private renovando: Promise<void> | null = null;'));
  assert.ok(CLIENTE.includes('await this.renovando.catch(() => {});'));
  assert.ok(CLIENTE.includes('this.renovando = null;'));
});
