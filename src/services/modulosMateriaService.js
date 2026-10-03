/**
 * Quais módulos da área "Matérias" cada usuário enxerga e pode abrir.
 *
 * Fonte única da verdade: o menu, o bloqueio de rota e a tela do administrador
 * leem esta mesma lista. Acrescentar um módulo aqui o faz aparecer nos três
 * lugares de uma vez — e esquecer de bloquear a rota deixa de ser possível.
 *
 * Administrador nunca é barrado: ele é quem configura.
 */

/** `rotas` são os prefixos que o bloqueio usa; a primeira é o link do menu. */
const MODULOS = Object.freeze([
  {
    id: 'chat-materia',
    nome: 'Chat Matéria',
    descricao: 'Escrever matéria conversando com a IA',
    rotas: ['/materia-manual'],
  },
  {
    id: 'furos',
    nome: 'Furos do dia',
    descricao: 'O que está bombando no nicho',
    rotas: ['/furos'],
  },
  {
    id: 'dots',
    nome: 'Agentes Dots',
    descricao: 'Agentes que trabalham sozinhos',
    rotas: ['/dots'],
  },
  {
    id: 'materias-salvas',
    nome: 'Matérias salvas',
    descricao: 'Rascunhos, agendadas e publicadas',
    rotas: ['/minhas-materias', '/materias-ia'],
  },
  {
    id: 'descobrir-pautas',
    nome: 'Descobrir pautas',
    descricao: 'Sites de onde as pautas saem',
    rotas: ['/configuracoes/descobrir-pautas'],
  },
  {
    id: 'feed-sugerido',
    nome: 'Feed sugerido',
    descricao: 'Instagram, YouTube e Facebook monitorados',
    rotas: ['/configuracoes/feed-sugerido'],
  },
  {
    id: 'piloto',
    nome: 'Piloto automático',
    descricao: 'Fila que publica sozinha',
    rotas: ['/piloto-automatico'],
  },
]);

const IDS = new Set(MODULOS.map((m) => m.id));

function ehAdministrador(usuario) {
  return String(usuario?.nivel_acesso || '') === 'administrador';
}

/**
 * Lista liberada para o usuário.
 *
 * Coluna nula = nunca configurado = tudo liberado, para que o deploy não tire
 * acesso de quem já usava. Lista vazia é escolha explícita do administrador.
 */
function permitidos(usuario) {
  if (ehAdministrador(usuario)) return MODULOS.map((m) => m.id);

  const bruto = usuario?.modulos_materia;
  if (bruto === null || bruto === undefined || bruto === '') return MODULOS.map((m) => m.id);

  let lista = bruto;
  if (typeof bruto === 'string') {
    try {
      lista = JSON.parse(bruto);
    } catch {
      return MODULOS.map((m) => m.id);
    }
  }
  if (!Array.isArray(lista)) return MODULOS.map((m) => m.id);
  return lista.map((id) => String(id)).filter((id) => IDS.has(id));
}

/** O usuário pode abrir este módulo? */
function podeAcessar(usuario, moduloId) {
  if (ehAdministrador(usuario)) return true;
  return permitidos(usuario).includes(String(moduloId));
}

/** Guarda só ids conhecidos; o formulário pode vir adulterado. */
function sanear(entrada) {
  const bruto = Array.isArray(entrada) ? entrada : entrada ? [entrada] : [];
  const limpos = [...new Set(bruto.map((v) => String(v)).filter((v) => IDS.has(v)))];
  return JSON.stringify(limpos);
}

/** Módulo dono desta URL, ou null quando a rota não pertence a nenhum. */
function moduloDaRota(caminho) {
  const url = String(caminho || '').split('?')[0];
  for (const modulo of MODULOS) {
    for (const rota of modulo.rotas) {
      if (url === rota || url.startsWith(`${rota}/`)) return modulo;
    }
  }
  return null;
}

/**
 * Bloqueio de rota. Sem isto o usuário sem permissão ainda abriria o módulo
 * digitando a URL — esconder do menu não é controle de acesso.
 */
function requireModulo(req, res, next) {
  const modulo = moduloDaRota(req.path);
  if (!modulo) return next();
  if (podeAcessar(req.user || res.locals.user, modulo.id)) return next();

  const erro = `Você não tem acesso a ${modulo.nome}. Fale com o administrador.`;
  return res.redirect(`/dashboard?error=${encodeURIComponent(erro)}`);
}

module.exports = {
  MODULOS,
  permitidos,
  podeAcessar,
  sanear,
  moduloDaRota,
  requireModulo,
};
