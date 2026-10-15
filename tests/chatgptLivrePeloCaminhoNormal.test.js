const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CHAT = fs.readFileSync('src/services/materiaChatService.js', 'utf8');

test('o ChatGPT livre deixou de depender do navegador', () => {
  // Ler o DOM do chatgpt.com parou de funcionar: o log do servidor mostrou a
  // resposta pronta na tela e, para nós, turnos=0 — nem a mensagem do próprio
  // editor —, já com a aba visível e com viewport 1706x1200.
  assert.match(CHAT, /const usarNavegador = String\(process\.env\.CHATGPT_LIVRE_NAVEGADOR \|\| ''\)\.toLowerCase\(\) === 'true';/);
  assert.match(CHAT, /if \(chat\.modo === 'chatgpt' && usarNavegador\) \{/);
  // Desligado por padrão: sem a variável, nada vai para o navegador.
  assert.doesNotMatch(
    CHAT,
    /if \(chat\.modo === 'chatgpt'\) \{\s*\n\s*const conversaUrl/,
    'o desvio incondicional para o navegador não pode voltar'
  );
});

test('o caminho pelo navegador continua inteiro, só desligado', () => {
  // Nada foi apagado: dá para voltar atrás com uma variável de ambiente.
  assert.match(CHAT, /require\('\.\/chatgptLivreService'\)\.conversar\(/);
  assert.ok(fs.existsSync('src/services/chatgptLivreService.js'));
  assert.match(CHAT, /CHATGPT_LIVRE_NAVEGADOR=true/, 'o comentário diz como voltar');
});

test('o modo chatgpt cai no mesmo caminho de "Criar matéria"', () => {
  // `ehConversaLivre` já aceitava os dois modos; o desvio é que impedia.
  assert.match(CHAT, /return modo === 'livre' \|\| modo === 'chatgpt';/);
  const desvio = CHAT.indexOf("if (chat.modo === 'chatgpt' && usarNavegador)");
  const livre = CHAT.indexOf('if (conversaLivre) {');
  assert.ok(desvio > 0 && livre > desvio, 'o caminho livre vem depois do desvio');
});

test('a capa é gerada só quando nenhuma fonte trouxe foto', () => {
  // A foto real da reportagem é sempre melhor que uma ilustração.
  assert.match(
    CHAT,
    /if \(chat\.modo === 'chatgpt' && !fontesFinais\.some\(\(f\) => f\?\.imagem\)\) \{/
  );
  const capa = CHAT.indexOf('const gerada = await capaDaConversaLivre(');
  const fonteCapa = CHAT.indexOf('const fonteCapa = fontesFinais.find(');
  assert.ok(fonteCapa > 0 && capa > fonteCapa, 'tentar a foto da fonte primeiro');
});

test('a capa gerada é simbólica e identificada como IA', () => {
  const fn = CHAT.slice(CHAT.indexOf('async function capaDaConversaLivre'), CHAT.indexOf('function recortarTranscricao'));
  // Sem foto de referência, inventar uma cena com pessoas reais a partir de
  // um título seria pior que não ter capa.
  assert.match(fn, /modo: 'simbolica'/);
  assert.match(fn, /creditoImagem: 'Imagem gerada por IA'/);
  assert.match(fn, /veiculo: 'Imagem gerada por IA'/);
  // Guardada na pasta do editor, com o prefixo que o salvamento aceita.
  assert.match(fn, /prefixo: `chat_\$\{chatId\}`/);
  assert.match(fn, /storeMatterSourceImage/);
});

test('falha na capa não derruba a matéria escrita', () => {
  const fn = CHAT.slice(CHAT.indexOf('async function capaDaConversaLivre'), CHAT.indexOf('function recortarTranscricao'));
  assert.match(fn, /\} catch \(err\) \{/);
  assert.match(fn, /return null;/);
  assert.match(fn, /Escolha uma foto no painel ao salvar\./, 'e o editor fica sabendo');
  // Título vazio nem chega a pedir imagem.
  assert.match(fn, /if \(!assunto\) return null;/);
});

test('a capa gerada entra na conversa como fonte com imagem', () => {
  // É assim que o painel "Pronta para publicar" acha a capa (`f.imagem`).
  const fn = CHAT.slice(CHAT.indexOf('async function capaDaConversaLivre'), CHAT.indexOf('function recortarTranscricao'));
  assert.match(fn, /imagem: capa\.publicUrl,/);
  assert.match(CHAT, /if \(gerada\) fontesFinais\.push\(gerada\);/);
});

test('o arquivo do ChatGPT livre pelo navegador segue carregável', () => {
  // Se voltarem a ligar a variável, não pode estar quebrado.
  const livre = require('../src/services/chatgptLivreService');
  assert.equal(typeof livre.conversar, 'function');
});
