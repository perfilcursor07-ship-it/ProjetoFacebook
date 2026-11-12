require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function habilitado(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'mysql://root:@localhost:3306/clipador',
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  /** deepseek | claude | token-free — quem escreve as materias. */
  aiProvider: String(process.env.AI_PROVIDER || 'deepseek').toLowerCase(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  /** Modelo caro: so a redacao da materia. */
  claudeWriterModel: process.env.CLAUDE_WRITER_MODEL || 'claude-sonnet-5',
  /** Modelo barato: titulo, hashtags, resumo, classificacao, memoria de estilo. */
  claudeAuxModel: process.env.CLAUDE_AUX_MODEL || 'claude-haiku-4-5',
  /** token-free-gateway local, compativel com a API da OpenAI. */
  tokenFreeGateway: {
    baseUrl: process.env.TOKEN_FREE_GATEWAY_BASE_URL || 'http://127.0.0.1:3456/v1',
    apiKey: process.env.TOKEN_FREE_GATEWAY_API_KEY || process.env.TFG_API_KEY || 'qualquer-coisa',
    model: process.env.TOKEN_FREE_GATEWAY_MODEL || 'claude-sonnet-5',
    timeoutMs: Number(process.env.TOKEN_FREE_GATEWAY_TIMEOUT_MS) || 330_000,
  },
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  /** deepseek-v4-flash | deepseek-v4-pro | deepseek-chat (legado) */
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  /**
   * A redação da matéria é do Claude agora; o que sobrou na DeepSeek são passes
   * curtos e auxiliares, que não justificam o v4-pro. Padrão = flash.
   */
  deepseekWriterModel:
    process.env.DEEPSEEK_WRITER_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  pexelsApiKey: process.env.PEXELS_API_KEY || '',
  // Desligados por padrão: chaves esgotadas/403 estavam atrasando toda busca.
  // Reative explicitamente somente depois de validar saldo e funcionamento.
  braveSearchApiKey: habilitado('SEARCH_ENABLE_BRAVE')
    ? process.env.BRAVE_SEARCH_API_KEY || ''
    : '',
  // Brave Images é independente da pesquisa jornalística. A mesma chave
  // continua disponível no botão "Trocar imagem", mesmo com Brave News off.
  braveImageApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  serperApiKey: habilitado('SEARCH_ENABLE_SERPER')
    ? process.env.SERPER_API_KEY || ''
    : '',
  /** SerpApi (serpapi.com) — Google Images para sugestões de capa */
  serpApiKey: process.env.SERPAPI_API_KEY || '',
  facebook: {
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    redirectUri:
      process.env.FACEBOOK_REDIRECT_URI ||
      'http://localhost:3000/api/auth/facebook/callback',
  },
  postpulse: {
    clientId: process.env.POSTPULSE_CLIENT_ID || '',
    clientSecret: process.env.POSTPULSE_CLIENT_SECRET || '',
    redirectUri:
      process.env.POSTPULSE_REDIRECT_URI ||
      'http://localhost:3000/api/auth/postpulse/callback',
    /**
     * auto | postiz | ayrshare | postsyncer | postpulse | facebook
     * auto: Postiz (se key) → Ayrshare (se key) → PostSyncer → PostPulse → Graph API
     */
    // Defina ayrshare explicitamente quando a tela de páginas for gerenciada por esse provedor.
    publishProvider: (process.env.PUBLISH_PROVIDER || 'auto').toLowerCase(),
  },
  postsyncer: {
    apiKey: process.env.POSTSYNCER_API_KEY || '',
    workspaceId: process.env.POSTSYNCER_WORKSPACE_ID
      ? Number(process.env.POSTSYNCER_WORKSPACE_ID)
      : null,
  },
  /** Ayrshare — publicação social (Primary Profile API Key) */
  ayrshare: {
    apiKey: process.env.AYRSHARE_API_KEY || '',
    // A Ayrshare exige as credenciais próprias do app X para toda operação no X/Twitter.
    twitterApiKey: process.env.AYRSHARE_X_API_KEY || '',
    twitterApiSecret: process.env.AYRSHARE_X_API_SECRET || '',
  },
  /** Postiz Cloud — https://platform.postiz.com → Settings → API */
  postiz: {
    apiKey: process.env.POSTIZ_API_KEY || '',
    apiBase: String(process.env.POSTIZ_API_BASE || 'https://api.postiz.com/public/v1').replace(/\/$/, ''),
  },
  /** URL pública do app (opcional; útil para mídia https) */
  appPublicUrl: String(process.env.APP_PUBLIC_URL || '').replace(/\/$/, ''),
  brightdataApiToken: process.env.BRIGHTDATA_API_TOKEN || '',
  scrapeCreatorsApiKey: habilitado('SEARCH_ENABLE_SCRAPECREATORS')
    ? process.env.SCRAPECREATORS_API_KEY || ''
    : '',
  /** ElevenLabs — narração humanizada para Reels (imagem + voz) */
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  /**
   * Voice ID de My Voices (https://elevenlabs.io/app/voice-lab).
   * Vazio = o app escolhe automaticamente uma voz da conta.
   * Plano Free: NÃO use Voice Library — só My Voices / defaults da conta.
   */
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
  /** Apify — Radar Face (Trends + posts públicos FB) */
  apifyToken: process.env.APIFY_TOKEN || '',
  apifyIgPostActor:
    process.env.APIFY_IG_POST_ACTOR || 'apify/instagram-scraper',
  apifyFbSearchActor:
    process.env.APIFY_FB_SEARCH_ACTOR || 'scrapeforge/facebook-search-posts',
  /** Actor para posts de UMA página/perfil (não busca por keyword) */
  apifyFbPageActor:
    process.env.APIFY_FB_PAGE_ACTOR || 'scrapeforge/facebook-posts-scraper',
  /** UID de localização Facebook (opcional) para filtrar geo no actor */
  apifyFbLocationUid: process.env.APIFY_FB_LOCATION_UID || '',
  ffmpegPath: process.env.FFMPEG_PATH || '',
  pythonPath: process.env.PYTHON_PATH || '',
  storagePath: process.env.STORAGE_PATH || './storage',
  ytDlp: {
    cookiesFile: process.env.YTDLP_COOKIES_FILE || '',
    /** Cookies Netscape do Instagram (recomendado para scan/download de perfis) */
    igCookiesFile:
      process.env.YTDLP_IG_COOKIES_FILE ||
      process.env.INSTAGRAM_COOKIES_FILE ||
      (require('fs').existsSync('/home/viralizeai/secrets/instagram-cookies.txt')
        ? '/home/viralizeai/secrets/instagram-cookies.txt'
        : ''),
    /** Cookies Netscape do Facebook (posts que exigem login no servidor) */
    fbCookiesFile:
      process.env.YTDLP_FB_COOKIES_FILE ||
      process.env.FACEBOOK_COOKIES_FILE ||
      (require('fs').existsSync('/home/viralizeai/secrets/facebook-cookies.txt')
        ? '/home/viralizeai/secrets/facebook-cookies.txt'
        : ''),
    cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
    /** ex.: node  |  node:/usr/local/bin/node  |  deno */
    jsRuntime: process.env.YTDLP_JS_RUNTIME || '',
    /** caminho do binário node/deno (opcional) */
    jsRuntimePath: process.env.YTDLP_JS_RUNTIME_PATH || '',
  },
  /**
   * Limites de tempo da transcrição de vídeo (ms). Sem eles, um yt-dlp ou um
   * Whisper travado deixava o chat parado em "transcrevendo…" para sempre.
   */
  transcricao: {
    legendasMs: Number(process.env.TRANSCRICAO_LEGENDAS_TIMEOUT_MS) || 90_000,
    inspecaoMs: Number(process.env.TRANSCRICAO_INSPECAO_TIMEOUT_MS) || 60_000,
    downloadMs: Number(process.env.TRANSCRICAO_DOWNLOAD_TIMEOUT_MS) || 300_000,
    audioMs: Number(process.env.TRANSCRICAO_AUDIO_TIMEOUT_MS) || 180_000,
    whisperMs: Number(process.env.TRANSCRICAO_WHISPER_TIMEOUT_MS) || 600_000,
    /** `base` + beam 1 é várias vezes mais rápido na CPU e suficiente para apuração. */
    whisperModel: String(process.env.TRANSCRICAO_WHISPER_MODEL || 'base').trim(),
    whisperBeamSize: Math.max(1, Math.min(5, Number(process.env.TRANSCRICAO_WHISPER_BEAM_SIZE) || 1)),
    /** Reels curtos precisam de mais precisão para nomes próprios e falas políticas. */
    whisperAccurateModel: String(
      process.env.TRANSCRICAO_WHISPER_ACCURATE_MODEL || 'small'
    ).trim(),
    whisperAccurateBeamSize: Math.max(
      1,
      Math.min(5, Number(process.env.TRANSCRICAO_WHISPER_ACCURATE_BEAM_SIZE) || 3)
    ),
    /** Whisper "small" na CPU: rodar vários ao mesmo tempo trava o servidor. */
    concorrencia: Math.max(1, Number(process.env.TRANSCRICAO_CONCORRENCIA) || 1),
    /** Espera máxima na fila antes de desistir. */
    filaMs: Number(process.env.TRANSCRICAO_FILA_TIMEOUT_MS) || 600_000,
    /** Teto do processo inteiro quando o pedido vem do chat de matérias. */
    totalChatMs: Number(process.env.TRANSCRICAO_TOTAL_TIMEOUT_MS) || 720_000,
  },
};

module.exports = { env, required };
