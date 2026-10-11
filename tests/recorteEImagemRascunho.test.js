const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const EDITOR_JS = fs.readFileSync('public/js/materia-ia-editar.js', 'utf8');
const EDITOR_EJS = fs.readFileSync('public/views/materia-ia-editar.ejs', 'utf8');
const ROTA = fs.readFileSync('src/routes/editorialMatters.js', 'utf8');
const CHAT_JS = fs.readFileSync('public/js/materia-chat.js', 'utf8');
const CHAT_SRV = fs.readFileSync('src/services/materiaChatService.js', 'utf8');

// ── 1. Recortar foto / gerar imagem com IA no rascunho ──────────────────────

test('o recorte só manda sourceUrl quando a imagem é nova, gerada pela IA', () => {
  // Era o defeito: o editor mandava a foto de origem da matéria (quase sempre
  // uma URL remota) no campo sourceUrl, e a rota devolvia
  // 400 "A imagem temporária informada não pertence a esta matéria".
  assert.match(EDITOR_JS, /let cropSourceGerada = false;/);
  assert.match(EDITOR_JS, /sourceUrl: cropSourceGerada \? cropSourceUrl : null,/);
  assert.doesNotMatch(
    EDITOR_JS,
    /sourceUrl: cropSourceUrl \|\| null,/,
    'mandar a foto atual aqui volta a quebrar o recorte'
  );
});

test('abrir o recorte zera a marca; a imagem da IA a liga', () => {
  const abrir = EDITOR_JS.slice(EDITOR_JS.indexOf('function openCropModal'));
  assert.match(abrir.slice(0, 600), /cropSourceGerada = false;/);
  const gerada = EDITOR_JS.slice(EDITOR_JS.indexOf('function showChatgptImage'));
  assert.match(gerada.slice(0, 600), /cropSourceGerada = true;/);
});

test('a rota aceita a própria foto da matéria em vez de recusar com 400', () => {
  assert.match(ROTA, /const jaEhDaMateria =/);
  assert.match(ROTA, /\[matter\.imagem_fonte_url, matter\.imagem_url\]/);
  assert.match(ROTA, /if \(jaEhDaMateria\) generatedSource = '';/);
  // A recusa continua existindo para arquivo de outra matéria.
  assert.match(ROTA, /A imagem temporária informada não pertence a esta matéria/);
});

test('o botão de recorte aparece também sem imagem_fonte_url', () => {
  // Com o botão escondido sumia junto o painel de gerar imagem com IA, que
  // mora dentro do modal de recorte.
  assert.match(EDITOR_EJS, /const fotoParaRecorte = \(\(\) => \{/);
  assert.doesNotMatch(
    EDITOR_EJS,
    /id="btn-abrir-recorte"\s*\n\s*class="<%= imagemFonteUrl \? '' : 'hidden' %>/,
    'a visibilidade não pode depender só de imagem_fonte_url'
  );
  assert.match(EDITOR_EJS, /imagemFonteUrl: <%- JSON\.stringify\(fotoParaRecorte \|\| null\) %>,/);
});

test('sem foto, a janela abre só com o painel da IA', () => {
  assert.match(EDITOR_JS, /function mostrarPalcoDeRecorte\(temFoto\)/);
  assert.match(EDITOR_JS, /'matter-crop-palco', 'matter-crop-controls', 'matter-crop-help'/);
  // Os ids precisam existir no HTML, senão o toggle não acha nada.
  for (const id of ['matter-crop-palco', 'matter-crop-controls', 'matter-crop-help']) {
    assert.ok(EDITOR_EJS.includes(`id="${id}"`), `${id} precisa existir na view`);
  }
  assert.match(EDITOR_JS, /a ilustração simbólica não precisa de foto/);
});

// ── 2. Foto escolhida antes de criar o rascunho ─────────────────────────────

test('a foto trocada depois de salvar entra no rascunho', () => {
  // Antes, garantirRascunho devolvia o id em cache e a escolha nova nunca
  // chegava ao servidor: abrir "Editar no rascunho" mostrava a foto antiga.
  assert.match(CHAT_JS, /async function garantirCapaNoRascunho\(id\)/);
  assert.match(CHAT_JS, /if \(!escolhida \|\| escolhida === capaNoRascunho\) return;/);
  assert.match(CHAT_JS, /aplicar-imagem-url/);
  assert.match(
    CHAT_JS,
    /if \(mensagem\.matterId\) \{[\s\S]{0,200}await garantirCapaNoRascunho\(mensagem\.matterId\);/,
    'garantirRascunho tem de aplicar antes de devolver o id'
  );
  assert.match(CHAT_JS, /capaNoRascunho = imagem\.value\.trim\(\) \|\| null;/);
});

test('o recorte trabalha sobre a foto que está na tela', () => {
  const trecho = CHAT_JS.slice(CHAT_JS.indexOf("recortar.addEventListener"));
  assert.match(
    trecho.slice(0, 900),
    /await garantirCapaNoRascunho\(mensagem\.matterId\);/,
    'sem isso o recorte pega a foto velha do rascunho'
  );
});

test('capa escolhida fora da lista não é descartada em silêncio', () => {
  assert.match(CHAT_SRV, /const escolhaValida = capaEscolhidaValida\(imagemUrl, userId\);/);
  assert.match(CHAT_SRV, /capa escolhida recusada/, 'precisa dizer no log quando recusa');
});

test('a capa aceita as fotos do editor e nada fora da pasta dele', () => {
  const { capaEscolhidaValida } = require('../src/services/materiaChatService');

  // Foto sugerida, link colado: URL remota sempre valeu.
  assert.equal(capaEscolhidaValida('https://site.com/foto.jpg', 7), true);
  // Arquivos do próprio editor — antes só `chat_*.jpg` passava.
  assert.equal(capaEscolhidaValida('/media/fontes/user_7/chat_12_1700_abcd1234.jpg', 7), true);
  assert.equal(capaEscolhidaValida('/media/fontes/user_7/materia_90_1700_abcd1234.jpg', 7), true);
  assert.equal(capaEscolhidaValida('/media/banco-imagens/user_7/deadbeefdeadbeef.jpg', 7), true);
  assert.equal(capaEscolhidaValida('/media/fontes/user_7/foto.webp', 7), true);

  assert.equal(capaEscolhidaValida('/media/fontes/user_8/foto.jpg', 7), false, 'pasta de outro editor');
  assert.equal(capaEscolhidaValida('/media/fontes/user_7/../../etc/senha.jpg', 7), false, 'subir pasta');
  assert.equal(capaEscolhidaValida('/media/fontes/user_7/sub/foto.jpg', 7), false, 'subpasta não vale');
  assert.equal(capaEscolhidaValida('/media/fontes/user_7/script.svg', 7), false, 'só imagem raster');
  assert.equal(capaEscolhidaValida('/media/artes/user_7/materia_1.jpg', 7), false, 'arte não é foto de origem');
  assert.equal(capaEscolhidaValida('/etc/passwd', 7), false);
  assert.equal(capaEscolhidaValida('javascript:alert(1)', 7), false);
  assert.equal(capaEscolhidaValida('', 7), false);
  assert.equal(capaEscolhidaValida(null, 7), false);
});
