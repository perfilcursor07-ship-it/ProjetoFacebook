function cleanSourceUrl(raw) {
  const value = String(raw || '')
    .trim()
    .replace(/[\])},.;:!?]+$/g, '');

  if (!/^https?:\/\//i.test(value)) return null;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourceHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'Abrir fonte';
  }
}

/**
 * Rótulo do link: o que vem antes do endereço na linha, sem o enfeite.
 *
 * Os caracteres • – — tinham virado "?" numa gravação em codificação errada,
 * então os marcadores nunca eram removidos e o rótulo saía como
 * "• O Fuxico Gospel —" em vez de "O Fuxico Gospel".
 */
function labelBeforeUrl(line, urlIndex) {
  return String(line || '')
    .slice(0, urlIndex)
    // "Por Redação — Site:" (rodapé do JM) vira só o nome do veículo.
    .replace(/^\s*por\s+.+?[—–-]\s*site\s*:\s*/i, '')
    .replace(/^\s*(?:fontes?|site|leia (?:mais|também)|via)\s*:\s*/i, '')
    .replace(/^\s*[•*–—-]+\s*/, '')
    .replace(/\s*[:–—-]+\s*$/, '')
    .trim();
}

/**
 * Linha do corpo que é crédito de fonte, e não texto da notícia.
 *
 * Cobre os dois rodapés que o projeto escreve — "Fonte: …", "Fontes:",
 * "Por Redação — Site: …" — e os itens de lista "• Veículo — endereço".
 */
const LINHA_DE_CREDITO =
  /^\s*(?:(?:[•*–—-]\s*)?(?:fontes?|site|leia (?:mais|também)|via)\s*:|por\s+.+?[—–-]\s*site\s*:|[•*–—-]\s*[^\n]{1,80}?\s*[—–-]\s*https?:\/\/)/i;

function extractMatterSourceLinks(matter = {}) {
  const sources = [];
  const seen = new Set();

  const add = (rawUrl, rawLabel = '') => {
    const url = cleanSourceUrl(rawUrl);
    if (!url) return;

    const key = url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    sources.push({
      url,
      label: String(rawLabel || '').trim() || sourceHost(url)
    });
  };

  for (const field of [matter.fonte_credito, matter.contexto_apuracao]) {
    for (const line of String(field || '').split(/\r?\n/)) {
      const matches = [...line.matchAll(/https?:\/\/[^\s<>"']+/gi)];
      for (const match of matches) {
        add(match[0], labelBeforeUrl(line, match.index || 0));
      }
    }
  }

  add(matter.fonte_url, '');

  // Último lugar onde o endereço ainda pode estar: o corpo da matéria.
  //
  // A caixa "Link da fonte" ficava só com o texto ("Chat de matérias +
  // pesquisa na web") sempre que `fonte_url` e `fonte_credito` vinham sem
  // endereço — e aí o editor não tinha como chegar na reportagem original.
  //
  // Só linhas de crédito entram: URL citada no meio do texto é conteúdo da
  // notícia, não a fonte dela.
  if (!sources.length) {
    for (const line of String(matter.materia || '').split(/\r?\n/)) {
      if (!LINHA_DE_CREDITO.test(line)) continue;
      const matches = [...line.matchAll(/https?:\/\/[^\s<>"']+/gi)];
      for (const match of matches) {
        add(match[0], labelBeforeUrl(line, match.index || 0));
      }
    }
  }

  return sources;
}

module.exports = { extractMatterSourceLinks, cleanSourceUrl };
