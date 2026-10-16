const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SCRIPT = fs.readFileSync('scripts/install-token-free-gateway-overrides.js', 'utf8');
const TIPOS = fs.readFileSync('gateway-overrides/token-free-gateway/src/providers/types.ts', 'utf8');
const COMPLETIONS = fs.readFileSync(
  'gateway-overrides/token-free-gateway/src/openai/chat-completions.ts',
  'utf8'
);
const CLIENTE = fs.readFileSync(
  'gateway-overrides/token-free-gateway/src/providers/chatgpt/client.ts',
  'utf8'
);
const SERVICO = fs.readFileSync('src/services/tokenFreeGatewayService.js', 'utf8');
const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');

// A corrente inteira: a imagem sai do stream do ChatGPT e chega na capa.
// Cada elo abaixo já quebrou sozinho uma vez, e um elo partido não dá erro
// nenhum — só devolve matéria sem foto.

test('o parser recolhe TODAS as partes, não só a primeira', () => {
  // A causa original: o parser lia `parts[0]` e só aproveitava se fosse texto.
  // Quando vinha foto, a parte era um objeto sem `.text` e sumia ali dentro.
  assert.ok(
    SCRIPT.includes(String.raw`procurar: '\t\t\tconst rawPart = data.message?.content?.parts?.[0];'`),
    'o trecho procurado precisa casar byte a byte com o arquivo do gateway'
  );
  assert.match(SCRIPT, /for \(const parte of data\.message\?\.content\?\.parts \?\? \[\]\) \{/);
  assert.match(SCRIPT, /if \(typeof p\.text === "string"\) continue;/);
});

test('o parser varre onde o ChatGPT costuma pôr imagem', () => {
  // Ele muda isso sem avisar; varrer os campos conhecidos custa pouco.
  for (const campo of ['asset_pointer', 'url', 'image_url', 'src', 'thumbnail_url']) {
    assert.ok(SCRIPT.includes(`"${campo}"`), `campo ${campo} não é varrido`);
  }
  for (const grupo of ['images', 'image_results', 'content_references', 'parts']) {
    assert.ok(SCRIPT.includes(`"${grupo}"`), `grupo ${grupo} não é varrido`);
  }
  // Formato novo some em silêncio sem isto.
  assert.match(SCRIPT, /\[viralizeai-imagem\] parte nao-texto:/);
});

test('ponteiro interno é resolvido na página logada', () => {
  // A imagem que o ChatGPT GERA não vem como URL: vem como
  // `file-service://file-…`, que só a sessão autenticada troca por um link.
  // O client.ts do ChatGPT agora é override inteiro (não mais patch).
  assert.ok(SCRIPT.includes("'src/providers/chatgpt/client.ts'"), 'client do ChatGPT fora da lista de overrides');
  assert.match(CLIENTE, /resultado\.imagens = await this\.resolverImagens\(resultado\.imagens\)/);
  assert.ok(CLIENTE.includes('backend-api/files/'), 'falta a chamada que resolve o ponteiro');
  assert.ok(CLIENTE.includes('d.download_url'), 'a URL assinada não é aproveitada');
  // URL pública não precisa passar por lá.
  assert.ok(CLIENTE.includes('v.startsWith("https://")'));
});

test('a conversa do ChatGPT continua na mensagem seguinte', () => {
  // O gateway devolve onde a resposta ficou; o chat guarda e manda de volta.
  assert.match(COMPLETIONS, /writeExtra\(\{ conversa: result\.conversa/);
  assert.match(SERVICO, /entregarConversa\(aoReceberConversa, evento\)/);
  assert.match(CHAT, /fioAnterior \|\| `viralizeai:chatgpt:user:/);
  // Continuando a conversa real, o histórico não é reenviado.
  assert.match(CHAT, /historico: fioAnterior \? \[\] : historicoLivre/);
});

test('o campo atravessa o gateway até a resposta HTTP', () => {
  assert.match(TIPOS, /imagens\?: string\[\];/, 'StreamResult não carrega as imagens');
  assert.match(COMPLETIONS, /result\.imagens\?\.length \? \{ imagens: result\.imagens \} : \{\}/);
  // No streaming a foto vai num evento solto, DEPOIS do "stop", para não
  // entrar no meio do texto que o cliente está montando.
  assert.match(COMPLETIONS, /w\.writeExtra\(\{ imagens: result\.imagens \}\)/);
  const semFerramentas = COMPLETIONS.slice(
    COMPLETIONS.indexOf('async function streamWithoutTools('),
    COMPLETIONS.indexOf('async function streamWithTools(')
  );
  assert.ok(
    semFerramentas.indexOf('finish_reason: "stop"') < semFerramentas.indexOf('writeExtra'),
    'o evento das imagens tem de vir depois do stop'
  );
});

test('o cliente entrega as imagens sem mudar o retorno', () => {
  // `chatCompletion`/`chatCompletionStream` devolvem string para dezenas de
  // chamadores: a foto sai por um callback, não trocando o tipo do retorno.
  assert.match(SERVICO, /function entregarImagens\(callback, valor\)/);
  assert.match(SERVICO, /entregarImagens\(aoReceberImagens, data\?\.imagens\)/);
  assert.match(SERVICO, /entregarImagens\(aoReceberImagens, evento\?\.imagens\)/);
  // Erro de quem consome não pode derrubar a geração da matéria.
  assert.match(SERVICO, /imagens da resposta ignoradas/);
});

test('a imagem da conversa é a PRIMEIRA opção de capa', () => {
  // O editor viu a foto aparecer no ChatGPT; é essa que ele espera na
  // "Imagem destacada" — não uma do link citado nem uma gerada aqui.
  assert.match(CHAT, /async function capaGeradaNaConversa\(/);
  assert.match(CHAT, /aoReceberImagens: \(urls\) => \{/);
  const daConversa = CHAT.indexOf('const doChat = await capaGeradaNaConversa(');
  const doLink = CHAT.indexOf('const linkCitado = primeiroLinkDeFonte(');
  const gerada = CHAT.indexOf('const gerada = await capaDaConversaLivre(');
  assert.ok(daConversa > 0 && doLink > 0 && gerada > 0, 'algum caminho de capa desapareceu');
  assert.ok(daConversa < doLink, 'a imagem do ChatGPT tem de vir antes da foto do link');
  assert.ok(doLink < gerada, 'gerar capa continua sendo o último recurso');
});

test('a URL assinada é baixada na hora', () => {
  // O link que o ChatGPT devolve expira; guardar a URL no rascunho daria
  // capa quebrada horas depois.
  const i = CHAT.indexOf('async function capaGeradaNaConversa(');
  const trecho = CHAT.slice(i, i + 1800);
  assert.match(trecho, /responseType: 'arraybuffer'/);
  assert.match(trecho, /storeMatterSourceImage\(/);
  assert.match(trecho, /maxContentLength/);
});

test('o patch foi aplicado no gateway, uma vez só', () => {
  const alvo = '.tools/token-free-gateway/src/providers/chatgpt/stream.ts';
  if (!fs.existsSync(alvo)) return; // gateway não instalado nesta máquina
  const codigo = fs.readFileSync(alvo, 'utf8');
  assert.equal(
    (codigo.match(/for \(const parte of data\.message\?\.content\?\.parts/g) || []).length,
    1,
    'patch ausente ou aplicado mais de uma vez'
  );
  assert.ok(codigo.includes('guardarImagem'), 'o coletor não está no arquivo instalado');
  assert.ok(codigo.includes(', imagens };'), 'o parser não devolve as imagens');
});

test('a versão do gateway continua fixada', () => {
  // Patch casa com trecho exato; em outra versão ele não aplica e avisa.
  assert.match(SCRIPT, /const UPSTREAM_VERSION = '[\d.]+';/);
});
