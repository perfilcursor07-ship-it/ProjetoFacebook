const axios = require('axios');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function decodificarHtml(texto) {
  if (!texto) return '';
  let t = String(texto);
  // Entidades primeiro (RSS do Google News vem com &lt;a&gt;…&lt;/a&gt;)
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#8211;/gi, '–')
    .replace(/&#8212;/gi, '—')
    .replace(/&#8216;|&#8217;/gi, "'")
    .replace(/&#8220;|&#8221;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  // Entidades numéricas que sobraram (&#x27; da BBC, &#8230; etc.)
  t = t
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return ' ';
      }
    })
    .replace(/&#(\d{1,7});/g, (_, dec) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return ' ';
      }
    });
  t = t
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

function decodificarUrlMeta(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function absolutizarUrl(baseUrl, maybeRelative) {
  const raw = decodificarUrlMeta(maybeRelative);
  if (!raw) return null;
  try {
    const abs = new URL(raw, baseUrl || undefined).href;
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch {
    return null;
  }
}

function extrairMeta(html, propriedade) {
  const padroes = [
    new RegExp(`<meta[^>]+property=["']${propriedade}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${propriedade}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${propriedade}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${propriedade}["']`, 'i'),
  ];
  for (const re of padroes) {
    const m = html.match(re);
    if (m?.[1]) {
      // URLs de metadados não podem passar por decodificarHtml(), que remove links.
      if (/^(?:og:image|og:url|twitter:image)$/i.test(propriedade)) {
        return decodificarUrlMeta(m[1]);
      }
      return decodificarHtml(m[1]);
    }
  }
  return null;
}

function parsearDataPublicacao(valor) {
  const raw = decodificarHtml(valor || '').trim();
  if (!raw) return 0;
  const direto = Date.parse(raw);
  if (!Number.isNaN(direto)) return direto;

  const meses = {
    janeiro: 0,
    fevereiro: 1,
    marco: 2,
    'mar\u00e7o': 2,
    abril: 3,
    maio: 4,
    junho: 5,
    julho: 6,
    agosto: 7,
    setembro: 8,
    outubro: 9,
    novembro: 10,
    dezembro: 11,
  };
  const pt = raw.match(/\b(\d{1,2})\s+de\s+([a-z\u00e0-\u00ff]+)\s+de\s+(\d{4})\b/i);
  if (!pt) return 0;
  const mes = meses[pt[2].toLowerCase()];
  return mes == null ? 0 : new Date(Number(pt[3]), mes, Number(pt[1])).getTime();
}

function extrairDataPublicacaoDoHtml(html) {
  const structured = [
    extrairMeta(html, 'article:published_time'),
    extrairMeta(html, 'datePublished'),
    extrairMeta(html, 'publish-date'),
    extrairMeta(html, 'parsely-pub-date'),
    extrairMeta(html, 'sailthru.date'),
    String(html || '').match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1],
    String(html || '').match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1],
  ].filter(Boolean);
  for (const value of structured) {
    const timestamp = parsearDataPublicacao(value);
    if (timestamp) return { dataPublicacao: decodificarHtml(value), dataTimestamp: timestamp };
  }

  const visible = decodificarHtml(String(html || '')).match(
    /\b\d{1,2}\s+de\s+[a-z\u00e0-\u00ff]+\s+de\s+\d{4}\b/i
  )?.[0];
  const timestamp = parsearDataPublicacao(visible);
  return timestamp ? { dataPublicacao: visible, dataTimestamp: timestamp } : null;
}

function limparMarkdownReader(texto) {
  return decodificarHtml(texto)
    .replace(/^Title:\s*/gim, '')
    .replace(/^URL Source:\s*https?:\/\/\S+/gim, '')
    .replace(/^Markdown Content:\s*/gim, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extrairMetadadosViaJina(urlReal) {
  // Sem chave (ou com 403 em série) o r.jina.ai só gasta 20s por link.
  const providerHealth = require('./providerHealth');
  if (providerHealth.estaFora('jina')) return null;
  try {
    // O r.jina.ai passou a exigir chave: sem ela a resposta é 403 e o fallback
    // não serve para nada. Com JINA_API_KEY no .env o leitor volta a funcionar.
    const jinaKey = String(process.env.JINA_API_KEY || '').trim();
    const res = await axios.get(`https://r.jina.ai/${urlReal}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        ...(jinaKey ? { Authorization: `Bearer ${jinaKey}` } : {}),
      },
      timeout: 20000,
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const raw = String(res.data || '');
    const dataJina =
      raw.match(/^(?:Published Time|Published|Date):\s*(.+)$/im)?.[1]?.trim() || null;
    const dataTimestamp = parsearDataPublicacao(dataJina);
    const titulo =
      raw.match(/^Title:\s*(.+)$/im)?.[1]?.trim() ||
      raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      null;
    const texto = limparMarkdownReader(raw);
    const paragrafos = texto
      .split(/\n{2,}|\.\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length >= 80 && !/^https?:\/\//i.test(p));
    const trecho = paragrafos.slice(0, 16).join('\n\n');
    if (!trecho && !titulo) return null;
    return {
      url: urlReal,
      titulo,
      resumo: paragrafos[0]?.slice(0, 400) || null,
      imagem: null,
      trecho,
      autor: null,
      veiculo: (() => {
        try {
          return new URL(urlReal).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })(),
      veiculoHost: null,
      dataPublicacao: dataTimestamp ? dataJina : null,
      dataTimestamp,
    };
  } catch (err) {
    console.warn('extrairMetadadosArtigo Jina:', err.message);
    require('./providerHealth').registrarFalha('jina', err.message);
    return null;
  }
}

/**
 * A imagem serve como capa de matéria? Rejeita logos, avatares e as imagens
 * genéricas de agregadores. É a checagem única usada pelos leitores de
 * artigo, pela capa do chat/rascunho e pelo Dots.
 */
function imagemServeDeCapa(url) {
  const valor = String(url || '').trim();
  if (!/^https?:\/\//i.test(valor) && !/^\/media\/fontes\//i.test(valor)) return false;
  if (imagemPareceLogoOuAvatar(valor)) return false;
  // Logo do Google Notícias e miniaturas do Google: nunca são a foto da reportagem.
  if (/(?:^|\/\/)(?:[a-z0-9-]+\.)*(?:googleusercontent\.com|ggpht\.com|google\.com)\//i.test(valor)) return false;
  return true;
}

function imagemPareceLogoOuAvatar(url, className = '') {
  const hay = `${url} ${className}`.toLowerCase();

  // Marca do próprio agregador: a og:image do Google Notícias é o logo deles,
  // e não tem "logo" no nome do arquivo — só o domínio denuncia. Sem isto, uma
  // matéria que chega por link do Google saía com o logo do Google como foto.
  if (/(?:^|\/\/)(?:[a-z0-9-]+\.)*(?:gstatic\.com|news\.google\.com)\//i.test(hay)) {
    return true;
  }

  return /(?:^|[\s/_-])(?:logo|avatar|icons?|sprite|emoji|favicon|badge)(?:[\s/_.-]|$)|gravatar|wp-smiley|site-logo|cropped-logo|\/ads?\/|banner-sm|[-_]ads?[-_]/i.test(
    hay
  );
}

function attrsImagem(tagOrAttrs) {
  const attrs = String(tagOrAttrs || '');
  const cls = attrs.match(/\bclass=["']([^"']+)["']/i)?.[1] || '';
  const attribute = (name) => attrs.match(new RegExp('(?:^|\\s)' + name + '=["\']([^"\']+)["\']', 'i'))?.[1];
  const srcset = attribute('data-srcset') || attribute('srcset') || '';
  const maior = srcset.split(',').map((item) => {
    const [url, tamanho] = item.trim().split(/\s+/);
    return { url, tamanho: parseFloat(tamanho) || 0 };
  }).filter((item) => item.url && !/^data:/i.test(item.url))
    .sort((a, b) => b.tamanho - a.tamanho)[0]?.url;
  const src = [maior, attribute('data-src'), attribute('data-lazy-src'), attribute('src')]
    .find((url) => url && !/^(?:data:|blob:|javascript:)/i.test(url)
      && !/(?:placeholder|transparent|spacer)(?:[._/-]|$)/i.test(url)) || null;
  const w = Number(attrs.match(/\bwidth=["']?(\d+)/i)?.[1] || 0);
  const h = Number(attrs.match(/\bheight=["']?(\d+)/i)?.[1] || 0);
  return { cls, src, w, h };
}

/**
 * Extrai capa editorial: og/twitter → featured WP (1ª do artigo) → JSON-LD → maior <img> útil.
 */
function extrairImagemCapa(html, pageUrl) {
  const candidatosMeta = [
    extrairMeta(html, 'og:image'),
    extrairMeta(html, 'og:image:secure_url'),
    extrairMeta(html, 'twitter:image'),
    extrairMeta(html, 'twitter:image:src'),
  ];
  for (const c of candidatosMeta) {
    const abs = absolutizarUrl(pageUrl, c);
    if (abs && !imagemPareceLogoOuAvatar(abs)) return abs;
  }

  // Recorta o HTML do artigo quando possível (evita thumbs de "relacionados")
  const artigoHtml =
    html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/class=["'][^"']*ast-article-single[^"']*["'][\s\S]{0,25000}/i)?.[0] ||
    html.match(/class=["'][^"']*entry-content[^"']*["'][\s\S]{0,25000}/i)?.[0] ||
    html;

  // WordPress featured / schema microdata — sempre a primeira do artigo
  const featuredRes = [
    /<img[^>]+class=["'][^"']*wp-post-image[^"']*["'][^>]*>/i,
    /<img[^>]+itemprop=["']image["'][^>]*>/i,
    /<img[^>]+class=["'][^"']*(?:featured(?:-image)?|post-thumbnail)[^"']*["'][^>]*>/i,
    /<img[^>]+fetchpriority=["']high["'][^>]*>/i,
  ];
  for (const re of featuredRes) {
    const tag = artigoHtml.match(re)?.[0];
    if (!tag) continue;
    const { cls, src } = attrsImagem(tag);
    const abs = absolutizarUrl(pageUrl, src);
    if (abs && !imagemPareceLogoOuAvatar(abs, cls)) return abs;
  }

  // JSON-LD image
  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const img = node.image || node.thumbnailUrl;
        const raw = Array.isArray(img) ? img[0] : img;
        const url = typeof raw === 'string' ? raw : raw?.url || raw?.contentUrl || null;
        const abs = absolutizarUrl(pageUrl, url);
        if (abs && !imagemPareceLogoOuAvatar(abs)) return abs;
      }
    } catch {
      /* JSON-LD inválido — ignora */
    }
  }

  // Maior <img> candidata dentro do artigo
  let melhor = null;
  for (const m of artigoHtml.matchAll(/<img\b([^>]+)>/gi)) {
    const { cls, src, w, h } = attrsImagem(m[1]);
    const abs = absolutizarUrl(pageUrl, src);
    if (!abs || imagemPareceLogoOuAvatar(abs, cls)) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(abs) && !/\/uploads?\//i.test(abs)) continue;

    let score = w * h;
    if (!score) {
      const srcsetMax = [...String(m[1].match(/\bsrcset=["']([^"']+)["']/i)?.[1] || '').matchAll(/(\d+)w/g)]
        .map((x) => Number(x[1]))
        .sort((a, b) => b - a)[0];
      score = srcsetMax ? srcsetMax * 600 : 1;
    }
    if (w && w < 200 && h && h < 200) continue;
    if (/cropped-|[-_]300x300|avatar|author/i.test(abs + cls)) score *= 0.2;
    if (/wp-post-image|featured|attachment-large|size-large|hero|fetchpriority/i.test(cls + m[1])) {
      score *= 5;
    }
    // Preferir a primeira imagem boa do artigo em empate
    if (!melhor || score > melhor.score) melhor = { url: abs, score };
  }

  return melhor?.url || null;
}

function urlValida(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (lower.includes('news.google.com')) return false;
  if (lower.includes('googleusercontent.com') || lower.includes('gstatic.com')) return false;
  return /^https?:\/\//i.test(url);
}

async function resolverUrlNoticia(url) {
  if (!url) return null;
  if (!url.includes('news.google.com')) return urlValida(url) ? url : null;

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const html = String(res.data || '');
    const finalUrl = res.request?.res?.responseUrl || res.config?.url;
    if (urlValida(finalUrl) && !String(finalUrl).includes('news.google.com')) return finalUrl;

    const canonical =
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
    // A página do Google Notícias aponta o canonical para ela mesma. Devolver
    // isso fazia a busca de capa pegar a og:image do Google — o logo deles
    // virava a "foto" da matéria.
    if (urlValida(canonical) && !String(canonical).includes('news.google.com')) return canonical;
  } catch (err) {
    console.warn('resolverUrlNoticia:', err.message);
  }
  return null;
}

function limparTextoArtigo(texto) {
  return decodificarHtml(texto)
    .replace(/\b(leia também|veja também|publicidade|continua após a publicidade)\b.*$/i, '')
    // Botões de compartilhar que alguns sites (BBC, portais) deixam no mesmo bloco do texto
    .replace(
      /^(?:(?:share|save|add as preferred on google|sign in|follow|listen|watch|facebook|twitter|whatsapp|telegram|linkedin|compartilhar|salvar|imprimir|copiar link)[\s,·|—–-]*)+/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome do veículo publicado no JSON-LD (publisher/organization). */
function extrairVeiculoJsonLd(html) {
  const ldBlocks =
    String(html || '').match(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) || [];
  for (const block of ldBlocks) {
    const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data)
        ? data
        : [data, ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
      for (const node of nodes) {
        const p = node?.publisher;
        const nome =
          (typeof p === 'string' && p) ||
          p?.name ||
          (Array.isArray(p) && (p[0]?.name || p[0])) ||
          (/(?:News)?MediaOrganization|Organization/i.test(String(node?.['@type'] || '')) &&
            node?.name) ||
          null;
        const limpo = String(nome || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (limpo && limpo.length <= 80) return limpo;
      }
    } catch {
      /* ignore json */
    }
  }
  return null;
}

function extrairArticleBodyJsonLd(html) {
  const ldBlocks = String(html || '').match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];
  for (const block of ldBlocks) {
    const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
      for (const node of nodes) {
        const body = node?.articleBody || node?.text;
        if (typeof body === 'string' && body.replace(/\s+/g, ' ').trim().length >= 180) {
          return limparTextoArtigo(body);
        }
      }
    } catch {
      /* ignore json */
    }
  }
  return null;
}

function htmlPrincipal(html) {
  return (
    html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0] ||
    html.match(/class=["'][^"']*(?:entry-content|post-content|article-content|materia|content-text|story-content)[^"']*["'][\s\S]{0,35000}/i)?.[0] ||
    html
  );
}

function paragrafoUtil(t) {
  if (t.length < 40) return false;
  if (/^(publicidade|continua após a publicidade|leia também|veja também|compartilhe|siga-nos|newsletter)$/i.test(t)) return false;
  if (/cookies?|termos de uso|política de privacidade|assine|login|cadastre-se/i.test(t)) return false;
  // Barra de navegação/rodapé que vem dentro de <p> em sites internacionais (BBC, Sky…)
  if (/british broadcasting corporation|bbc in other languages|copyright \d{4}|todos os direitos reservados/i.test(t)) {
    return false;
  }
  if (/^(?:home|news|sport|business|technology|health|culture|arts|travel|earth|audio|video|live|weather)\b[\s|·]/i.test(t)) {
    return false;
  }
  const letras = (t.match(/\p{L}/gu) || []).length;
  return letras >= 28;
}

function extrairParagrafos(html) {
  const bodyJson = extrairArticleBodyJsonLd(html);
  if (bodyJson) {
    return bodyJson
      .split(/(?:\n{2,}|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ]))/)
      .map((p) => limparTextoArtigo(p))
      .filter(paragrafoUtil)
      .slice(0, 60);
  }

  const paragrafosDe = (trechoHtml) => {
    const blocos = String(trechoHtml || '').match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
    const textos = [];
    const vistos = new Set();
    for (const bloco of blocos) {
      const t = limparTextoArtigo(bloco);
      if (!paragrafoUtil(t)) continue;
      const key = t.slice(0, 120).toLowerCase();
      if (vistos.has(key)) continue;
      vistos.add(key);
      textos.push(t);
      if (textos.join(' ').length > 9000) break;
    }
    return textos;
  };

  const principal = htmlPrincipal(html);
  let textos = paragrafosDe(principal);
  // Alguns portais (g1, UOL) deixam o corpo fora de <article>/<main>: se o
  // recorte rendeu pouco, varre a página inteira e fica com a versão maior.
  if (textos.join(' ').length < 1200 && principal !== html) {
    const completo = paragrafosDe(html);
    if (completo.join(' ').length > textos.join(' ').length) textos = completo;
  }
  return textos;
}

function extrairAutorDoHtml(html) {
  const limpar = (s) =>
    String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^por\s+/i, '')
      .replace(/^by\s+/i, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim()
      .slice(0, 80);

  const pareceNome = (s) => {
    const v = limpar(s);
    if (!v || v.length < 3 || v.length > 70) return false;
    if (/^(redacao|redação|equipe|staff|editor|admin|agencia|agência)$/i.test(v)) return false;
    if (/\d{4}/.test(v)) return false;
    if (/\.(com|br|net|org)\b/i.test(v)) return false;
    // Prefer nomes com 2+ palavras ou nome próprio capitalizado
    return /[\p{L}]{2,}/u.test(v);
  };

  const metaAuthor =
    extrairMeta(html, 'author') ||
    extrairMeta(html, 'article:author') ||
    extrairMeta(html, 'og:article:author') ||
    extrairMeta(html, 'parsely-author') ||
    extrairMeta(html, 'byl');
  if (pareceNome(metaAuthor)) return limpar(metaAuthor);

  // JSON-LD author.name
  const ldBlocks = String(html || '').match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];
  for (const block of ldBlocks) {
    const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const graph = Array.isArray(node?.['@graph']) ? node['@graph'] : [node];
        for (const item of graph) {
          const a = item?.author;
          const name =
            (typeof a === 'string' && a) ||
            a?.name ||
            (Array.isArray(a) && (a[0]?.name || a[0])) ||
            null;
          if (pareceNome(name)) return limpar(name);
        }
      }
    } catch {
      /* ignore json */
    }
  }

  // Byline visível: "Por Abby Trivett" / "By Abby Trivett"
  const byline =
    String(html || '').match(
      /(?:class|id)=["'][^"']*(?:author|byline|escritor|reporter)[^"']*["'][^>]*>[\s\S]{0,200}?Por\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+){0,3})/i
    ) ||
    String(html || '').match(
      />\s*Por\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+){0,3})\s*</i
    ) ||
    String(html || '').match(
      />\s*By\s+([A-Z][\w'’.\-]+(?:\s+[A-Z][\w'’.\-]+){0,3})\s*</i
    );
  if (byline && pareceNome(byline[1])) return limpar(byline[1]);

  return null;
}

/**
 * O Google Translate também funciona como proxy de leitura para páginas que
 * bloqueiam datacenters (403/WAF). O texto pode continuar no idioma original;
 * isso não é problema, porque a etapa de redação detecta e traduz a fonte.
 */
function urlProxyGoogleTranslate(urlReal) {
  try {
    const source = new URL(String(urlReal || '').trim());
    if (!/^https?:$/.test(source.protocol)) return null;
    const hostTraduzido = source.hostname
      .replace(/-/g, '--')
      .replace(/\./g, '-');
    const proxy = new URL(`https://${hostTraduzido}.translate.goog${source.pathname || '/'}`);
    for (const [key, value] of source.searchParams.entries()) {
      proxy.searchParams.append(key, value);
    }
    proxy.searchParams.set('_x_tr_sl', 'auto');
    proxy.searchParams.set('_x_tr_tl', 'pt');
    proxy.searchParams.set('_x_tr_hl', 'pt-BR');
    return proxy.toString();
  } catch {
    return null;
  }
}

async function extrairMetadadosViaGoogleTranslate(urlReal) {
  const proxyUrl = urlProxyGoogleTranslate(urlReal);
  if (!proxyUrl) return null;
  try {
    const res = await axios.get(proxyUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const html = String(res.data || '');
    const titulo =
      extrairMeta(html, 'og:title') ||
      decodificarHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const resumo = extrairMeta(html, 'og:description') || extrairMeta(html, 'description') || '';
    const paragrafos = extrairParagrafos(html);
    const trecho = paragrafos.slice(0, 20).join('\n\n');
    if (trecho.trim().length < 180) return null;
    const autor = extrairAutorDoHtml(html);
    const dataPublicacao = extrairDataPublicacaoDoHtml(html);
    const veiculoHost = (() => {
      try {
        return new URL(urlReal).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    })();
    const veiculo =
      extrairMeta(html, 'og:site_name') ||
      extrairMeta(html, 'application-name') ||
      extrairMeta(html, 'publisher') ||
      extrairVeiculoJsonLd(html) ||
      veiculoHost;
    console.info(`[article-source] Google Translate leu ${veiculoHost || urlReal}: ${trecho.length} caracteres`);
    return {
      url: urlReal,
      titulo: titulo || null,
      resumo: resumo || null,
      imagem: extrairImagemCapa(html, urlReal) || null,
      trecho,
      autor: autor || null,
      veiculo,
      veiculoHost,
      dataPublicacao: dataPublicacao?.dataPublicacao || null,
      dataTimestamp: dataPublicacao?.dataTimestamp || 0,
      leitorFallback: 'google-translate',
    };
  } catch (err) {
    console.warn('extrairMetadadosArtigo GoogleTranslate:', err.message);
    return null;
  }
}

let chromiumLeitorPromise = null;
let chromeLeitorPromise = null;

function hostLiteralPrivado(hostname) {
  const host = String(hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const versao = net.isIP(host);
  if (versao === 4) {
    const partes = host.split('.').map(Number);
    return (
      partes[0] === 10 ||
      partes[0] === 127 ||
      partes[0] === 0 ||
      (partes[0] === 169 && partes[1] === 254) ||
      (partes[0] === 172 && partes[1] >= 16 && partes[1] <= 31) ||
      (partes[0] === 192 && partes[1] === 168)
    );
  }
  if (versao === 6) {
    return (
      host === '::1' ||
      host === '::' ||
      /^f[cd]/i.test(host) ||
      /^fe[89ab]/i.test(host) ||
      /^::ffff:(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(host)
    );
  }
  return false;
}

function urlPublicaParaChrome(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return /^https?:$/.test(parsed.protocol) && !hostLiteralPrivado(parsed.hostname);
  } catch {
    return false;
  }
}

async function carregarChromiumLeitor() {
  if (chromiumLeitorPromise) return chromiumLeitorPromise;
  chromiumLeitorPromise = (async () => {
    try {
      return require('playwright-core').chromium;
    } catch {
      // Em produção o Playwright pertence ao token-free-gateway, não ao app.
    }

    const sourceDir = String(process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR || '').trim();
    const caminhoConfigurado = String(process.env.PLAYWRIGHT_CORE_PATH || '').trim();
    const candidatos = [
      caminhoConfigurado,
      sourceDir && path.join(sourceDir, 'node_modules', 'playwright-core', 'index.mjs'),
      path.resolve(__dirname, '../../.tools/token-free-gateway/node_modules/playwright-core/index.mjs'),
    ].filter(Boolean);

    for (const candidato of candidatos) {
      let arquivo = candidato;
      if (fs.existsSync(arquivo) && fs.statSync(arquivo).isDirectory()) {
        arquivo = path.join(arquivo, 'index.mjs');
      }
      if (!fs.existsSync(arquivo)) continue;
      const modulo = await import(pathToFileURL(arquivo).href);
      if (modulo?.chromium) return modulo.chromium;
    }
    throw new Error('playwright-core não encontrado');
  })().catch((err) => {
    chromiumLeitorPromise = null;
    throw err;
  });
  return chromiumLeitorPromise;
}

async function conectarChromeLeitor() {
  if (chromeLeitorPromise) {
    const atual = await chromeLeitorPromise.catch(() => null);
    if (atual?.isConnected?.()) return atual;
    chromeLeitorPromise = null;
  }

  chromeLeitorPromise = (async () => {
    const chromium = await carregarChromiumLeitor();
    const cdpUrl =
      String(process.env.TOKEN_FREE_GATEWAY_CDP_URL || process.env.TFG_CDP_URL || '').trim() ||
      'http://127.0.0.1:9222';
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 4_000 });
    browser.on('disconnected', () => {
      chromeLeitorPromise = null;
    });
    return browser;
  })().catch((err) => {
    chromeLeitorPromise = null;
    throw err;
  });
  return chromeLeitorPromise;
}

/**
 * Último leitor do link exato: abre uma aba temporária no Chrome já mantido
 * pelo gateway. Isso resolve portais que devolvem 403 para Axios/datacenters,
 * sem transformar a opção "Pesquisar na web" em busca por outras fontes.
 */
async function extrairMetadadosViaChrome(urlReal) {
  if (!urlPublicaParaChrome(urlReal)) return null;

  let page = null;
  let contextoCriado = null;
  try {
    const browser = await conectarChromeLeitor();
    let context = browser.contexts()[0];
    if (!context) {
      context = await browser.newContext({ locale: 'pt-BR' });
      contextoCriado = context;
    }
    page = contextoCriado
      ? await context.newPage()
      : await require('./abaEmSegundoPlano').novaAbaEmSegundoPlano(browser, context);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    });
    await page.route('**/*', async (route) => {
      try {
        const requisicao = new URL(route.request().url());
        if (/^https?:$/.test(requisicao.protocol) && hostLiteralPrivado(requisicao.hostname)) {
          await route.abort('blockedbyclient');
          return;
        }
      } catch {
        // data:, blob: e outros recursos internos do navegador são permitidos.
      }
      await route.continue();
    });

    const timeout = Math.max(
      10_000,
      Math.min(45_000, Number(process.env.ARTICLE_BROWSER_TIMEOUT_MS) || 30_000)
    );
    await page.goto(urlReal, { waitUntil: 'domcontentloaded', timeout });
    await page
      .waitForFunction(
        () => {
          const paragrafos = [
            ...document.querySelectorAll('article p, main p, [class*="content"] p'),
          ];
          return (
            paragrafos.length >= 3 &&
            paragrafos.reduce((n, p) => n + (p.innerText || '').length, 0) >= 600
          );
        },
        null,
        { timeout: Math.min(12_000, timeout) }
      )
      .catch(() => {});

    const finalUrl = page.url() || urlReal;
    if (!urlPublicaParaChrome(finalUrl)) return null;
    const html = await page.content();
    const titulo =
      extrairMeta(html, 'og:title') ||
      decodificarHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const resumo = extrairMeta(html, 'og:description') || extrairMeta(html, 'description') || '';
    const paragrafos = extrairParagrafos(html);
    const trecho = paragrafos.join('\n\n');
    if (trecho.trim().length < 180) return null;

    const veiculoHost = new URL(finalUrl).hostname.replace(/^www\./i, '');
    const dataPublicacao = extrairDataPublicacaoDoHtml(html);
    const veiculo =
      extrairMeta(html, 'og:site_name') ||
      extrairMeta(html, 'application-name') ||
      extrairMeta(html, 'publisher') ||
      extrairVeiculoJsonLd(html) ||
      veiculoHost;
    console.info(`[article-source] Chrome leu ${veiculoHost}: ${trecho.length} caracteres`);
    return {
      url: finalUrl,
      titulo: titulo || null,
      resumo: resumo || null,
      imagem: extrairImagemCapa(html, finalUrl) || null,
      trecho,
      autor: extrairAutorDoHtml(html) || null,
      veiculo,
      veiculoHost,
      dataPublicacao: dataPublicacao?.dataPublicacao || null,
      dataTimestamp: dataPublicacao?.dataTimestamp || 0,
      leitorFallback: 'chrome',
    };
  } catch (err) {
    console.warn('extrairMetadadosArtigo Chrome:', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
    if (contextoCriado) await contextoCriado.close().catch(() => {});
  }
}

/**
 * Carrega uma página editorial completa no Chrome compartilhado. É usado por
 * rankings "Mais lidas" montados por JavaScript, que chegam vazios no Axios.
 * A aba é sempre temporária e bloqueia navegação para hosts locais/privados.
 */
async function carregarHtmlViaChrome(urlReal, { marcador = '', timeoutMs = 30_000 } = {}) {
  if (!urlPublicaParaChrome(urlReal)) return null;

  let page = null;
  let contextoCriado = null;
  try {
    const browser = await conectarChromeLeitor();
    let context = browser.contexts()[0];
    if (!context) {
      context = await browser.newContext({ locale: 'pt-BR' });
      contextoCriado = context;
    }
    page = contextoCriado
      ? await context.newPage()
      : await require('./abaEmSegundoPlano').novaAbaEmSegundoPlano(browser, context);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    await page.route('**/*', async (route) => {
      try {
        const requisicao = new URL(route.request().url());
        if (/^https?:$/.test(requisicao.protocol) && hostLiteralPrivado(requisicao.hostname)) {
          await route.abort('blockedbyclient');
          return;
        }
      } catch {
        // data:, blob: e recursos internos do navegador.
      }
      await route.continue();
    });

    const timeout = Math.max(8_000, Math.min(45_000, Number(timeoutMs) || 30_000));
    await page.goto(urlReal, { waitUntil: 'domcontentloaded', timeout });
    await page
      .waitForFunction(
        ({ texto }) => {
          const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const corpo = normalizar(document.body?.innerText || '');
          const marcadorOk = !texto || corpo.includes(normalizar(texto));
          const links = [...document.querySelectorAll('main a[href], article a[href], section a[href]')]
            .filter((a) => (a.innerText || a.getAttribute('aria-label') || '').trim().length >= 20);
          return marcadorOk && links.length >= 3;
        },
        { texto: String(marcador || '').trim() },
        { timeout: Math.min(12_000, timeout) }
      )
      .catch(() => {});

    const finalUrl = page.url() || urlReal;
    if (!urlPublicaParaChrome(finalUrl)) return null;
    return { html: await page.content(), finalUrl, leitor: 'chrome' };
  } catch (err) {
    console.warn('[mais-lidas] Chrome:', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
    if (contextoCriado) await contextoCriado.close().catch(() => {});
  }
}

async function extrairMetadadosViaClaudeWebFetch(urlReal) {
  try {
    const claudeService = require('./claudeService');
    if (!claudeService.isConfigured()) return null;
    const dados = await claudeService.extrairArtigoViaWebFetch(urlReal);
    if (!dados?.trecho) return null;
    const veiculoHost = (() => {
      try {
        return new URL(urlReal).hostname.replace(/^www\./i, '');
      } catch {
        return null;
      }
    })();
    const dataTimestamp = parsearDataPublicacao(dados.dataPublicacao);
    console.info(
      `[article-source] Claude web_fetch leu ${veiculoHost || urlReal}: ${dados.trecho.length} caracteres`
    );
    return {
      url: urlReal,
      titulo: dados.titulo || null,
      resumo: dados.resumo || null,
      imagem: null,
      trecho: dados.trecho,
      autor: dados.autor || null,
      veiculo: dados.veiculo || veiculoHost,
      veiculoHost,
      dataPublicacao: dados.dataPublicacao || null,
      dataTimestamp,
      leitorFallback: 'claude-web-fetch',
    };
  } catch (err) {
    console.warn('extrairMetadadosArtigo ClaudeWebFetch:', err.message);
    return null;
  }
}

function metaVazia(urlReal) {
  return {
    url: urlReal,
    titulo: null,
    resumo: null,
    imagem: null,
    trecho: '',
    autor: null,
    veiculo: null,
    veiculoHost: null,
    dataPublicacao: null,
    dataTimestamp: 0,
  };
}

function mesclarMetaMaisCompleta(base, candidata) {
  if (!candidata) return base;
  const textoBase = String(base?.trecho || '').trim();
  const textoCandidato = String(candidata?.trecho || '').trim();
  if (textoCandidato.length <= textoBase.length) return base;
  return {
    ...(base || {}),
    ...candidata,
    titulo: candidata.titulo || base?.titulo || null,
    resumo: candidata.resumo || base?.resumo || null,
    // Leitores alternativos (Chrome/Jina/Tradutor) podem cair numa página do
    // agregador e trazer o logo dele como imagem: só fica imagem que serve.
    imagem: [base?.imagem, candidata.imagem].find((img) => imagemServeDeCapa(img)) || null,
    autor: candidata.autor || base?.autor || null,
    veiculo: candidata.veiculo || base?.veiculo || null,
    veiculoHost: candidata.veiculoHost || base?.veiculoHost || null,
  };
}

async function completarMetaComLeitores(meta, urlReal) {
  let atual = meta || metaVazia(urlReal);
  const leitores = [
    extrairMetadadosViaChrome,
    extrairMetadadosViaJina,
    extrairMetadadosViaGoogleTranslate,
    extrairMetadadosViaClaudeWebFetch,
  ];
  for (const leitor of leitores) {
    if (String(atual?.trecho || '').trim().length >= 900) break;
    const candidata = await leitor(atual?.url || urlReal);
    atual = mesclarMetaMaisCompleta(atual, candidata);
  }
  return atual;
}

// Leituras recentes por link: a mesma pesquisa (ou a seguinte) pede o mesmo
// artigo várias vezes, e um site bloqueado custava ~60 s a cada tentativa.
const CACHE_ARTIGO_OK_MS = 30 * 60 * 1000;
const CACHE_ARTIGO_FALHA_MS = 20 * 60 * 1000;
const LIMITE_LEITURA_ARTIGO_MS = 35 * 1000;
const cacheArtigos = new Map();

function lembrarLeitura(chave, promessa) {
  const registro = { promessa, expira: Date.now() + CACHE_ARTIGO_OK_MS };
  cacheArtigos.set(chave, registro);
  promessa.then((meta) => {
    const leu = String(meta?.trecho || '').trim().length >= 200;
    registro.expira = Date.now() + (leu ? CACHE_ARTIGO_OK_MS : CACHE_ARTIGO_FALHA_MS);
  }, () => cacheArtigos.delete(chave));
  while (cacheArtigos.size > 500) cacheArtigos.delete(cacheArtigos.keys().next().value);
}

/**
 * Lê o artigo com memória por link e limite de tempo. Estourado o limite, a
 * pesquisa segue sem esse artigo; a leitura termina em segundo plano e fica
 * guardada para a próxima vez.
 */
async function extrairMetadadosArtigo(url) {
  const chave = String(url || '').trim();
  if (!chave) return null;
  const guardada = cacheArtigos.get(chave);
  let promessa;
  if (guardada && guardada.expira > Date.now()) {
    promessa = guardada.promessa;
  } else {
    promessa = extrairMetadadosArtigoSemCache(chave);
    lembrarLeitura(chave, promessa);
  }
  let timer;
  const limite = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[article-source] leitura passou de ${LIMITE_LEITURA_ARTIGO_MS / 1000}s; seguindo sem ${chave.slice(0, 120)}`);
      resolve(metaVazia(chave));
    }, LIMITE_LEITURA_ARTIGO_MS);
  });
  try {
    return await Promise.race([promessa, limite]);
  } finally {
    clearTimeout(timer);
  }
}

async function extrairMetadadosArtigoSemCache(url) {
  const urlReal = (await resolverUrlNoticia(url)) || url;
  if (!urlReal) return null;

  // Sites que respondem 403/404 em série (paywall, WAF) só gastam timeout:
  // ficam de fora por alguns minutos em vez de serem tentados a cada pauta.
  const providerHealth = require('./providerHealth');
  let host = '';
  try {
    host = new URL(urlReal).hostname.replace(/^www\./i, '');
  } catch {
    host = '';
  }
  // Site em que nenhum leitor (direto, Chrome, Jina, Tradutor) conseguiu ler:
  // pula na hora em vez de repetir ~60 s de tentativas.
  if (host && providerHealth.estaFora(`site-leitores:${host}`)) {
    return metaVazia(urlReal);
  }
  if (host && providerHealth.estaFora(`site:${host}`)) {
    return completarComLeitoresMarcandoBloqueio(metaVazia(urlReal), urlReal, host);
  }

  try {
    const res = await axios.get(urlReal, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(res.data || '');
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || urlReal;
    const titulo =
      extrairMeta(html, 'og:title') ||
      decodificarHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const resumo = extrairMeta(html, 'og:description') || extrairMeta(html, 'description') || '';
    const imagem = extrairImagemCapa(html, finalUrl);
    const paragrafos = extrairParagrafos(html);
    const autor = extrairAutorDoHtml(html);
    const dataPublicacao = extrairDataPublicacaoDoHtml(html);
    const veiculoMeta =
      extrairMeta(html, 'og:site_name') ||
      extrairMeta(html, 'application-name') ||
      extrairMeta(html, 'publisher') ||
      extrairVeiculoJsonLd(html);
    const veiculoHost = (() => {
      try {
        return new URL(finalUrl).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    })();

    if (host) providerHealth.registrarSucesso(`site:${host}`);
    const meta = {
      url: finalUrl,
      titulo: titulo || null,
      resumo: resumo || null,
      imagem: imagem || null,
      trecho: paragrafos.slice(0, 20).join('\n\n'),
      autor: autor || null,
      veiculo: veiculoMeta || veiculoHost,
      veiculoHost,
      dataPublicacao: dataPublicacao?.dataPublicacao || null,
      dataTimestamp: dataPublicacao?.dataTimestamp || 0,
    };
    return String(meta.trecho || '').trim().length < 900
      ? completarMetaComLeitores(meta, finalUrl)
      : meta;
  } catch (err) {
    console.warn('extrairMetadadosArtigo:', err.message);
    if (host) providerHealth.registrarFalha(`site:${host}`, err.message, { pausaMs: 5 * 60 * 1000 });
    return completarComLeitoresMarcandoBloqueio(metaVazia(urlReal), urlReal, host);
  }
}

/** Leitores alternativos; se todos falharem, o site é pulado por 30 min. */
async function completarComLeitoresMarcandoBloqueio(meta, urlReal, host) {
  const resultado = await completarMetaComLeitores(meta, urlReal);
  if (host && String(resultado?.trecho || '').trim().length < 200) {
    require('./providerHealth').registrarFalha(
      `site-leitores:${host}`,
      'nenhum leitor conseguiu ler o site',
      { pausaMs: 30 * 60 * 1000, imediato: true }
    );
  }
  return resultado;
}

/**
 * Leitura curta usada pela busca de imagens.
 *
 * Diferente de extrairMetadadosArtigo(), não aciona Jina/Chrome/Translate nem
 * tenta extrair todo o texto da reportagem. Assim podemos consultar algumas
 * fontes do Google News em paralelo sem transformar o botão "Trocar imagem"
 * em uma operação demorada.
 */
async function extrairMetadadosImagemArtigo(url) {
  const urlReal = await resolverUrlNoticia(url);
  if (!urlPublicaParaChrome(urlReal)) return null;

  try {
    const res = await axios.get(urlReal, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      timeout: 12000,
      maxRedirects: 4,
      maxContentLength: 4_000_000,
      beforeRedirect: (options) => {
        const destino = `${options.protocol || 'https:'}//${options.hostname || ''}${options.path || '/'}`;
        if (!urlPublicaParaChrome(destino)) throw new Error('redirecionamento para URL não pública');
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (contentType && !/html|xhtml/.test(contentType)) return null;

    const html = String(res.data || '');
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || urlReal;
    if (!urlPublicaParaChrome(finalUrl)) return null;

    const imagem = extrairImagemCapa(html, finalUrl);
    if (!imagem || !urlPublicaParaChrome(imagem)) return null;

    return {
      url: finalUrl,
      titulo:
        extrairMeta(html, 'og:title') ||
        decodificarHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') ||
        null,
      imagem,
      veiculo:
        extrairMeta(html, 'og:site_name') ||
        (() => {
          try {
            return new URL(finalUrl).hostname.replace(/^www\./i, '');
          } catch {
            return null;
          }
        })(),
    };
  } catch (err) {
    const status = Number(err.response?.status || 0);
    // Portal que bloqueia requisição simples (403/401/429) ainda abre no Chrome
    // — é o mesmo caminho que já lê o TEXTO da reportagem. Sem este resgate a
    // matéria saía sem a foto do site.
    if ([401, 403, 405, 406, 429].includes(status)) {
      const viaChrome = await capaViaChrome(urlReal);
      if (viaChrome) return viaChrome;
    }
    console.warn('[imagem-editorial]', status || err.message);
    return null;
  }
}

/**
 * Última tentativa de capa: abre a página no Chrome, que passa pelos bloqueios
 * que derrubam a leitura direta, e tira a og:image do HTML já renderizado.
 */
async function capaViaChrome(urlReal) {
  try {
    const lido = await carregarHtmlViaChrome(urlReal, { timeoutMs: 15_000 });
    if (!lido?.html) return null;

    const imagem = extrairImagemCapa(lido.html, lido.finalUrl);
    if (!imagem || !urlPublicaParaChrome(imagem)) return null;

    console.info(`[imagem-editorial] capa recuperada pelo Chrome: ${lido.finalUrl}`);
    return {
      url: lido.finalUrl,
      titulo:
        extrairMeta(lido.html, 'og:title') ||
        decodificarHtml(lido.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') ||
        null,
      imagem,
      veiculo:
        extrairMeta(lido.html, 'og:site_name') ||
        (() => {
          try {
            return new URL(lido.finalUrl).hostname.replace(/^www\./i, '');
          } catch {
            return null;
          }
        })(),
    };
  } catch (err) {
    console.warn('[imagem-editorial] chrome:', err.message);
    return null;
  }
}

function tokensTitulo(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function pontuarTitulo(reference, candidate) {
  const expected = new Set(tokensTitulo(reference));
  const actual = new Set(tokensTitulo(candidate));
  if (!expected.size || !actual.size) return 0;
  let common = 0;
  for (const word of expected) if (actual.has(word)) common += 1;
  if (common < Math.min(3, expected.size)) return 0;
  return common / expected.size;
}

function ordenarFontesPorTitulo(titulo, candidates) {
  return candidates
    .map((item) => ({ ...item, score: pontuarTitulo(titulo, item.titulo) }))
    .filter((item) => item.score >= 0.45 && urlValida(item.url))
    .sort((a, b) => b.score - a.score)
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .slice(0, 5);
}

async function buscarFontesPorTitulo(titulo) {
  const { env } = require('../config/env');
  // Serper free: evita caracteres estranhos e queries muito longas
  const q = String(titulo || '')
    .replace(/[^\p{L}\p{N}\s\-.:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (q.length < 10) return [];

  let candidates = [];

  if (env.braveSearchApiKey) {
    try {
      const { data } = await axios.get('https://api.search.brave.com/res/v1/news/search', {
        params: { q, count: 8, country: 'BR', search_lang: 'pt-br' },
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': env.braveSearchApiKey,
        },
        timeout: 15000,
      });
      candidates = (data?.results || []).map((item) => ({
        titulo: item.title,
        url: item.url,
        snippet: item.description || '',
      }));
    } catch (err) {
      console.warn('buscarFontesPorTitulo Brave:', err.response?.data?.message || err.message);
    }
  }

  let ranked = ordenarFontesPorTitulo(titulo, candidates);

  // Alguns sites/posts não entram no índice "news"; tenta busca web comum antes de Serper.
  if (!ranked.length && env.braveSearchApiKey) {
    try {
      const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q, count: 8, country: 'BR', search_lang: 'pt-br' },
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': env.braveSearchApiKey,
        },
        timeout: 15000,
      });
      const webCandidates = (data?.web?.results || []).map((item) => ({
        titulo: item.title,
        url: item.url,
        snippet: item.description || '',
      }));
      ranked = ordenarFontesPorTitulo(titulo, webCandidates);
    } catch (err) {
      console.warn('buscarFontesPorTitulo BraveWeb:', err.response?.data?.message || err.message);
    }
  }

  // Fallback gratuito: Google News RSS. Evita depender do Serper quando Brave não retorna.
  if (!ranked.length) {
    try {
      const { buscarGoogleNewsRss } = require('./newsResearch');
      const rss = await buscarGoogleNewsRss(q, { when: '365d' });
      const rssCandidates = (rss || []).map((item) => ({
        titulo: item.titulo,
        url: item.link,
        snippet: item.resumo || '',
      }));
      ranked = ordenarFontesPorTitulo(titulo, rssCandidates);
    } catch (err) {
      console.warn('buscarFontesPorTitulo GoogleNews:', err.message);
    }
  }

  // Evita spam de 400 no Serper free (rate limit / query rejeitada)
  if (!buscarFontesPorTitulo._serperCooldownUntil) {
    buscarFontesPorTitulo._serperCooldownUntil = 0;
  }
  const providerHealth = require('./providerHealth');
  const serperOk =
    Date.now() >= buscarFontesPorTitulo._serperCooldownUntil &&
    !providerHealth.estaFora('serper');

  if (!ranked.length && env.serperApiKey && serperOk) {
    try {
      const { data } = await axios.post(
        'https://google.serper.dev/search',
        { q, num: 8, gl: 'br', hl: 'pt-br' },
        {
          headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      candidates = (data?.organic || []).map((item) => ({
        titulo: item.title,
        url: item.link,
        snippet: item.snippet || '',
      }));
      ranked = ordenarFontesPorTitulo(titulo, candidates);
    } catch (err) {
      const status = err.response?.status;
      const message = String(err.response?.data?.message || err.message || '');
      if (/not enough credits/i.test(message)) {
        buscarFontesPorTitulo._serperCooldownUntil = Date.now() + 6 * 60 * 60_000;
      } else if (status === 400 || status === 429 || status === 402) {
        buscarFontesPorTitulo._serperCooldownUntil = Date.now() + 10 * 60_000;
      }
      providerHealth.registrarFalha('serper', message);
      console.warn(
        'buscarFontesPorTitulo Serper:',
        message
      );
    }
  }

  return ranked;
}

function normalizarUrlChave(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '')
      .split(/[?#]/)[0]
      .replace(/\/$/, '')
      .toLowerCase();
  }
}

function hostDaUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Busca na internet (Brave/Serper) e extrai trechos reais de 1–3 páginas
 * relacionadas ao fato — para complementar a matéria sem inventar.
 */
async function coletarFontesComplementares({ titulo, resumo, linkExcluir = null, max = 3 } = {}) {
  const queryBase = String(titulo || '').trim();
  const queryExtra = String(resumo || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const query = queryBase || queryExtra;
  if (!query || query.length < 12) return [];

  let ranked = await buscarFontesPorTitulo(query);
  if (!ranked.length && queryExtra && queryExtra !== queryBase) {
    const again = await buscarFontesPorTitulo(`${queryBase} ${queryExtra}`.trim().slice(0, 180));
    ranked = again;
  }

  const excluirUrls = new Set();
  const excluirHosts = new Set();
  if (linkExcluir) {
    excluirUrls.add(normalizarUrlChave(linkExcluir));
    const h = hostDaUrl(linkExcluir);
    if (h) excluirHosts.add(h);
  }

  const out = [];
  const vistos = new Set();

  for (const fonte of ranked) {
    if (out.length >= max) break;
    const urlKey = normalizarUrlChave(fonte.url);
    if (!urlKey || vistos.has(urlKey) || excluirUrls.has(urlKey)) continue;

    const host = hostDaUrl(fonte.url);
    if (
      /instagram\.com|facebook\.com|fb\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|youtu\.be/i.test(
        host
      )
    ) {
      continue;
    }
    // Evita o mesmo site da fonte original (queremos ângulo complementar)
    if (excluirHosts.has(host) && excluirUrls.size) {
      /* ainda permite se for o único candidato bom — não pula aqui */
    }

    vistos.add(urlKey);
    let meta = null;
    try {
      meta = await extrairMetadadosArtigo(fonte.url);
    } catch (err) {
      console.warn('coletarFontesComplementares:', err.message);
    }

    const trecho = String(meta?.trecho || '').trim();
    const resumoMeta = String(meta?.resumo || fonte.snippet || '').trim();
    if (!trecho && resumoMeta.length < 40) continue;

    out.push({
      veiculo: meta?.veiculo || host || 'Web',
      url: meta?.url || fonte.url,
      titulo: meta?.titulo || fonte.titulo || query,
      resumo: resumoMeta.slice(0, 500),
      trecho: trecho.slice(0, 2500) || resumoMeta.slice(0, 800),
      dataPublicacao: meta?.dataPublicacao || null,
      dataTimestamp: Number(meta?.dataTimestamp) || 0,
      origemBusca: true,
      score: fonte.score || 0,
    });
  }

  return out;
}

function mesclarFontesApuracao(existentes, novas) {
  const out = [];
  const vistos = new Set();
  for (const f of [...(existentes || []), ...(novas || [])]) {
    if (!f) continue;
    const key = normalizarUrlChave(f.url) || `${f.veiculo}|${f.titulo}`.toLowerCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    out.push(f);
  }
  return out.slice(0, 6);
}

/**
 * Enriquece um tópico com corpo da fonte + busca web complementar.
 */
async function apurarTopico(topico) {
  const base = { ...topico };
  const linkOriginal = base.link || null;
  const ehRedeSocial = Boolean(base.redeSocial || base.tipoFonte === 'rede_social');
  const jaSocial =
    ehRedeSocial && String(base.contextoApuracao || base.resumo || '').length > 40;

  // Post FB/IG já extraído: mantém o texto original e COMPLEMENTA com busca na web.
  if (jaSocial) {
    let fontes = Array.isArray(base.fontesApuracao) ? [...base.fontesApuracao] : [];
    if (!fontes.length && (base.contextoApuracao || base.resumo)) {
      fontes.push({
        veiculo: base.fonte || base.veiculo || 'Rede social',
        url: linkOriginal,
        titulo: base.titulo,
        resumo: base.resumo || '',
        trecho: String(base.contextoApuracao || base.resumo || '').slice(0, 3500),
        ehRedeSocial: true,
      });
    }

    try {
      const complementares = await coletarFontesComplementares({
        titulo: base.titulo,
        resumo: base.resumo || String(base.contextoApuracao || '').slice(0, 160),
        linkExcluir: linkOriginal,
        max: 3,
      });
      fontes = mesclarFontesApuracao(fontes, complementares);
    } catch (err) {
      console.warn('apurarTopico (social) busca web:', err.message);
    }

    // Se a URL original for artigo web (compartilhado na rede), puxa capa + autor
    let imagemFonte = base.imagemFonte || null;
    let autor = base.autor || null;
    let veiculo = base.veiculo || base.fonte || null;
    const linkPareceArtigo =
      linkOriginal &&
      /^https?:\/\//i.test(linkOriginal) &&
      !/(?:instagram|facebook|fb\.watch|tiktok|youtube|youtu\.be)\./i.test(linkOriginal);
    if (linkPareceArtigo && (!imagemFonte || !autor)) {
      try {
        const metaSocial = await extrairMetadadosArtigo(linkOriginal);
        if (metaSocial?.imagem && !imagemFonte) imagemFonte = metaSocial.imagem;
        if (metaSocial?.autor && !autor) autor = metaSocial.autor;
        if (metaSocial?.veiculo) veiculo = metaSocial.veiculo;
      } catch (err) {
        console.warn('apurarTopico (social) meta artigo:', err.message);
      }
    }

    const blocoWeb = fontes
      .filter((f) => f.origemBusca)
      .map(
        (f, i) =>
          `Fonte web ${i + 1} (${f.veiculo}): ${f.titulo || ''}\n${String(f.trecho || f.resumo || '').slice(0, 1200)}`
      )
      .join('\n\n');

    const contexto = [
      String(base.contextoApuracao || '').trim(),
      autor ? `Autor da matéria: ${autor}` : null,
      blocoWeb
        ? `Complemento factual encontrado na internet (use só o que estiver documentado abaixo):\n${blocoWeb}`
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      ...base,
      linkOriginal,
      link: base.link || linkOriginal,
      titulo: base.titulo || null,
      resumo: base.resumo || null,
      imagemFonte,
      autor,
      contextoApuracao: contexto || base.contextoApuracao,
      fontesApuracao: fontes,
      dataReferencia: base.data || null,
      veiculo,
      redeSocial: true,
      tipoFonte: 'rede_social',
    };
  }

  let meta = null;

  if (linkOriginal?.includes('news.google.com')) {
    const urlResolvida = await resolverUrlNoticia(linkOriginal);
    if (urlResolvida) {
      meta = await extrairMetadadosArtigo(urlResolvida);
    } else if (base.titulo) {
      const fontes = await buscarFontesPorTitulo(base.titulo);
      const melhorScore = fontes[0]?.score || 0;
      for (const fonte of fontes.filter((item) => item.score >= melhorScore - 0.15)) {
        const candidate = await extrairMetadadosArtigo(fonte.url);
        if (!meta) meta = candidate;
        if (candidate?.imagem) {
          meta = candidate;
          break;
        }
      }
    }
  } else if (linkOriginal) {
    meta = await extrairMetadadosArtigo(linkOriginal);
  }

  const veiculoMetaEditorial =
    meta?.veiculo && meta.veiculo !== meta.veiculoHost ? meta.veiculo : null;
  const veiculoPrincipal =
    veiculoMetaEditorial || base.veiculo || base.fonte || meta?.veiculo || null;

  const fontesApuracao = [];
  if (meta?.trecho || meta?.resumo) {
    fontesApuracao.push({
      veiculo: veiculoPrincipal || 'Fonte',
      url: meta.url || linkOriginal,
      titulo: meta.titulo || base.titulo,
      resumo: meta.resumo || base.resumo || '',
      trecho: meta.trecho || '',
      ehRedeSocial: Boolean(base.redeSocial),
    });
  }

  // Complementa com outras reportagens sobre o mesmo fato
  try {
    const complementares = await coletarFontesComplementares({
      titulo: meta?.titulo || base.titulo,
      resumo: meta?.resumo || base.resumo,
      linkExcluir: meta?.url || linkOriginal,
      max: fontesApuracao.length ? 2 : 3,
    });
    for (const f of complementares) {
      fontesApuracao.push(f);
    }
  } catch (err) {
    console.warn('apurarTopico busca web:', err.message);
  }

  // Sem link: ainda tenta montar apuração só com busca
  if (!fontesApuracao.length && base.titulo) {
    try {
      const soBusca = await coletarFontesComplementares({
        titulo: base.titulo,
        resumo: base.resumo,
        max: 3,
      });
      fontesApuracao.push(...soBusca);
    } catch (err) {
      console.warn('apurarTopico busca sem link:', err.message);
    }
  }

  const blocoComplementar = fontesApuracao
    .filter((f) => f.origemBusca)
    .map(
      (f, i) =>
        `Fonte complementar ${i + 1} (${f.veiculo}): ${f.titulo || ''}\n${String(f.trecho || f.resumo || '').slice(0, 1200)}`
    )
    .join('\n\n');

  const contextoNovo = [
    `Assunto: ${base.titulo || meta?.titulo || ''}`,
    base.resumo ? `Resumo inicial: ${base.resumo}` : null,
    meta?.trecho ? `Trechos documentados da fonte principal:\n${meta.trecho.slice(0, 3500)}` : null,
    veiculoPrincipal ? `Veículo: ${veiculoPrincipal}` : null,
    meta?.autor ? `Autor da matéria: ${meta.autor}` : null,
    meta?.url ? `URL: ${meta.url}` : null,
    blocoComplementar
      ? `Outras fontes na internet (só use fatos documentados):\n${blocoComplementar}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const contextoBase = String(base.contextoApuracao || '');
  const fontesFinais = fontesApuracao.length
    ? mesclarFontesApuracao(fontesApuracao, base.fontesApuracao)
    : Array.isArray(base.fontesApuracao)
      ? base.fontesApuracao
      : [];

  return {
    ...base,
    titulo: meta?.titulo || base.titulo || null,
    resumo: meta?.resumo || base.resumo || null,
    linkOriginal,
    link: meta?.url || linkOriginal,
    imagemFonte: meta?.imagem || base.imagemFonte || null,
    contextoApuracao: contextoBase.length > contextoNovo.length ? contextoBase : contextoNovo,
    fontesApuracao: fontesFinais,
    dataReferencia: base.data || null,
    veiculo: veiculoPrincipal,
    autor: meta?.autor || base.autor || null,
  };
}

module.exports = {
  decodificarHtml,
  apurarTopico,
  extrairMetadadosArtigo,
  extrairMetadadosImagemArtigo,
  extrairMetadadosViaJina,
  extrairMetadadosViaGoogleTranslate,
  extrairMetadadosViaChrome,
  extrairMetadadosViaClaudeWebFetch,
  carregarHtmlViaChrome,
  urlProxyGoogleTranslate,
  extrairImagemCapa,
  imagemServeDeCapa,
  resolverUrlNoticia,
  buscarFontesPorTitulo,
  coletarFontesComplementares,
};
