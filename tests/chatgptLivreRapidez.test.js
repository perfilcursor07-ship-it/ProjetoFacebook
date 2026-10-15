const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const LIVRE = fs.readFileSync('src/services/chatgptLivreService.js', 'utf8');
const IMAGEM = fs.readFileSync('src/services/chatgptImageService.js', 'utf8');

test('a checagem de sessão saiu do caminho feliz', () => {
  // Era um fetch à API da OpenAI DENTRO da página, antes de toda mensagem —
  // um ida-e-volta de rede na frente até das que iam dar certo.
  const trecho = LIVRE.slice(LIVRE.indexOf('async function conversar'));
  const editor = trecho.indexOf('chatgpt.editorVisivel(page, 12_000)');
  const sessao = trecho.indexOf('chatgpt.garantirSessaoChatgpt');
  assert.ok(editor > 0, 'a espera rápida pelo editor precisa existir');
  assert.ok(sessao > editor, 'a sessão só é conferida DEPOIS, se o editor não vier');
  assert.match(trecho.slice(0, 2000), /if \(!input\) \{/);
});

test('a recuperação continua inteira quando o editor não aparece', () => {
  // Sem editor: confere a sessão (que reinjeta cookie e recarrega) e espera
  // de novo, com o prazo cheio. Nada disso pode ter sumido.
  const trecho = LIVRE.slice(LIVRE.indexOf('async function conversar'));
  assert.match(trecho.slice(0, 2000), /await chatgpt\.garantirSessaoChatgpt\(page, context, credenciais\);\s*\n\s*input = await chatgpt\.aguardarEditor\(page\);/);
  // E o aguardarEditor segue checando sessão e recarregando por conta dele.
  const ag = IMAGEM.slice(IMAGEM.indexOf('async function aguardarEditor'));
  assert.match(ag.slice(0, 900), /verificarSessaoChatgpt\(page\)/);
  assert.match(ag.slice(0, 900), /page\.reload/);
  assert.match(ag.slice(0, 900), /A sessão do ChatGPT expirou/);
});

test('editorVisivel não lança, não recarrega e devolve null quando não acha', () => {
  const fn = IMAGEM.slice(IMAGEM.indexOf('async function editorVisivel'), IMAGEM.indexOf('async function aguardarEditor'));
  assert.match(fn, /\.then\(\(\) => true, \(\) => false\)/, 'não pode lançar');
  assert.match(fn, /return apareceu \? input : null;/);
  assert.doesNotMatch(fn, /reload|verificarSessao/, 'recuperação é do aguardarEditor');
});

test('os dois usam o mesmo seletor de caixa de mensagem', () => {
  // Dois seletores divergentes dariam "editor não apareceu" num e sucesso no
  // outro, e a recuperação nunca casaria com o problema.
  assert.match(IMAGEM, /const SELETOR_EDITOR = '#prompt-textarea:visible, textarea:visible, \[contenteditable="true"\]:visible';/);
  const usos = (IMAGEM.match(/page\.locator\(SELETOR_EDITOR\)/g) || []).length;
  assert.equal(usos, 2, 'editorVisivel e aguardarEditor');
});

test('a fila é solta assim que o editor fica pronto', () => {
  // Ela existe para não abrir várias abas de uma vez. Depois do editor,
  // cada pedido trabalha na sua própria aba e não disputa nada — segurar a
  // fila até o envio fazia o segundo editor esperar o primeiro por inteiro.
  const trecho = LIVRE.slice(LIVRE.indexOf('async function conversar'));
  const editor = trecho.indexOf("relogio.marcar('editor')");
  const solta = trecho.indexOf('liberar();');
  const envio = trecho.indexOf('await input.fill(');
  assert.ok(editor < solta && solta < envio, 'soltar entre o editor e o envio');
  // E o finally continua soltando, para erro no meio não travar a fila.
  assert.match(trecho, /\} finally \{\s*\n\s*liberar\(\);/);
});

test('cada etapa é cronometrada e vai para o log', () => {
  // "Está demorando" não dá para consertar sem saber se o tempo é da aba, do
  // carregamento, da sessão ou do ChatGPT pensando.
  assert.match(LIVRE, /function cronometro\(\)/);
  for (const etapa of ['aba', 'abrir', 'editor', 'envio', 'resposta']) {
    assert.ok(LIVRE.includes(`relogio.marcar('${etapa}')`), `falta medir ${etapa}`);
  }
  assert.match(LIVRE, /console\.log\(`\[chatgpt-livre\] \$\{continuar \? 'continuou' : 'nova conversa'\} \| \$\{relogio\.resumo\(\)\}`\)/);
});

test('o cronômetro mede intervalos, não o total acumulado', () => {
  // Marcar sempre contra o início daria números crescentes e inúteis.
  const fn = LIVRE.slice(LIVRE.indexOf('function cronometro()'), LIVRE.indexOf('// Versões do ChatGPT'));
  assert.match(fn, /ultimo = agora;/, 'o relógio reinicia a cada marca');
  assert.match(fn, /\(\(agora - ultimo\) \/ 1000\)\.toFixed\(1\)/);
});

test('continuar a conversa segue indo direto para a URL dela', () => {
  // É o que evita recarregar o chatgpt.com do zero a cada mensagem.
  assert.match(LIVRE, /await page\.goto\(continuar \? conversaUrl : 'https:\/\/chatgpt\.com\/'/);
  assert.match(LIVRE, /const URL_CONVERSA = \/\^https:\\\/\\\/chatgpt\\\.com\\\/c\\\//);
});
