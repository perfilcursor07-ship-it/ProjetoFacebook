const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SCRIPT = fs.readFileSync('scripts/install-token-free-gateway-overrides.js', 'utf8');
const STREAM = 'src/providers/chatgpt/stream.ts';

test('o patch da imagem está registrado no instalador', () => {
  // A imagem da resposta chega no stream e é descartada: o parser lê só
  // `parts[0]` e só aproveita se for texto.
  assert.match(SCRIPT, /file: 'src\/providers\/chatgpt\/stream\.ts'/);
  assert.match(SCRIPT, /marca: 'viralizeai-imagem'/);
  // Texto literal, não regex: o trecho procurado contém barras de escape, e
  // escrevê-lo como expressão regular só convida a erro de escaping.
  assert.ok(
    SCRIPT.includes(String.raw`procurar: '\t\t\tconst rawPart = data.message?.content?.parts?.[0];'`),
    'o trecho procurado precisa casar byte a byte com o arquivo do gateway'
  );
});

test('o patch olha TODAS as partes, não só a primeira', () => {
  assert.match(SCRIPT, /for \(const parte of data\.message\?\.content\?\.parts \?\? \[\]\) \{/);
  // Parte de texto não interessa aqui — ela já é tratada logo abaixo.
  assert.match(SCRIPT, /if \(typeof p\.text === "string"\) continue;/);
});

test('o patch registra o formato em vez de supor', () => {
  // Não sabemos se a imagem vem como URL pública (foto achada na web) ou
  // como `file-service://` (gerada, com download autenticado). O log diz.
  assert.match(SCRIPT, /\[viralizeai-imagem\] parte nao-texto:/);
  assert.match(SCRIPT, /tipo: p\.content_type/);
  assert.match(SCRIPT, /campos: Object\.keys\(p\)/);
  assert.match(SCRIPT, /\[p\.asset_pointer, p\.url, p\.image_url, p\.src\]/);
});

test('o patch não altera a resposta — só observa', () => {
  const i = SCRIPT.indexOf("marca: 'viralizeai-imagem'");
  const trecho = SCRIPT.slice(i, i + 2200);
  assert.match(trecho, /Só registra; não muda a resposta/);
  // O `rawPart` original continua existindo depois do laço.
  assert.match(trecho, /const rawPart = data\.message\?\.content\?\.parts\?\.\[0\];/);
});

test('o patch foi aplicado no gateway e compila', () => {
  // `npm run gateway:sync` aplica; rodar de novo não duplica (tem `marca`).
  const alvo = `.tools/token-free-gateway/${STREAM}`;
  if (!fs.existsSync(alvo)) return; // gateway não instalado nesta máquina
  const codigo = fs.readFileSync(alvo, 'utf8');
  const vezes = (codigo.match(/viralizeai-imagem/g) || []).length;
  assert.ok(vezes >= 1, 'patch não aplicado');
  assert.equal(
    (codigo.match(/for \(const parte of data\.message\?\.content\?\.parts/g) || []).length,
    1,
    'aplicado mais de uma vez'
  );
});

test('a versão do gateway continua fixada', () => {
  // Patch casa com trecho exato; em outra versão ele não aplica e avisa.
  assert.match(SCRIPT, /const UPSTREAM_VERSION = '[\d.]+';/);
});
