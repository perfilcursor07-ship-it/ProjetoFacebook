const axios = require('axios');

/**
 * Portais do nicho (gospel e política) lidos direto pelo feed RSS ou pela API
 * pública do WordPress. Complementa o Google News com links diretos, foto e
 * data, sem navegador e sem VNC.
 *
 * Proteção de carga: cada portal é lido no máximo uma vez a cada CACHE_MS,
 * com no máximo LEITURAS_SIMULTANEAS ao mesmo tempo, tempo limite curto e
 * tamanho máximo de resposta. O piloto automático que varre a cada 5 minutos
 * reaproveita o cache em vez de bater nos sites de novo.
 */

const CACHE_MS = 10 * 60 * 1000;
const ERRO_CACHE_MS = 3 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const LEITURAS_SIMULTANEAS = 8;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ITENS_POR_PORTAL = 40;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * `nichos`: ids de furosService.NICHOS. Um portal só entra na busca quando
 * algum nicho escolhido está na lista dele.
 * `tipo`: 'rss' (feed) ou 'wp' (API do WordPress, para quem bloqueia o feed).
 * `especializado`: portal só do nicho gospel. As notícias dele valem para o
 * nicho mesmo sem a palavra-chave no título; nos portais gerais, precisam citar.
 * `internacional`: portal cristão em outro idioma. Só entra a notícia que
 * citar o nicho ou a palavra-chave (título ou resumo); sem isso a lista se
 * encheria de manchetes em inglês.
 * `base`: rota da API do WordPress quando as notícias não são "posts".
 * Portal que bloqueia robôs (ex.: Comunhão responde 403) fica de fora.
 */
const PORTAIS = Object.freeze([
  { id: 'guiame', nome: 'Guiame', tipo: 'rss', url: 'https://guiame.com.br/rss', especializado: true, nichos: ['igreja', 'pastores', 'gospel', 'politica-fe', 'israel'] },
  { id: 'fuxicogospel', nome: 'O Fuxico Gospel', tipo: 'wp', url: 'https://www.fuxicogospel.com.br', especializado: true, nichos: ['gospel', 'pastores', 'igreja'] },
  { id: 'gospelprime', nome: 'Gospel Prime', tipo: 'wp', url: 'https://www.gospelprime.com.br', especializado: true, nichos: ['igreja', 'pastores', 'politica-fe', 'israel', 'gospel'] },
  { id: 'gospelmais', nome: 'Gospel Mais', tipo: 'rss', url: 'https://noticias.gospelmais.com.br/feed', especializado: true, nichos: ['gospel', 'igreja', 'pastores', 'politica-fe'] },
  { id: 'folhagospel', nome: 'Folha Gospel', tipo: 'rss', url: 'https://folhagospel.com/feed/', especializado: true, nichos: ['gospel', 'igreja', 'pastores'] },
  { id: 'pleno', nome: 'Pleno News', tipo: 'rss', url: 'https://pleno.news/feed', nichos: ['politica', 'politica-fe', 'igreja', 'pastores', 'israel'] },
  { id: 'conexaopolitica', nome: 'Conexão Política', tipo: 'rss', url: 'https://conexaopolitica.com.br/feed/', nichos: ['politica', 'politica-fe'] },
  { id: 'revistaoeste', nome: 'Revista Oeste', tipo: 'rss', url: 'https://revistaoeste.com/feed/', nichos: ['politica', 'politica-fe'] },
  { id: 'gazetadopovo', nome: 'Gazeta do Povo', tipo: 'rss', url: 'https://www.gazetadopovo.com.br/feed/rss/ultimas-noticias.xml', nichos: ['politica', 'politica-fe', 'igreja', 'catolicos'] },
  { id: 'poder360', nome: 'Poder360', tipo: 'rss', url: 'https://www.poder360.com.br/feed/', nichos: ['politica'] },
  { id: 'cnnbrasil', nome: 'CNN Brasil', tipo: 'rss', url: 'https://www.cnnbrasil.com.br/feed/', nichos: ['politica', 'policia'] },
  { id: 'metropoles', nome: 'Metrópoles', tipo: 'rss', url: 'https://www.metropoles.com/feed', nichos: ['politica', 'policia'] },
  { id: 'terrabrasil', nome: 'Terra Brasil Notícias', tipo: 'rss', url: 'https://www.terrabrasilnoticias.com/feed/', nichos: ['politica', 'politica-fe'] },
  // Portais cristãos brasileiros
  { id: 'portasabertas', nome: 'Portas Abertas', tipo: 'wp', url: 'https://portasabertas.org.br', base: 'noticias', especializado: true, nichos: ['israel', 'igreja'] },
  { id: 'adventistas', nome: 'Notícias Adventistas', tipo: 'rss', url: 'https://noticias.adventistas.org/pt/feed/', especializado: true, nichos: ['igreja', 'pastores'] },
  { id: 'cpadnews', nome: 'CPAD News', tipo: 'rss', url: 'https://www.cpadnews.com.br/feed/', especializado: true, nichos: ['igreja', 'pastores', 'gospel', 'israel'] },
  { id: 'goodprime', nome: 'Good Prime', tipo: 'rss', url: 'https://goodprime.co/feed/', especializado: true, nichos: ['igreja', 'pastores'] },
  { id: 'aliancaevangelica', nome: 'Aliança Evangélica', tipo: 'rss', url: 'https://aliancaevangelica.org.br/feed/', especializado: true, nichos: ['igreja', 'politica-fe'] },
  { id: 'comoouvirao', nome: 'Como Ouvirão', tipo: 'rss', url: 'https://comoouvirao.com.br/feed/', especializado: true, nichos: ['igreja'] },
  { id: 'hinologia', nome: 'Hinologia Cristã', tipo: 'rss', url: 'http://www.hinologia.org/feed/', especializado: true, nichos: ['gospel', 'igreja'] },
  { id: 'mariosergio', nome: 'Mario Sérgio História', tipo: 'rss', url: 'https://mariosergiohistoria.blogspot.com/feeds/posts/default?alt=rss', especializado: true, nichos: ['igreja', 'pastores'] },
  { id: 'novotempo', nome: 'Novo Tempo', tipo: 'rss', url: 'https://www.novotempo.com/feed/', especializado: true, nichos: ['igreja', 'pastores'] },
  { id: 'universal', nome: 'Universal.org', tipo: 'rss', url: 'https://www.universal.org/noticias/feed/', especializado: true, nichos: ['igreja', 'pastores'] },
  // Portais católicos
  { id: 'cancaonova', nome: 'Canção Nova', tipo: 'rss', url: 'https://noticias.cancaonova.com/feed/', especializado: true, nichos: ['catolicos', 'igreja'] },
  { id: 'vaticannews', nome: 'Vatican News', tipo: 'rss', url: 'https://www.vaticannews.va/pt.rss.xml', especializado: true, nichos: ['catolicos', 'israel'] },
  { id: 'cnbb', nome: 'CNBB', tipo: 'rss', url: 'https://www.cnbb.org.br/feed/', especializado: true, nichos: ['catolicos', 'igreja'] },
  { id: 'gaudiumpress', nome: 'Gaudium Press', tipo: 'rss', url: 'https://gaudiumpress.org/feed/', especializado: true, nichos: ['catolicos'] },
  // Portais gerais brasileiros: a notícia precisa citar o nicho no título
  { id: 'g1', nome: 'g1', tipo: 'rss', url: 'https://g1.globo.com/rss/g1/', nichos: ['politica', 'policia'] },
  { id: 'g1tocantins', nome: 'g1 Tocantins', tipo: 'rss', url: 'https://g1.globo.com/rss/g1/to/tocantins/', nichos: ['politica', 'policia'] },
  { id: 'revistaforum', nome: 'Revista Fórum', tipo: 'rss', url: 'https://revistaforum.com.br/feed/', nichos: ['politica', 'politica-fe'] },
  { id: 'claudiodantas', nome: 'Claudio Dantas', tipo: 'rss', url: 'https://claudiodantas.com.br/feed/', nichos: ['politica', 'politica-fe'] },
  { id: 'brasilparalelo', nome: 'Brasil Paralelo', tipo: 'rss', url: 'https://www.brasilparalelo.com.br/noticias/rss.xml', nichos: ['politica', 'politica-fe'] },
  { id: 'istoe', nome: 'IstoÉ', tipo: 'rss', url: 'https://istoe.com.br/feed/', nichos: ['politica', 'policia'] },
  { id: 'sonoticiaboa', nome: 'Só Notícia Boa', tipo: 'rss', url: 'https://www.sonoticiaboa.com.br/feed/', nichos: ['igreja', 'pastores', 'catolicos'] },
  { id: 'folha', nome: 'Folha de S.Paulo', tipo: 'rss', url: 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml', nichos: ['politica', 'policia'] },
  { id: 'bbcbrasil', nome: 'BBC News Brasil', tipo: 'rss', url: 'https://feeds.bbci.co.uk/portuguese/rss.xml', nichos: ['politica', 'policia', 'israel'] },
  { id: 'veja', nome: 'Veja', tipo: 'rss', url: 'https://veja.abril.com.br/feed/', nichos: ['politica', 'policia'] },
  { id: 'oantagonista', nome: 'O Antagonista', tipo: 'rss', url: 'https://www.oantagonista.com.br/feed/', nichos: ['politica', 'politica-fe'] },
  { id: 'jovempan', nome: 'Jovem Pan', tipo: 'rss', url: 'https://jovempan.com.br/feed', nichos: ['politica', 'policia'] },
  { id: 'agenciabrasil', nome: 'Agência Brasil', tipo: 'rss', url: 'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml', nichos: ['politica'] },
  { id: 'sbtnews', nome: 'SBT News', tipo: 'rss', url: 'https://sbtnews.sbt.com.br/rss.xml', nichos: ['politica', 'policia'] },
  { id: 'diariodopoder', nome: 'Diário do Poder', tipo: 'rss', url: 'https://diariodopoder.com.br/feed', nichos: ['politica', 'politica-fe'] },
  { id: 'cartacapital', nome: 'Carta Capital', tipo: 'rss', url: 'https://www.cartacapital.com.br/feed/', nichos: ['politica'] },
  { id: 'conjur', nome: 'Consultor Jurídico', tipo: 'rss', url: 'https://www.conjur.com.br/rss.xml', nichos: ['policia', 'politica'] },
  // Portais cristãos internacionais
  { id: 'christiandaily', nome: 'Christian Daily', tipo: 'rss', url: 'https://www.christiandaily.com/rss.xml', especializado: true, internacional: true, nichos: ['israel', 'igreja', 'pastores', 'politica-fe'] },
  { id: 'christianpost', nome: 'The Christian Post', tipo: 'rss', url: 'https://www.christianpost.com/rss', especializado: true, internacional: true, nichos: ['israel', 'igreja', 'pastores', 'politica-fe'] },
  { id: 'christianitytoday', nome: 'Christianity Today', tipo: 'wp', url: 'https://www.christianitytoday.com', especializado: true, internacional: true, nichos: ['israel', 'igreja', 'pastores'] },
  { id: 'charisma', nome: 'Charisma News', tipo: 'rss', url: 'https://mycharisma.com/category/news/feed/', especializado: true, internacional: true, nichos: ['israel', 'igreja', 'pastores', 'politica-fe'] },
  { id: 'persecution', nome: 'International Christian Concern', tipo: 'rss', url: 'https://persecution.org/feed/', especializado: true, internacional: true, nichos: ['israel'] },
  { id: 'faithwire', nome: 'Faithwire', tipo: 'wp', url: 'https://www.faithwire.com', especializado: true, internacional: true, nichos: ['israel', 'igreja', 'pastores'] },
  { id: 'lifesitenews', nome: 'LifeSiteNews', tipo: 'rss', url: 'https://www.lifesitenews.com/feed/', especializado: true, internacional: true, nichos: ['catolicos', 'politica-fe', 'israel'] },
  { id: 'baptistnews', nome: 'Baptist News Global', tipo: 'rss', url: 'https://baptistnews.com/feed/', especializado: true, internacional: true, nichos: ['igreja', 'pastores'] },
  { id: 'churchleaders', nome: 'ChurchLeaders', tipo: 'rss', url: 'https://churchleaders.com/feed', especializado: true, internacional: true, nichos: ['igreja', 'pastores'] },
  { id: 'roysreport', nome: 'The Roys Report', tipo: 'rss', url: 'https://roysreport.com/feed/', especializado: true, internacional: true, nichos: ['igreja', 'pastores'] },
  { id: 'relevant', nome: 'Relevant Magazine', tipo: 'rss', url: 'https://relevantmagazine.com/feed/', especializado: true, internacional: true, nichos: ['igreja', 'gospel'] },
  { id: 'crosswalk', nome: 'Crosswalk', tipo: 'rss', url: 'https://www.crosswalk.com/rss/', especializado: true, internacional: true, nichos: ['igreja'] },
  { id: 'lifewayresearch', nome: 'Lifeway Research', tipo: 'rss', url: 'https://research.lifeway.com/feed/', especializado: true, internacional: true, nichos: ['igreja', 'pastores'] },
]);

const cache = new Map();
const emAndamento = new Map();
let ativos = 0;
const fila = [];

function comVaga(tarefa) {
  return new Promise((resolve, reject) => {
    const rodar = () => {
      ativos += 1;
      Promise.resolve()
        .then(tarefa)
        .then(resolve, reject)
        .finally(() => {
          ativos -= 1;
          fila.shift()?.();
        });
    };
    if (ativos < LEITURAS_SIMULTANEAS) rodar();
    else fila.push(rodar);
  });
}

function decodificar(texto) {
  return String(texto || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function semHtml(texto) {
  return decodificar(texto).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rodapés que o WordPress e os portais põem no resumo do feed ("Leia a
 * matéria completa em Gospelmais", "O post … apareceu primeiro em …"). Eles
 * citam o nome do portal e faziam a notícia parecer do nicho errado.
 */
function semRodapeDoFeed(texto) {
  return String(texto || '')
    .replace(/\s*(leia (a matéria|mais|o texto) completa?( em)?|continue lendo( em)?)\b[\s\S]*$/i, '')
    .replace(/\s*(o post|the post)\b[\s\S]*?(apareceu primeiro em|appeared first on)[\s\S]*$/i, '')
    .replace(/\s*\[(…|\.\.\.)\]\s*$/, '')
    .trim();
}

function tag(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${nome}>`, 'i'));
  return m ? m[1] : '';
}

function urlValida(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function imagemDoItemRss(bloco) {
  const candidatos = [
    bloco.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*>/i)?.[1],
    bloco.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1],
    bloco.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i)?.[1],
    bloco.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i)?.[1],
    decodificar(tag(bloco, 'content:encoded') || tag(bloco, 'description')).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1],
  ];
  return candidatos.map((url) => decodificar(url || '').trim()).find(urlValida) || null;
}

function lerRss(xml, portal) {
  const blocos = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocos.slice(0, MAX_ITENS_POR_PORTAL).map((bloco) => {
    const data = semHtml(tag(bloco, 'pubDate') || tag(bloco, 'dc:date'));
    return {
      titulo: semHtml(tag(bloco, 'title')).slice(0, 300),
      link: semHtml(tag(bloco, 'link')) || semHtml(tag(bloco, 'guid')),
      resumo: semRodapeDoFeed(semHtml(tag(bloco, 'description'))).slice(0, 400),
      data: data || null,
      dataTimestamp: Date.parse(data) || null,
      imagem: imagemDoItemRss(bloco),
      veiculo: portal.nome,
    };
  });
}

function lerWordPress(posts, portal) {
  return (Array.isArray(posts) ? posts : []).slice(0, MAX_ITENS_POR_PORTAL).map((post) => {
    const data = post?.date_gmt ? `${post.date_gmt}Z` : post?.date || null;
    const imagem =
      post?.jetpack_featured_media_url ||
      post?.yoast_head_json?.og_image?.[0]?.url ||
      post?._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
      null;
    return {
      titulo: semHtml(post?.title?.rendered).slice(0, 300),
      link: String(post?.link || '').trim(),
      resumo: semRodapeDoFeed(semHtml(post?.excerpt?.rendered)).slice(0, 400),
      data,
      dataTimestamp: Date.parse(data) || null,
      imagem: urlValida(imagem) ? imagem : null,
      veiculo: portal.nome,
    };
  });
}

async function baixarPortal(portal) {
  const wp = portal.tipo === 'wp';
  const url = wp
    ? `${portal.url}/wp-json/wp/v2/${portal.base || 'posts'}?per_page=25&_fields=title,link,date,date_gmt,excerpt,jetpack_featured_media_url,yoast_head_json.og_image`
    : portal.url;
  const { data } = await axios.get(url, {
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    maxRedirects: 3,
    responseType: wp ? 'json' : 'text',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: wp ? 'application/json' : 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
    },
  });
  const itens = (wp ? lerWordPress(data, portal) : lerRss(data, portal))
    .filter((item) => item.titulo && urlValida(item.link));
  if (!itens.length) throw new Error('feed sem itens');
  return itens;
}

/** Lê um portal respeitando cache e limite de leituras simultâneas. */
async function lerPortal(portal) {
  const guardado = cache.get(portal.id);
  if (guardado && guardado.expiraEm > Date.now()) return guardado;
  if (emAndamento.has(portal.id)) return emAndamento.get(portal.id);

  const leitura = comVaga(async () => {
    const inicio = Date.now();
    try {
      const itens = await baixarPortal(portal);
      return { itens, erro: null, lidoEm: Date.now(), ms: Date.now() - inicio, expiraEm: Date.now() + CACHE_MS };
    } catch (err) {
      // Portal fora do ar: guarda o erro por pouco tempo para não insistir a cada busca.
      const anterior = cache.get(portal.id);
      return {
        itens: anterior?.itens || [],
        erro: err.response?.status ? `HTTP ${err.response.status}` : err.code || err.message,
        lidoEm: Date.now(),
        ms: Date.now() - inicio,
        expiraEm: Date.now() + ERRO_CACHE_MS,
      };
    }
  }).then((resultado) => {
    cache.set(portal.id, resultado);
    if (resultado.erro) console.warn(`[portais] ${portal.nome}: ${resultado.erro}`);
    return resultado;
  }).finally(() => emAndamento.delete(portal.id));

  emAndamento.set(portal.id, leitura);
  return leitura;
}

function portaisDosNichos(idsNichos) {
  const alvo = new Set(idsNichos || []);
  return PORTAIS.filter((portal) => portal.nichos.some((id) => alvo.has(id)));
}

/**
 * Itens recentes dos portais ligados aos nichos, com o id do portal.
 * Nunca lança erro: portal que falha só não contribui.
 */
async function buscarNosPortais({ nichos = [], horas = 24 } = {}) {
  const portais = portaisDosNichos(nichos);
  const limite = Date.now() - Number(horas || 24) * 3_600_000;
  const leituras = await Promise.all(portais.map((portal) => lerPortal(portal).then((r) => ({ portal, ...r }))));
  const itens = [];
  const status = [];
  for (const { portal, itens: lista, erro, ms } of leituras) {
    const recentes = lista.filter((item) => item.dataTimestamp && item.dataTimestamp >= limite);
    status.push({ id: portal.id, nome: portal.nome, itens: recentes.length, erro, ms });
    for (const item of recentes) {
      itens.push({ ...item, portal: portal.id, portalNichos: portal.nichos, especializado: Boolean(portal.especializado), internacional: Boolean(portal.internacional) });
    }
  }
  return { itens, status };
}

/** Situação de cada portal (para o administrador acompanhar). */
async function statusDosPortais() {
  const leituras = await Promise.all(PORTAIS.map((portal) => lerPortal(portal).then((r) => ({ portal, ...r }))));
  return leituras.map(({ portal, itens, erro, lidoEm, ms }) => ({
    id: portal.id,
    nome: portal.nome,
    tipo: portal.tipo,
    nichos: portal.nichos,
    itens: itens.length,
    erro,
    lidoEm: new Date(lidoEm).toISOString(),
    ms,
  }));
}

module.exports = {
  PORTAIS,
  buscarNosPortais,
  statusDosPortais,
  lerRss,
  lerWordPress,
};
