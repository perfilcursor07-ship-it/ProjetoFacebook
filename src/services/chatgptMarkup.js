/**
 * O ChatGPT web marca links, citações e entidades com caracteres de uso
 * privado: U+E200 abre, U+E202 separa as partes e U+E201 fecha. Na tela eles
 * somem e sobra texto colado, por exemplo:
 *   "urlvídeo no YouTubehttps://www.youtube.com/watch?v=…"
 * Este módulo converte essa marcação em texto normal.
 */

const INICIO = '';
const MARCA = /([^]*)/g;
const SEPARADOR = /[-]/;
const USO_PRIVADO = /[-]/g;
const EH_URL = /^https?:\/\//i;

function linhaDeFonte(linha) {
  return /^\s*\**\s*fontes?\s*:/i.test(linha);
}

function substituirMarca(inner, ehFonte) {
  const partes = inner.split(SEPARADOR).map((parte) => parte.trim()).filter(Boolean);
  const tipo = String(partes.shift() || '').toLowerCase();

  if (tipo === 'url' || tipo === 'link') {
    const href = partes.find((parte) => EH_URL.test(parte)) || '';
    const rotulo = partes.find((parte) => !EH_URL.test(parte)) || '';
    // Na linha de Fonte vale o endereço real; no corpo, o texto do link.
    return ehFonte ? href || rotulo : rotulo || href;
  }
  if (tipo === 'entity') {
    try {
      const dados = JSON.parse(partes.join(''));
      if (Array.isArray(dados)) return String(dados[1] ?? dados[0] ?? '');
    } catch {
      return '';
    }
    return '';
  }
  // cite, filecite, navlist, image_group… não têm texto para o leitor.
  return '';
}

/**
 * Quando os separadores invisíveis se perdem no caminho, a Fonte chega como
 * "Veículo — urlrótulohttps://…". Mantém só o endereço.
 */
function corrigirLinkColadoNaFonte(linha) {
  return linha.replace(/\burl(?=\S)[^\n]*?(https?:\/\/[^\s*]+)/i, '$1');
}

/**
 * Marcação de bloco do Claude web em forma de TAG, a que ele usa hoje:
 *   <WritingBlock id="63928" variant="document">Pastor itinerante é preso…
 *
 * Nome em PascalCase terminado em "Block" (WritingBlock, CodeBlock,
 * ThinkingBlock…) mais os nomes de artefato. A tag vinha colada no título e
 * ia ao Facebook junto com ele.
 */
const TAG_BLOCO_CLAUDE = /<\/?(?:[A-Z][A-Za-z0-9]*Block|Writing|Artifact|antArtifact)\b[^<>]*\/?>/g;

/**
 * O Claude web embrulha textos longos num "documento". Já apareceu de duas
 * formas, e as duas chegavam como texto:
 *
 *   :::writing{variant="document" id="31847" title="Título"}
 *   …matéria…
 *   :::
 *
 *   <WritingBlock id="63928" variant="document">…matéria…</WritingBlock>
 *
 * Na interface dele isso vira um cartão; aqui a abertura virava o título da
 * matéria. Remove abertura e fechamento das duas formas.
 */
function removerBlocosDoClaude(texto) {
  let valor = String(texto ?? '');
  if (valor.includes('<')) valor = valor.replace(TAG_BLOCO_CLAUDE, '');
  if (!valor.includes(':::')) return valor;
  return valor
    // Abertura em linha própria (leva a quebra de linha junto).
    .replace(/(^|\n)[ \t]*:::[a-z][\w-]*(?:\{[^}\n]*\})?[ \t]*(?:\r?\n|$)/gi, '$1')
    // Abertura colada ao texto.
    .replace(/:::[a-z][\w-]*\{[^}\n]*\}[ \t]*/gi, '')
    // Fechamento ":::" sozinho na linha ou no fim de uma linha.
    .replace(/[ \t]*(?<![:\w]):::(?![:\w{])[ \t]*(?=\r?\n|$)/g, '');
}

/**
 * Posição de uma abertura que ainda não terminou de chegar no streaming
 * (ou -1). Até fechar, esse trecho não é mostrado ao editor.
 *
 * Vale para ":::nome{…" e para "<WritingBl" — meia tag na tela era o mesmo
 * lixo, só mais difícil de reconhecer. O texto segurado não se perde: a
 * resposta completa passa pela limpeza no fim do stream.
 */
function inicioDeBlocoAberto(texto) {
  const s = String(texto);
  const m = s.match(/(?:^|\s)(:{1,3}(?:[a-z][\w-]*(?:\{[^}\n]*)?)?)$/i);
  if (m) return s.length - m[1].length;

  const tag = s.match(/<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?$/);
  if (tag) {
    const nome = (tag[0].match(/^<\/?([A-Za-z][A-Za-z0-9]*)/) || [])[1] || '';
    // Só segura o que pode virar bloco do Claude: PascalCase ou "ant…".
    if (/^(?:[A-Z]|ant)/.test(nome)) return s.length - tag[0].length;
  }
  return -1;
}

function limparMarcacaoChatgpt(texto, { corrigirFonte = true } = {}) {
  const valor = removerBlocosDoClaude(String(texto ?? ''));
  return valor
    .split('\n')
    .map((linha) => {
      const ehFonte = linhaDeFonte(linha);
      let limpa = linha.includes(INICIO)
        ? linha.replace(MARCA, (_, inner) => substituirMarca(inner, ehFonte))
        : linha;
      limpa = limpa.replace(USO_PRIVADO, '');
      return ehFonte && corrigirFonte ? corrigirLinkColadoNaFonte(limpa) : limpa;
    })
    .join('\n');
}

/**
 * Versão para streaming: guarda o trecho a partir de uma marca ainda aberta
 * e só libera o texto quando ela fecha, para o editor nunca ver o lixo.
 */
function criarLimpadorDeStream() {
  let bruto = '';
  let entregue = '';
  return {
    empurrar(delta) {
      bruto += String(delta || '');
      const aberta = bruto.lastIndexOf(INICIO);
      let fim = aberta >= 0 && bruto.indexOf('', aberta) < 0 ? aberta : bruto.length;
      const blocoAberto = inicioDeBlocoAberto(bruto.slice(0, fim));
      if (blocoAberto >= 0) fim = blocoAberto;
      // Sem a correção da Fonte: ela reescreve texto já entregue. O texto
      // final devolvido pelo gateway passa pela limpeza completa.
      const limpo = limparMarcacaoChatgpt(bruto.slice(0, fim), { corrigirFonte: false });
      if (!limpo.startsWith(entregue)) {
        entregue = limpo;
        return '';
      }
      const novo = limpo.slice(entregue.length);
      entregue = limpo;
      return novo;
    },
  };
}

module.exports = { limparMarcacaoChatgpt, criarLimpadorDeStream, removerBlocosDoClaude };
