const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENTE = fs.readFileSync(
  'gateway-overrides/token-free-gateway/src/providers/chatgpt/client.ts',
  'utf8'
);
const MANAGER = fs.readFileSync('gateway-overrides/token-free-gateway/src/browser/manager.ts', 'utf8');

// Por que este arquivo existe: para ler a imagem da conversa, cada matéria
// abria uma aba NOVA e carregava `chatgpt.com/c/<id>` do zero, e fechava
// depois. Carregamento de documento vindo de aba recém-criada, repetido a
// cada matéria, é o desenho exato do que o Cloudflare trata como robô — o
// editor passou a ver "Verify you are human" no VNC.

test('a conversa é lida numa aba só, que não é descartada', () => {
  // Uma aba nova por matéria era o gatilho. Agora: uma só, que já passou
  // pela verificação e guarda o cf_clearance.
  assert.equal(
    (CLIENTE.match(/ctx\.newPage\(\)/g) || []).length,
    1,
    'só a aba fixa pode ser criada aqui'
  );
  const i = CLIENTE.indexOf('private async abaDeLeitura(');
  assert.ok(i > 0, 'a aba fixa sumiu');
  assert.ok(
    CLIENTE.indexOf('ctx.newPage()') > i,
    'a aba passou a ser criada fora de abaDeLeitura'
  );
  // Fechar e reabrir a cada matéria é justamente o que chamava o Cloudflare.
  assert.doesNotMatch(CLIENTE, /aba\.close\(\)/);
});

test('a aba fixa é reaproveitada enquanto estiver viva', () => {
  const i = CLIENTE.indexOf('private async abaDeLeitura(');
  const trecho = CLIENTE.slice(i, i + 1200);
  assert.match(trecho, /viva && !viva\.isClosed\(\)/);
  assert.match(trecho, /return viva;/);
  // Estática: o cliente é recriado quando a sessão expira, e a aba não pode
  // morrer junto — é ela que carrega a verificação já resolvida.
  assert.match(CLIENTE, /private static abaDeLeituraFixa: Page \| null = null;/);
});

test('trocar de conversa não baixa documento', () => {
  // Dentro do app a troca é navegação do React: nenhum pedido de documento
  // sai, e é o pedido de documento que o Cloudflare desafia.
  const i = CLIENTE.indexOf('private async abrirConversa(');
  assert.ok(i > 0, 'abrirConversa sumiu');
  const trecho = CLIENTE.slice(i, i + 2000);
  assert.match(trecho, /link\.click\(\)/, 'o caminho normal é clicar no link da conversa');
  assert.match(trecho, /history\.pushState/, 'sem o link na lista, o router do próprio site');
  // O carregamento normal continua existindo, como último recurso.
  assert.match(trecho, /aba\.goto\(`https:\/\/chatgpt\.com\$\{caminho\}`/);
  assert.ok(
    trecho.indexOf('link.click()') < trecho.indexOf('aba.goto('),
    'o carregamento tem de ser o último recurso, não o primeiro'
  );
});

test('desafio do Cloudflare: para de insistir e avisa', () => {
  // Resolver a caixa é com o editor, no VNC. Insistir sozinho é o que
  // transforma um desafio em bloqueio da sessão.
  assert.match(CLIENTE, /private async temDesafio\(/);
  assert.match(CLIENTE, /challenges\.cloudflare\.com/);
  assert.match(CLIENTE, /const DESAFIO_ESPERA_MS = \d+ \* 60_000;/);
  assert.match(CLIENTE, /if \(Date\.now\(\) < ChatGPTWebClient\.desafioAte\)/);
  assert.match(CLIENTE, /ChatGPTWebClient\.desafioAte = Date\.now\(\) \+ DESAFIO_ESPERA_MS;/);
  // Sem imagem da tela a matéria continua saindo.
  const i = CLIENTE.indexOf('ChatGPTWebClient.desafioAte = Date.now()');
  assert.match(CLIENTE.slice(i, i + 700), /return \[\];/);
});

test('a aba de leitura não pode virar a aba principal do provedor', () => {
  // As duas ficam no chatgpt.com; `getPage` pega a primeira que casar com o
  // domínio. Sem a marca, elas navegariam uma por cima da outra.
  assert.match(MANAGER, /!ehAbaAuxiliar\(p\)/);
  assert.match(CLIENTE, /marcarAbaAuxiliar\(aba\);/);
  // E continua entrando na reciclagem de memória.
  assert.match(CLIENTE, /registrarPagina\(aba\);/);
});

test('marca de leitura anterior não vence a resposta nova', () => {
  // A aba agora fica aberta: o `data-viralizeai-turno` da leitura passada
  // viria antes no DOM e ganharia no `querySelector`.
  assert.match(CLIENTE, /velho\.removeAttribute\("data-viralizeai-turno"\)/);
  assert.match(CLIENTE, /el\.removeAttribute\("data-viralizeai-turno"\)/);
});
