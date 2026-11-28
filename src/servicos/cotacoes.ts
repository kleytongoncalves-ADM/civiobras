/**
 * Cotação de materiais com fornecedores. A solicitação nasce de um orçamento,
 * cada fornecedor responde por um link próprio e o resultado é apurado por um
 * critério definido antes do envio. O orçamento só é lido, nunca alterado.
 */
import { createHash, createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra, pool, type Contexto } from "../lib/db";
import { dec, lerValorBr, texto, ZERO, type Regra } from "../lib/decimal";
import {
  apurar, comparar, compararAutomatico, PESOS_PADRAO, validarPesos, FATORES,
  type Apuracao, type AvaliacaoC, type Comparacao, type Criterio, type Mapa, type MaterialC, type Pesos, type PropostaC,
} from "./cotacao-calculo";
import { cnpjValido, salvarEmpresa } from "./contratos";
import type { Ator } from "./obras";
import { curvaAbcInsumos, rotuloOrcamento } from "./orcamentos";
import { avisarConvidados, avisarMudanca, avisarPropostaRecebida } from "./avisos-cotacao";
import { envioAutomatico } from "./comunicacao";
import { exigir, pode, SemPermissao } from "./permissoes";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string | null | undefined): v is string => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const limpo = (v: string | null | undefined, max = 500) => { const t = (v ?? "").trim().slice(0, max); return t === "" ? null : t; };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const soDigitos = (v: string) => v.replace(/\D/g, "");

export type SituacaoSolicitacao = "rascunho" | "aberta" | "encerrada" | "apurada" | "cancelada";
export const ROTULO_SITUACAO_COTACAO: Record<SituacaoSolicitacao, string> = {
  rascunho: "Em elaboração", aberta: "Aberta", encerrada: "Encerrada", apurada: "Apurada", cancelada: "Cancelada",
};
export type SituacaoConvite = "convidado" | "abriu" | "preenchendo" | "respondeu" | "declinou" | "nao_respondeu";
export const ROTULO_CONVITE: Record<SituacaoConvite, string> = {
  convidado: "Convidado", abriu: "Abriu o link", preenchendo: "Preenchendo", respondeu: "Respondeu", declinou: "Declinou", nao_respondeu: "Não respondeu",
};
export const PASSOS = ["Montar", "Convidar", "Receber", "Encerrar", "Apurar"] as const;
export const passoAtual = (s: SituacaoSolicitacao, convites: number) =>
  s === "rascunho" ? (convites ? 1 : 0) : s === "aberta" ? 2 : s === "encerrada" ? 4 : s === "apurada" ? 5 : -1;

// ---------------------------------------------------------------------------
// Link do fornecedor
// ---------------------------------------------------------------------------
/**
 * O link é calculado a partir de um segredo do servidor, e o banco guarda só o
 * resumo dele. Assim a tela consegue mostrar o link de novo sem que ele fique gravado.
 */
function segredo() {
  const s = process.env.COTACAO_SEGREDO || process.env.DATABASE_URL;
  if (!s) throw new Error("Segredo do link de cotação não configurado.");
  return createHash("sha256").update(`cotacao-link:${s}`).digest();
}
/** Chave para guardar credenciais de integração (WhatsApp) cifradas no banco. */
export const chaveDeCredenciais = () => createHash("sha256").update(`credenciais:${process.env.CHAVE_CREDENCIAIS || process.env.COTACAO_SEGREDO || process.env.DATABASE_URL}`).digest();
export const tokenDoConvite = (conviteId: string, serie: number) => createHmac("sha256", segredo()).update(`${conviteId}:${serie}`).digest("base64url");
export const caminhoDoLink = (token: string) => `/cotacao/${token}`;
/** Chave das tarefas agendadas (lembrete de prazo). A tarefa do Netlify calcula a mesma a partir das mesmas variáveis. */
export const chaveDeTarefa = (nome: string) => createHmac("sha256", segredo()).update(`tarefa:${nome}`).digest("hex");
/** Link compartilhado da solicitação, o mesmo para todos os fornecedores. */
export const tokenAberto = (solicitacaoId: string, serie: number) => createHmac("sha256", segredo()).update(`aberto:${solicitacaoId}:${serie}`).digest("base64url");
export const caminhoAberto = (token: string) => `/convite/${token}`;

function visivel(a: Ator, n: number) {
  if (pode(a, "obra.ver_todas")) return { sql: "true", params: [] as unknown[] };
  return {
    sql: `exists (select 1 from vinculo_obra v where v.obra_id = s.obra_id and v.usuario_id = $${n} and (v.fim is null or v.fim >= hoje_local()))`,
    params: [a.id],
  };
}

export async function evento(c: PoolClient, orgaoId: string, solicitacaoId: string, tipo: string, resumo: string,
  extra: { conviteId?: string | null; detalhe?: unknown; rede?: string | null; usuarioId?: string | null } = {}) {
  await c.query(
    "insert into evento_cotacao (orgao_id, solicitacao_id, convite_id, tipo, resumo, detalhe, rede, usuario_id) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [orgaoId, solicitacaoId, extra.conviteId ?? null, tipo, resumo, extra.detalhe == null ? null : JSON.stringify(extra.detalhe), limpo(extra.rede, 80), extra.usuarioId ?? null]);
}

/** Encerra o recebimento das solicitações cujo prazo venceu. O banco já recusa proposta fora do prazo. */
export async function encerrarVencidas(orgaoId: string) {
  await comContexto({ usuarioId: null, orgaoId }, async (c) => {
    const r = await c.query(
      "update solicitacao_cotacao set situacao = 'encerrada', encerrada_em = prazo where situacao = 'aberta' and prazo < now() returning id");
    for (const l of r.rows) await evento(c, orgaoId, l.id, "encerramento", "Recebimento encerrado no prazo");
  });
}

// ---------------------------------------------------------------------------
// Materiais do orçamento
// ---------------------------------------------------------------------------
export type MaterialDoOrcamento = {
  chave: string; fonte: string; codigo: string; descricao: string; unidade: string; quantidade: string; preco: string | null; valor: string;
  classe: "A" | "B" | "C"; semSinapi: boolean; jaCotado: boolean;
};

/** Materiais do orçamento somados por código: a mesma conta da curva ABC de insumos. */
export async function materiaisDoOrcamento(a: Ator, orcamentoId: string) {
  exigir(a, "cotacao.ver");
  const { orcamento, linhas } = await curvaAbcInsumos(a, orcamentoId);
  const cotados = await comContexto(ctx(a), async (c) => new Set((await c.query(
    `select distinct m.fonte || '|' || m.codigo || '|' || m.descricao as k from solicitacao_material m join solicitacao_cotacao s on s.id = m.solicitacao_id
      where s.orcamento_id = $1 and s.situacao <> 'cancelada'`, [orcamentoId])).rows.map((l) => l.k as string)));
  const materiais = linhas.filter((l) => l.tipo === "material" && Number(l.quantidade) > 0).map((l): MaterialDoOrcamento => {
    const semSinapi = l.codigo === "COT" || l.fonte === "cotacao";
    return {
      chave: semSinapi ? `COT|${l.descricao}` : `${l.fonte}|${l.codigo}`, fonte: l.fonte, codigo: l.codigo, descricao: l.descricao, unidade: l.unidade,
      quantidade: l.quantidade, preco: l.preco, valor: l.valor, classe: l.classe, semSinapi, jaCotado: cotados.has(`${l.fonte}|${l.codigo}|${l.descricao}`),
    };
  });
  return { orcamento, materiais };
}

// ---------------------------------------------------------------------------
// Criação e montagem
// ---------------------------------------------------------------------------
export type DadosSolicitacao = {
  titulo: string; prazo: string; localEntrega?: string | null; freteIncluso?: boolean; validadeMinima?: string | null; observacao?: string | null;
  criterio: Criterio; pesos?: Partial<Pesos>; sigilo?: boolean; chaves: string[];
};

/** Data e hora digitadas no horário de Brasília. */
function lerPrazo(v: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v.trim());
  const d = m ? new Date(`${m[1]}T${m[2]}:00-03:00`) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new ErroDeRegra("Informe o prazo de resposta com data e hora.");
  if (d.getTime() <= Date.now()) throw new ErroDeRegra("O prazo de resposta precisa estar no futuro.");
  return d;
}
function lerInteiro(v: string | null | undefined, rotulo: string, min: number, max: number): number | null {
  const t = (v ?? "").trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t) || Number(t) < min || Number(t) > max) throw new ErroDeRegra(`${rotulo}: informe um número inteiro de ${min} a ${max}.`);
  return Number(t);
}
function lerPesos(criterio: Criterio, p?: Partial<Pesos>): Pesos {
  if (criterio !== "custo_beneficio") return PESOS_PADRAO;
  const pesos = Object.fromEntries(FATORES.map((k) => [k, Number(p?.[k] ?? 0)])) as Pesos;
  const erro = validarPesos(pesos);
  if (erro) throw new ErroDeRegra(erro);
  return pesos;
}

export async function criarSolicitacao(a: Ator, orcamentoId: string, d: DadosSolicitacao): Promise<string> {
  exigir(a, "cotacao.solicitar");
  if (!d.titulo.trim()) throw new ErroDeRegra("Informe o título da solicitação.");
  if (!["item", "global", "custo_beneficio"].includes(d.criterio)) throw new ErroDeRegra("Escolha o critério de apuração.");
  const prazo = lerPrazo(d.prazo);
  const pesos = lerPesos(d.criterio, d.pesos);
  const validade = lerInteiro(d.validadeMinima, "Validade mínima da proposta", 1, 365);
  const { orcamento: o, materiais } = await materiaisDoOrcamento(a, orcamentoId);
  if (o.situacao === "cancelado") throw new ErroDeRegra("Orçamento cancelado não gera cotação.");
  const escolhidos = materiais.filter((m) => d.chaves.includes(m.chave));
  if (!escolhidos.length) throw new ErroDeRegra("Escolha ao menos um material.");
  return comContexto(ctx(a), async (c) => {
    const id = (await c.query(
      `insert into solicitacao_cotacao (orgao_id, obra_id, orcamento_id, titulo, prazo, local_entrega, frete_incluso, validade_minima, observacao,
                                        criterio, pesos, sigilo, fonte, uf, mes, regime, arredondamento)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [a.orgaoId, o.obraId, o.id, d.titulo.trim().slice(0, 160), prazo, limpo(d.localEntrega), d.freteIncluso ?? true, validade, limpo(d.observacao, 2000),
        d.criterio, JSON.stringify(pesos), d.sigilo ?? true, o.fonte, o.uf, `${o.mes}-01`, o.regime, o.arredondamento])).rows[0].id as string;
    let ordem = 0;
    for (const m of escolhidos) {
      ordem += 1;
      await c.query(
        `insert into solicitacao_material (orgao_id, solicitacao_id, ordem, fonte, codigo, descricao, unidade, quantidade, preco_referencia, sem_sinapi)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [a.orgaoId, id, ordem, m.fonte, m.codigo, m.descricao, m.unidade, m.quantidade, m.preco, m.semSinapi]);
    }
    await evento(c, a.orgaoId, id, "criacao", `Solicitação criada com ${escolhidos.length} ${escolhidos.length === 1 ? "material" : "materiais"}`, { usuarioId: a.id });
    return id;
  });
}

type Base = {
  id: string; obraId: string; obraCodigo: string; obraNome: string; orcamentoId: string; orcamentoNumero: number; orcamentoVersao: number; orcamentoNome: string;
  numero: number; titulo: string; prazo: Date; situacao: SituacaoSolicitacao; localEntrega: string | null; freteIncluso: boolean; validadeMinima: number | null;
  observacao: string | null; criterio: Criterio; pesos: Pesos; sigilo: boolean; fonte: string; uf: string; mes: string; regime: string; arredondamento: Regra;
  justificativaMinimo: string | null; enviadaEm: Date | null; enviadaPor: string | null; encerradaEm: Date | null; canceladaMotivo: string | null;
  criadoPor: string | null; criadoPorId: string | null; criadoEm: Date; versaoMaisNova: boolean;
};

const COLUNAS = `s.id, s.obra_id as "obraId", b.codigo as "obraCodigo", b.nome as "obraNome", s.orcamento_id as "orcamentoId",
  o.numero as "orcamentoNumero", o.versao as "orcamentoVersao", o.nome as "orcamentoNome", s.numero, s.titulo, s.prazo, s.situacao,
  s.local_entrega as "localEntrega", s.frete_incluso as "freteIncluso", s.validade_minima as "validadeMinima", s.observacao, s.criterio, s.pesos, s.sigilo,
  s.fonte, s.uf, to_char(s.mes, 'YYYY-MM') as mes, s.regime, s.arredondamento, s.justificativa_minimo as "justificativaMinimo",
  s.enviada_em as "enviadaEm", ue.nome as "enviadaPor", s.encerrada_em as "encerradaEm", s.cancelada_motivo as "canceladaMotivo",
  uc.nome as "criadoPor", s.criado_por as "criadoPorId", s.criado_em as "criadoEm",
  exists (select 1 from orcamento n where n.versao_anterior_id = o.id) as "versaoMaisNova"`;
const DE = `from solicitacao_cotacao s join obra b on b.id = s.obra_id join orcamento o on o.id = s.orcamento_id
  left join usuario ue on ue.id = s.enviada_por left join usuario uc on uc.id = s.criado_por`;

async function base(c: PoolClient, a: Ator, id: string): Promise<Base> {
  if (!uuid(id)) throw new ErroDeRegra("Solicitação não encontrada.");
  const v = visivel(a, 2);
  const r = await c.query(`select ${COLUNAS} ${DE} where s.id = $1 and ${v.sql}`, [id, ...v.params]);
  if (!r.rows[0]) throw new ErroDeRegra("Solicitação não encontrada ou fora do seu acesso.");
  return r.rows[0];
}

export type DadosConvite = {
  empresaId?: string | null; razaoSocial?: string; cnpj?: string; contato?: string | null; email?: string | null; telefone?: string | null; motivo?: string | null;
  origem?: "manual" | "email";
};

export async function adicionarConvite(a: Ator, id: string, d: DadosConvite): Promise<string> {
  const r = await gravarConvite(a, id, d);
  if (r.aberta) await avisarConvidados(a.orgaoId, [r.id]);
  return r.id;
}

async function gravarConvite(a: Ator, id: string, d: DadosConvite): Promise<{ id: string; aberta: boolean }> {
  exigir(a, "cotacao.solicitar");
  let empresaId = d.empresaId ?? null;
  if (!empresaId) {
    if (!d.razaoSocial?.trim() || !d.cnpj) throw new ErroDeRegra("Escolha um fornecedor ou informe razão social e CNPJ.");
    if (!cnpjValido(d.cnpj)) throw new ErroDeRegra("CNPJ inválido.");
    const existente = await comContexto(ctx(a), async (c) => (await c.query("select id from empresa where cnpj = $1", [soDigitos(d.cnpj!)])).rows[0]?.id as string | undefined);
    empresaId = existente ?? await salvarEmpresa({ ...a, administrador: true }, {
      razaoSocial: d.razaoSocial, cnpj: d.cnpj, tipo: "fornecedor", responsavel: d.contato ?? null, email: d.email ?? null, telefone: d.telefone ?? null,
    } as Parameters<typeof salvarEmpresa>[1]);
  }
  if (!uuid(empresaId)) throw new ErroDeRegra("Fornecedor não encontrado.");
  const email = limpo(d.email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroDeRegra("E-mail inválido.");
  return comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (!["rascunho", "aberta"].includes(s.situacao)) throw new ErroDeRegra("Só é possível convidar com a solicitação em elaboração ou aberta.");
    const e = (await c.query("select razao_social, responsavel, email, telefone, ativa from empresa where id = $1", [empresaId])).rows[0];
    if (!e) throw new ErroDeRegra("Fornecedor não encontrado.");
    if (!e.ativa) throw new ErroDeRegra("Este fornecedor está inativo.");
    if ((await c.query("select 1 from convite_cotacao where solicitacao_id = $1 and empresa_id = $2", [id, empresaId])).rowCount)
      throw new ErroDeRegra("Este fornecedor já foi convidado.");
    const destino = email ?? e.email;
    const cid = (await c.query(
      `insert into convite_cotacao (orgao_id, solicitacao_id, empresa_id, contato, email, telefone, motivo, enviado_em, origem, email_situacao)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [a.orgaoId, id, empresaId, limpo(d.contato, 120) ?? e.responsavel, destino, limpo(d.telefone, 40) ?? e.telefone, limpo(d.motivo, 300),
        s.situacao === "aberta" ? new Date() : null, d.origem ?? "manual", d.origem === "email" && destino ? "pendente" : null])).rows[0].id as string;
    if (s.situacao === "aberta") {
      await c.query("insert into cotacao_link (token_hash, orgao_id, convite_id) values ($1,$2,$3)", [sha(tokenDoConvite(cid, 1)), a.orgaoId, cid]);
      await evento(c, a.orgaoId, id, "convite", `Convite enviado a ${e.razao_social}`, { conviteId: cid, usuarioId: a.id });
    }
    return { id: cid, aberta: s.situacao === "aberta" };
  });
}

export type LinhaConvite = { empresa: string; email: string; cnpj: string };
export type ResultadoConvites = { criados: number; erros: Record<number, string>; emails: { enviados: number; falharam: number; semServico: boolean }; aberta: boolean };

/**
 * Fornecedor +: vários convites por e-mail de uma vez, com empresa, e-mail e CNPJ.
 * Tudo é conferido antes de gravar. Uma linha com problema não grava nenhuma.
 */
export async function convidarPorEmail(a: Ator, id: string, linhas: LinhaConvite[]): Promise<ResultadoConvites> {
  exigir(a, "cotacao.solicitar");
  const preenchidas = linhas.map((l, i) => ({ ...l, i })).filter((l) => l.empresa.trim() || l.email.trim() || l.cnpj.trim());
  if (!preenchidas.length) throw new ErroDeRegra("Preencha ao menos um fornecedor.");
  if (preenchidas.length > 50) throw new ErroDeRegra("Envie até 50 convites por vez.");
  const erros: Record<number, string> = {};
  const vistos = new Map<string, number>();
  const jaConvidados = await comContexto(ctx(a), async (c) => {
    await base(c, a, id);
    return new Set((await c.query("select e.cnpj from convite_cotacao cv join empresa e on e.id = cv.empresa_id where cv.solicitacao_id = $1", [id])).rows.map((r) => r.cnpj as string));
  });
  for (const l of preenchidas) {
    const cn = soDigitos(l.cnpj);
    if (!l.empresa.trim()) erros[l.i] = "Informe o nome da empresa.";
    else if (!cnpjValido(cn)) erros[l.i] = "CNPJ inválido.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email.trim())) erros[l.i] = "E-mail inválido.";
    else if (vistos.has(cn)) erros[l.i] = `CNPJ repetido na linha ${vistos.get(cn)! + 1}.`;
    else if (jaConvidados.has(cn)) erros[l.i] = "Esta empresa já foi convidada.";
    vistos.set(cn, l.i);
  }
  const automatico = !!(await comContexto(ctx(a), envioAutomatico)).email;
  if (Object.keys(erros).length) return { criados: 0, erros, emails: { enviados: 0, falharam: 0, semServico: !automatico }, aberta: false };
  const criados: string[] = [];
  let aberta = false;
  for (const l of preenchidas) {
    const r = await gravarConvite(a, id, { razaoSocial: l.empresa, cnpj: l.cnpj, email: l.email.trim(), origem: "email" });
    criados.push(r.id);
    aberta = r.aberta;
  }
  const emails = { enviados: 0, falharam: 0, semServico: !automatico };
  if (aberta) {
    for (const v of (await avisarConvidados(a.orgaoId, criados)).values()) {
      if (v === "enviado") emails.enviados += 1;
      if (v === "falhou") emails.falharam += 1;
    }
  }
  return { criados: criados.length, erros: {}, emails, aberta };
}

/** Manda de novo o e-mail do convite, com o link atual. */
export async function reenviarEmail(a: Ator, id: string, conviteId: string) {
  exigir(a, "cotacao.solicitar");
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "aberta") throw new ErroDeRegra("O e-mail só pode ser reenviado com a solicitação aberta.");
    const cv = (await c.query("select email from convite_cotacao where id = $1 and solicitacao_id = $2", [conviteId, id])).rows[0];
    if (!cv) throw new ErroDeRegra("Convite não encontrado.");
    if (!cv.email) throw new ErroDeRegra("Este convite não tem e-mail.");
  });
  if (!(await comContexto(ctx(a), envioAutomatico)).email) throw new ErroDeRegra("O envio automático de e-mail não está ligado. Use o botão E-mail para enviar pelo seu programa de e-mail.");
  const r = (await avisarConvidados(a.orgaoId, [conviteId])).get(conviteId);
  if (r !== "enviado") throw new ErroDeRegra("O e-mail não foi entregue ao serviço de envio. Confira o endereço ou copie o link.");
  await comContexto(ctx(a), (c) => evento(c, a.orgaoId, id, "email", "E-mail do convite reenviado", { conviteId, usuarioId: a.id }));
}

// ---------------------------------------------------------------------------
// Link compartilhado
// ---------------------------------------------------------------------------
/** Cria o link compartilhado da solicitação, ou troca o atual (o anterior para de funcionar). */
export async function gerarLinkAberto(a: Ator, id: string, trocar = false) {
  exigir(a, "cotacao.solicitar");
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (!["rascunho", "aberta"].includes(s.situacao)) throw new ErroDeRegra("O link só pode ser criado com a solicitação em elaboração ou aberta.");
    const atual = (await c.query("select serie from cotacao_link_aberto where solicitacao_id = $1 and revogado_em is null", [id])).rows[0];
    if (atual && !trocar) return;
    const serie = ((await c.query("select coalesce(max(serie), 0)::int as n from cotacao_link_aberto where solicitacao_id = $1", [id])).rows[0].n as number) + 1;
    await c.query("update cotacao_link_aberto set revogado_em = now() where solicitacao_id = $1 and revogado_em is null", [id]);
    await c.query("insert into cotacao_link_aberto (token_hash, orgao_id, solicitacao_id, serie) values ($1,$2,$3,$4)", [sha(tokenAberto(id, serie)), a.orgaoId, id, serie]);
    await evento(c, a.orgaoId, id, "link", atual ? "Link compartilhado trocado. O anterior parou de funcionar" : "Link compartilhado criado", { usuarioId: a.id });
  });
}

async function linkAbertoAtual(c: PoolClient, id: string) {
  const l = (await c.query("select serie from cotacao_link_aberto where solicitacao_id = $1 and revogado_em is null", [id])).rows[0];
  return l ? caminhoAberto(tokenAberto(id, l.serie)) : null;
}

/** Solicitação que o link compartilhado abre. Sem órgão no contexto: é por ele que se descobre o órgão. */
export async function solicitacaoDoLinkAberto(token: string, rede: string | null) {
  const falhou = frear(rede);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) { falhou(); return null; }
  const l = (await pool().query("select orgao_id, solicitacao_id, revogado_em from cotacao_link_aberto where token_hash = $1", [sha(token)])).rows[0];
  if (!l) { falhou(); return null; }
  return { orgaoId: l.orgao_id as string, solicitacaoId: l.solicitacao_id as string, revogado: !!l.revogado_em };
}

/** Fornecedores ativos ainda não convidados, com o retrospecto de convites e respostas. */
export async function fornecedoresDisponiveis(a: Ator, id: string) {
  exigir(a, "cotacao.solicitar");
  return comContexto(ctx(a), async (c) => (await c.query(
    `select e.id, e.razao_social as "razaoSocial", e.cnpj, e.tipo, e.email,
            (select count(*)::int from convite_cotacao cv join solicitacao_cotacao s on s.id = cv.solicitacao_id where cv.empresa_id = e.id and s.situacao <> 'rascunho') as convites,
            (select count(*)::int from convite_cotacao cv where cv.empresa_id = e.id and cv.situacao = 'respondeu') as respostas
       from empresa e
      where e.ativa and not exists (select 1 from convite_cotacao cv where cv.solicitacao_id = $1 and cv.empresa_id = e.id)
      order by (e.tipo = 'fornecedor') desc, e.razao_social`, [id])).rows as { id: string; razaoSocial: string; cnpj: string; tipo: string; email: string | null; convites: number; respostas: number }[]);
}

export async function removerConvite(a: Ator, id: string, conviteId: string) {
  exigir(a, "cotacao.solicitar");
  await comContexto(ctx(a), async (c) => {
    await base(c, a, id);
    await c.query("delete from convite_cotacao where id = $1 and solicitacao_id = $2", [conviteId, id]);
  });
}

export async function excluirRascunho(a: Ator, id: string) {
  exigir(a, "cotacao.solicitar");
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "rascunho") throw new ErroDeRegra("Solicitação enviada não pode ser excluída. Cancele com justificativa.");
    await c.query("delete from solicitacao_cotacao where id = $1", [id]);
  });
}

export async function enviarSolicitacao(a: Ator, id: string, justificativaMinimo?: string | null) {
  exigir(a, "cotacao.solicitar");
  const ids = await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "rascunho") throw new ErroDeRegra("Esta solicitação já foi enviada.");
    const convites = (await c.query(
      "select cv.id, e.razao_social from convite_cotacao cv join empresa e on e.id = cv.empresa_id where cv.solicitacao_id = $1", [id])).rows;
    const just = limpo(justificativaMinimo, 500);
    const comLink = !!(await linkAbertoAtual(c, id));
    if (!comLink && convites.length < 3 && (!just || just.length < 10)) throw new ErroDeRegra("Convide ao menos três fornecedores ou justifique o número menor.");
    await c.query("update solicitacao_cotacao set situacao = 'aberta', enviada_em = now(), enviada_por = $2, justificativa_minimo = $3 where id = $1",
      [id, a.id, convites.length < 3 ? just : null]);
    await evento(c, a.orgaoId, id, "envio", convites.length ? `Solicitação enviada a ${convites.length} ${convites.length === 1 ? "fornecedor" : "fornecedores"}${comLink ? " e aberta pelo link compartilhado" : ""}` : "Solicitação aberta pelo link compartilhado",
      { usuarioId: a.id, detalhe: { criterio: s.criterio, pesos: s.pesos, prazo: s.prazo, justificativa: convites.length < 3 ? just : null } });
    for (const cv of convites) {
      await c.query("update convite_cotacao set enviado_em = now() where id = $1", [cv.id]);
      await c.query("insert into cotacao_link (token_hash, orgao_id, convite_id) values ($1,$2,$3)", [sha(tokenDoConvite(cv.id, 1)), a.orgaoId, cv.id]);
      await evento(c, a.orgaoId, id, "convite", `Convite enviado a ${cv.razao_social}`, { conviteId: cv.id, usuarioId: a.id });
    }
    return convites.map((cv) => cv.id as string);
  });
  await avisarConvidados(a.orgaoId, ids);
}

export async function novoLink(a: Ator, id: string, conviteId: string) {
  exigir(a, "cotacao.solicitar");
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "aberta") throw new ErroDeRegra("O link só pode ser trocado com a solicitação aberta.");
    const cv = (await c.query(
      "select cv.serie, e.razao_social from convite_cotacao cv join empresa e on e.id = cv.empresa_id where cv.id = $1 and cv.solicitacao_id = $2", [conviteId, id])).rows[0];
    if (!cv) throw new ErroDeRegra("Convite não encontrado.");
    await c.query("update cotacao_link set revogado_em = now() where convite_id = $1 and revogado_em is null", [conviteId]);
    await c.query("update convite_cotacao set serie = serie + 1 where id = $1", [conviteId]);
    await c.query("insert into cotacao_link (token_hash, orgao_id, convite_id) values ($1,$2,$3)", [sha(tokenDoConvite(conviteId, cv.serie + 1)), a.orgaoId, conviteId]);
    await evento(c, a.orgaoId, id, "link", `Link anterior revogado e novo link gerado para ${cv.razao_social}`, { conviteId, usuarioId: a.id });
  });
}

const dataHora = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);

function justificar(v: string | null | undefined) {
  const j = limpo(v, 500);
  if (!j || j.length < 10) throw new ErroDeRegra("Escreva a justificativa, com ao menos 10 caracteres.");
  return j;
}

export async function prorrogar(a: Ator, id: string, novoPrazo: string, justificativa: string) {
  exigir(a, "cotacao.solicitar");
  const j = justificar(justificativa);
  const prazo = lerPrazo(novoPrazo);
  await encerrarVencidas(a.orgaoId);
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "aberta") throw new ErroDeRegra("Só uma solicitação aberta pode ser prorrogada. Depois do prazo, reabra.");
    if (prazo <= s.prazo) throw new ErroDeRegra("O novo prazo precisa ser posterior ao atual.");
    await c.query("update solicitacao_cotacao set prazo = $2 where id = $1", [id, prazo]);
    await evento(c, a.orgaoId, id, "prorrogacao", "Prazo prorrogado", { usuarioId: a.id, detalhe: { de: s.prazo, para: prazo, justificativa: j } });
    await avisarMudanca(c, id, "prorrogacao", `Prazo prorrogado: cotação nº ${String(s.numero).padStart(3, "0")}`, `${s.titulo} · novo prazo ${dataHora(prazo)}`);
  });
}

export async function reabrir(a: Ator, id: string, novoPrazo: string, justificativa: string) {
  exigir(a, "cotacao.solicitar");
  const j = justificar(justificativa);
  const prazo = lerPrazo(novoPrazo);
  await encerrarVencidas(a.orgaoId);
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (!["encerrada", "apurada"].includes(s.situacao)) throw new ErroDeRegra("Só uma solicitação encerrada ou apurada pode ser reaberta.");
    await c.query("update solicitacao_cotacao set situacao = 'aberta', prazo = $2, encerrada_em = null where id = $1", [id, prazo]);
    await evento(c, a.orgaoId, id, "reabertura", "Solicitação reaberta para todos os convidados", { usuarioId: a.id, detalhe: { de: s.prazo, para: prazo, justificativa: j } });
    await avisarMudanca(c, id, "reabertura", `Cotação nº ${String(s.numero).padStart(3, "0")} reaberta`, `${s.titulo} · responder até ${dataHora(prazo)}`);
  });
}

export async function cancelar(a: Ator, id: string, motivo: string) {
  exigir(a, "cotacao.solicitar");
  const j = justificar(motivo);
  await encerrarVencidas(a.orgaoId);
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (!["aberta", "encerrada"].includes(s.situacao)) throw new ErroDeRegra("Só uma solicitação aberta ou encerrada pode ser cancelada.");
    await c.query("update solicitacao_cotacao set situacao = 'cancelada', cancelada_motivo = $2 where id = $1", [id, j]);
    await c.query("update cotacao_link set revogado_em = now() where revogado_em is null and convite_id in (select id from convite_cotacao where solicitacao_id = $1)", [id]);
    await evento(c, a.orgaoId, id, "cancelamento", "Solicitação cancelada", { usuarioId: a.id, detalhe: { justificativa: j } });
    await c.query("update cotacao_link_aberto set revogado_em = now() where solicitacao_id = $1 and revogado_em is null", [id]);
    await avisarMudanca(c, id, "cancelamento", `Cotação nº ${String(s.numero).padStart(3, "0")} cancelada`, `${s.titulo} · ${j}`);
  });
}

/** Antes do prazo, só encerra quando todos os convidados já responderam ou declinaram. */
export async function encerrarAntes(a: Ator, id: string) {
  exigir(a, "cotacao.solicitar");
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "aberta") throw new ErroDeRegra("A solicitação não está aberta.");
    const falta = (await c.query("select count(*)::int as n from convite_cotacao where solicitacao_id = $1 and situacao not in ('respondeu', 'declinou')", [id])).rows[0].n;
    if (falta) throw new ErroDeRegra(`Ainda ${falta === 1 ? "falta 1 fornecedor" : `faltam ${falta} fornecedores`} responder. O encerramento antecipado exige todas as respostas.`);
    await c.query("update solicitacao_cotacao set situacao = 'encerrada', encerrada_em = now() where id = $1", [id]);
    await evento(c, a.orgaoId, id, "encerramento", "Recebimento encerrado antes do prazo, com todas as respostas", { usuarioId: a.id });
  });
}

// ---------------------------------------------------------------------------
// Proposta
// ---------------------------------------------------------------------------
export type ItemDigitado = { preco?: string; marca?: string; modelo?: string; observacao?: string; indisponivel?: boolean };
export type DadosProposta = {
  cnpj?: string; responsavelNome: string; responsavelCargo?: string; responsavelTelefone?: string;
  prazoEntrega?: string; validadeDias?: string; pagamentoDias?: string; condicaoPagamento?: string; frete?: string; garantiaMeses?: string;
  observacao?: string; documento?: string; itens: Record<string, ItemDigitado>;
};

type ItemGravar = { materialId: string; preco: string | null; marca: string | null; modelo: string | null; observacao: string | null; indisponivel: boolean };

function conferirProposta(d: DadosProposta, materiais: { id: string; codigo: string; descricao: string }[], validadeMinima: number | null) {
  const nome = limpo(d.responsavelNome, 120);
  if (!nome) throw new ErroDeRegra("Informe o nome de quem responde pela proposta.");
  const itens = materiais.map((m): ItemGravar => {
    const i = d.itens?.[m.id] ?? {};
    const rotulo = m.descricao.length > 50 ? `${m.descricao.slice(0, 50)}…` : m.descricao;
    if (i.indisponivel) return { materialId: m.id, preco: null, marca: null, modelo: null, observacao: limpo(i.observacao, 300), indisponivel: true };
    const p = lerValorBr(i.preco ?? "");
    if (p == null || p <= ZERO) throw new ErroDeRegra(`Informe o preço de "${rotulo}" ou marque o item como indisponível.`);
    if (p >= dec("10000000000")) throw new ErroDeRegra(`Preço de "${rotulo}" fora do limite.`);
    const marca = limpo(i.marca, 80);
    if (!marca) throw new ErroDeRegra(`Informe a marca ou fabricante de "${rotulo}".`);
    return { materialId: m.id, preco: texto(p, 4), marca, modelo: limpo(i.modelo, 80), observacao: limpo(i.observacao, 300), indisponivel: false };
  });
  if (!itens.some((i) => !i.indisponivel)) throw new ErroDeRegra("Informe o preço de ao menos um item.");
  const validade = lerInteiro(d.validadeDias, "Validade da proposta em dias", 1, 365);
  if (validadeMinima && (validade == null || validade < validadeMinima)) throw new ErroDeRegra(`A validade da proposta precisa ser de ao menos ${validadeMinima} dias.`);
  const frete = d.frete?.trim() ? lerValorBr(d.frete) : ZERO;
  if (frete == null || frete < ZERO) throw new ErroDeRegra("Frete inválido.");
  return {
    nome, cargo: limpo(d.responsavelCargo, 80), telefone: limpo(d.responsavelTelefone, 40), itens, validade,
    prazoEntrega: lerInteiro(d.prazoEntrega, "Prazo de entrega em dias", 0, 365), pagamentoDias: lerInteiro(d.pagamentoDias, "Prazo de pagamento em dias", 0, 365),
    condicao: limpo(d.condicaoPagamento, 160), frete: texto(frete), garantia: lerInteiro(d.garantiaMeses, "Garantia em meses", 0, 240),
    observacao: limpo(d.observacao, 1000), documento: limpo(d.documento, 200),
  };
}

async function gravarProposta(c: PoolClient, orgaoId: string, conviteId: string, solicitacaoId: string, p: ReturnType<typeof conferirProposta>,
  extra: { origem: "fornecedor" | "equipe"; rede?: string | null; lancadaPor?: string | null; fornecedor: string }) {
  const versao = ((await c.query("select coalesce(max(versao), 0)::int as v from proposta where convite_id = $1", [conviteId])).rows[0].v as number) + 1;
  const resumo = sha(JSON.stringify({ conviteId, versao, ...p }));
  const id = (await c.query(
    `insert into proposta (orgao_id, convite_id, versao, origem, responsavel_nome, responsavel_cargo, responsavel_telefone, prazo_entrega, validade_dias,
                           pagamento_dias, condicao_pagamento, frete, garantia_meses, observacao, documento, resumo, rede, lancada_por)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id, enviada_em`,
    [orgaoId, conviteId, versao, extra.origem, p.nome, p.cargo, p.telefone, p.prazoEntrega, p.validade, p.pagamentoDias, p.condicao, p.frete, p.garantia,
      p.observacao, p.documento, resumo, limpo(extra.rede, 80), extra.lancadaPor ?? null])).rows[0];
  for (const i of p.itens) {
    await c.query(
      "insert into proposta_item (orgao_id, proposta_id, material_id, preco_unitario, marca, modelo, observacao, indisponivel) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [orgaoId, id.id, i.materialId, i.preco, i.marca, i.modelo, i.observacao, i.indisponivel]);
    if (i.marca) await c.query("insert into marca (orgao_id, nome) values ($1, $2) on conflict do nothing", [orgaoId, i.marca]);
  }
  await c.query("update convite_cotacao set situacao = 'respondeu', rascunho = null, rascunho_em = null, declinou_em = null, declinou_motivo = null where id = $1", [conviteId]);
  await evento(c, orgaoId, solicitacaoId, "proposta",
    extra.origem === "equipe" ? `Proposta de ${extra.fornecedor} lançada pela equipe (versão ${versao})` : `${extra.fornecedor} enviou a proposta (versão ${versao})`,
    { conviteId, rede: extra.rede, usuarioId: extra.lancadaPor ?? null, detalhe: { versao, resumo, responsavel: p.nome, documento: p.documento } });
  return { versao, resumo, enviadaEm: id.enviada_em as Date, protocolo: protocolo(resumo, versao) };
}

export const protocolo = (resumo: string, versao: number) => `${resumo.slice(0, 4)}-${resumo.slice(4, 8)}-${resumo.slice(8, 12)}`.toUpperCase() + `/v${versao}`;

/** Proposta recebida por e-mail ou papel, digitada pela equipe com a referência do documento original. */
export async function lancarProposta(a: Ator, id: string, conviteId: string, d: DadosProposta) {
  exigir(a, "cotacao.solicitar");
  if (!limpo(d.documento)) throw new ErroDeRegra("Informe o documento de origem (e-mail, ofício ou protocolo) da proposta.");
  await encerrarVencidas(a.orgaoId);
  return comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "aberta") throw new ErroDeRegra("O prazo desta cotação terminou.");
    const cv = (await c.query(
      "select e.razao_social from convite_cotacao cv join empresa e on e.id = cv.empresa_id where cv.id = $1 and cv.solicitacao_id = $2", [conviteId, id])).rows[0];
    if (!cv) throw new ErroDeRegra("Convite não encontrado.");
    const materiais = (await c.query("select id, codigo, descricao from solicitacao_material where solicitacao_id = $1 order by ordem", [id])).rows;
    return gravarProposta(c, a.orgaoId, conviteId, id, conferirProposta(d, materiais, s.validadeMinima), { origem: "equipe", lancadaPor: a.id, fornecedor: cv.razao_social });
  });
}

// ---------------------------------------------------------------------------
// Leitura completa
// ---------------------------------------------------------------------------
export type Convite = {
  id: string; empresaId: string; razaoSocial: string; cnpj: string; contato: string | null; email: string | null; telefone: string | null; motivo: string | null;
  situacao: SituacaoConvite; enviadoEm: Date | null; abertoEm: Date | null; declinouEm: Date | null; declinouMotivo: string | null;
  respostaEm: Date | null; versao: number | null; origem: "fornecedor" | "equipe" | null; cotados: number | null; link: string | null; historico: number | null; naComparacao: boolean;
  /** Como o convite chegou: escrito pela equipe, por e-mail automático ou pelo link compartilhado. */
  via: "manual" | "email" | "link"; emailSituacao: "pendente" | "enviado" | "falhou" | "sem_servico" | null; emailEnviadoEm: Date | null; emailErro: string | null;
  contaId: string | null;
};
export type PropostaVigente = PropostaC & {
  id: string; versao: number; origem: "fornecedor" | "equipe"; responsavelNome: string; responsavelCargo: string | null; responsavelTelefone: string | null;
  validadeDias: number | null; condicaoPagamento: string | null; frete: string; observacao: string | null; documento: string | null; resumo: string;
  lancadaPor: string | null; cnpj: string;
};
export type VersaoProposta = { conviteId: string; fornecedor: string; versao: number; enviadaEm: Date; origem: string; responsavelNome: string; resumo: string; total: string | null; itens: number };
export type EventoCotacao = { id: string; tipo: string; resumo: string; detalhe: Record<string, unknown> | null; em: Date; usuario: string | null; fornecedor: string | null; rede: string | null };
export type ApuracaoGravada = {
  id: string; numero: number; criterio: Criterio; resultado: Apuracao; totalReferencia: string | null; totalResultado: string | null; economia: string | null;
  vencedorConviteId: string | null; escolhidoConviteId: string | null; justificativa: string | null; codigo: string; homologadaPor: string | null; homologadaEm: Date;
};
export type MaterialSolicitado = MaterialC & { ordem: number; fonte: string };
export type SolicitacaoCompleta = Base & {
  materiais: MaterialSolicitado[]; convites: Convite[]; precosVisiveis: boolean; propostas: PropostaVigente[]; avaliacoes: AvaliacaoC[];
  /** Propostas marcadas para a comparação e a apuração. `mapaTodos` inclui também as desmarcadas. */
  comparadas: PropostaVigente[]; mapaTodos: Mapa | null; podeEscolherComparadas: boolean;
  mapa: Mapa | null; comparacao: Comparacao | null; previa: Apuracao | null; apuracoes: ApuracaoGravada[]; versoes: VersaoProposta[]; eventos: EventoCotacao[];
  totalReferencia: string; podeSolicitar: boolean; podeApurar: boolean; podeHomologar: boolean; respondidas: number; pendentes: number; declinaram: number;
  /** Caminho do link compartilhado, para quem pode convidar. */
  linkAberto: string | null; emailAutomatico: boolean;
};

async function carregar(c: PoolClient, a: Ator | null, s: Base, opcoes: { comLinks?: boolean } = {}): Promise<SolicitacaoCompleta> {
  const id = s.id;
  const materiais = (await c.query(
    `select id, ordem, fonte, codigo, descricao, unidade, quantidade::text, preco_referencia::text as "precoReferencia", sem_sinapi as "semSinapi"
       from solicitacao_material where solicitacao_id = $1 order by ordem`, [id])).rows as MaterialSolicitado[];
  const precosVisiveis = s.situacao !== "rascunho" && !(s.sigilo && s.situacao === "aberta");
  const cv = (await c.query(
    `select cv.id, cv.empresa_id as "empresaId", e.razao_social as "razaoSocial", e.cnpj, cv.contato, cv.email, cv.telefone, cv.motivo, cv.situacao, cv.serie, cv.na_comparacao as "naComparacao",
            cv.enviado_em as "enviadoEm", cv.aberto_em as "abertoEm", cv.declinou_em as "declinouEm", cv.declinou_motivo as "declinouMotivo",
            cv.rascunho is not null as "temRascunho",
            (select avg(case when r.no_prazo then 100 else 0 end)::float8 from pedido p join recebimento r on r.pedido_id = p.id where p.empresa_id = cv.empresa_id) as historico,
            exists (select 1 from cotacao_link l where l.convite_id = cv.id and l.revogado_em is null) as "linkAtivo",
            cv.origem as via, cv.email_situacao as "emailSituacao", cv.email_enviado_em as "emailEnviadoEm", cv.email_erro as "emailErro",
            coalesce((select d.conta_id from convite_da_conta d where d.convite_id = cv.id), e.conta_fornecedor_id) as "contaId"
       from convite_cotacao cv join empresa e on e.id = cv.empresa_id where cv.solicitacao_id = $1 order by e.razao_social`, [id])).rows;
  const ps = (await c.query(
    `select p.id, p.convite_id as "conviteId", p.versao, p.origem, p.responsavel_nome as "responsavelNome", p.responsavel_cargo as "responsavelCargo",
            p.responsavel_telefone as "responsavelTelefone", p.prazo_entrega as "prazoEntrega", p.validade_dias as "validadeDias", p.pagamento_dias as "pagamentoDias",
            p.condicao_pagamento as "condicaoPagamento", p.frete::text, p.garantia_meses as "garantiaMeses", p.observacao, p.documento, p.resumo,
            p.enviada_em as "enviadaEm", u.nome as "lancadaPor",
            (select count(*)::int from proposta_item i where i.proposta_id = p.id and not i.indisponivel) as cotados,
            (select coalesce(sum(i.preco_unitario * m.quantidade), 0)::numeric(16,2)::text from proposta_item i join solicitacao_material m on m.id = i.material_id
              where i.proposta_id = p.id and not i.indisponivel) as bruto
       from proposta p join convite_cotacao cv on cv.id = p.convite_id left join usuario u on u.id = p.lancada_por
      where cv.solicitacao_id = $1 order by p.enviada_em`, [id])).rows;
  const ultima = new Map<string, (typeof ps)[number]>();
  for (const p of ps) ultima.set(p.conviteId, p);

  const comLinks = !!opcoes.comLinks && s.situacao === "aberta";
  const fim = ["encerrada", "apurada", "cancelada"].includes(s.situacao);
  const convites = cv.map((x): Convite => {
    const u = ultima.get(x.id);
    const situacao: SituacaoConvite = x.situacao === "respondeu" ? "respondeu" : x.situacao === "declinou" ? "declinou"
      : fim ? "nao_respondeu" : x.temRascunho ? "preenchendo" : x.situacao;
    return {
      id: x.id, empresaId: x.empresaId, razaoSocial: x.razaoSocial, cnpj: x.cnpj, contato: x.contato, email: x.email, telefone: x.telefone, motivo: x.motivo, situacao,
      enviadoEm: x.enviadoEm, abertoEm: x.abertoEm, declinouEm: x.declinouEm, declinouMotivo: x.declinouMotivo,
      respostaEm: x.situacao === "respondeu" ? u?.enviadaEm ?? null : null, versao: u?.versao ?? null, origem: u?.origem ?? null,
      cotados: x.situacao === "respondeu" ? u?.cotados ?? null : null, link: comLinks && x.linkAtivo ? caminhoDoLink(tokenDoConvite(x.id, x.serie)) : null, historico: x.historico, naComparacao: x.naComparacao,
      via: x.via, emailSituacao: x.emailSituacao, emailEnviadoEm: x.emailEnviadoEm, emailErro: x.emailErro, contaId: x.contaId,
    };
  });

  let propostas: PropostaVigente[] = [];
  let comparadas: PropostaVigente[] = [];
  let mapaTodos: Mapa | null = null;
  let avaliacoes: AvaliacaoC[] = [];
  let mapa: Mapa | null = null, previa: Apuracao | null = null, comparacao: Comparacao | null = null;
  if (precosVisiveis) {
    const vigentes = cv.filter((x) => x.situacao === "respondeu" && ultima.has(x.id)).map((x) => ({ x, p: ultima.get(x.id)! }));
    const itens = vigentes.length ? (await c.query(
      `select proposta_id, material_id, preco_unitario::text as preco, marca, modelo, observacao, indisponivel from proposta_item where proposta_id = any($1::uuid[])`,
      [vigentes.map((v) => v.p.id)])).rows : [];
    propostas = vigentes.map(({ x, p }): PropostaVigente => ({
      id: p.id, conviteId: x.id, fornecedor: x.razaoSocial, cnpj: x.cnpj, versao: p.versao, origem: p.origem, enviadaEm: new Date(p.enviadaEm).toISOString(),
      responsavelNome: p.responsavelNome, responsavelCargo: p.responsavelCargo, responsavelTelefone: p.responsavelTelefone, prazoEntrega: p.prazoEntrega,
      validadeDias: p.validadeDias, pagamentoDias: p.pagamentoDias, condicaoPagamento: p.condicaoPagamento, frete: p.frete, garantiaMeses: p.garantiaMeses,
      observacao: p.observacao, documento: p.documento, resumo: p.resumo, lancadaPor: p.lancadaPor, historico: x.historico,
      itens: Object.fromEntries(itens.filter((i) => i.proposta_id === p.id).map((i) => [i.material_id, { preco: i.preco, marca: i.marca, modelo: i.modelo, observacao: i.observacao, indisponivel: i.indisponivel }])),
    }));
    avaliacoes = (await c.query(
      `select convite_id as "conviteId", material_id as "materialId", tipo, justificativa from avaliacao_item where solicitacao_id = $1`, [id])).rows;
    const fora = new Set(cv.filter((x) => !x.naComparacao).map((x) => x.id as string));
    comparadas = propostas.filter((p) => !fora.has(p.conviteId));
    mapa = comparar(materiais, comparadas, avaliacoes, s.arredondamento);
    mapaTodos = comparadas.length === propostas.length ? mapa : comparar(materiais, propostas, avaliacoes, s.arredondamento);
    if (comparadas.length) comparacao = compararAutomatico(mapa, comparadas, avaliacoes, s.criterio, s.pesos);
    if (s.situacao === "encerrada" && comparadas.length) previa = apurar(mapa, comparadas, avaliacoes, s.criterio, s.pesos);
  }
  const apuracoes = (await c.query(
    `select ap.id, ap.numero, ap.criterio, ap.resultado, ap.total_referencia::text as "totalReferencia", ap.total_resultado::text as "totalResultado", ap.economia::text,
            ap.vencedor_convite_id as "vencedorConviteId", ap.escolhido_convite_id as "escolhidoConviteId", ap.justificativa, ap.codigo, u.nome as "homologadaPor",
            ap.homologada_em as "homologadaEm"
       from apuracao ap left join usuario u on u.id = ap.homologada_por where ap.solicitacao_id = $1 order by ap.numero desc`, [id])).rows;
  const nomes = new Map(cv.map((x) => [x.id, x.razaoSocial as string]));
  const versoes = ps.map((p): VersaoProposta => ({
    conviteId: p.conviteId, fornecedor: nomes.get(p.conviteId) ?? "", versao: p.versao, enviadaEm: p.enviadaEm, origem: p.origem, responsavelNome: p.responsavelNome,
    resumo: p.resumo, total: precosVisiveis ? p.bruto : null, itens: p.cotados,
  }));
  const eventos = (await c.query(
    `select ev.id, ev.tipo, ev.resumo, ev.detalhe, ev.em, u.nome as usuario, e.razao_social as fornecedor, ev.rede
       from evento_cotacao ev left join usuario u on u.id = ev.usuario_id left join convite_cotacao cv on cv.id = ev.convite_id left join empresa e on e.id = cv.empresa_id
      where ev.solicitacao_id = $1 order by ev.em desc, ev.id`, [id])).rows;
  const totalRef = comparar(materiais, [], [], s.arredondamento).totalReferencia;
  const linkAberto = !!a && pode(a, "cotacao.solicitar") && ["rascunho", "aberta"].includes(s.situacao) ? await linkAbertoAtual(c, id) : null;
  return {
    ...s, materiais, convites, precosVisiveis, linkAberto, emailAutomatico: !!(await envioAutomatico(c)).email, propostas, comparadas, mapaTodos, avaliacoes, mapa, comparacao, previa, apuracoes, versoes, eventos, totalReferencia: totalRef,
    podeSolicitar: !!a && pode(a, "cotacao.solicitar"), podeApurar: !!a && pode(a, "cotacao.apurar"), podeHomologar: !!a && pode(a, "cotacao.homologar"),
    podeEscolherComparadas: !!a && pode(a, "cotacao.apurar") && precosVisiveis && ["aberta", "encerrada"].includes(s.situacao) && propostas.length > MINIMO_COMPARADAS,
    respondidas: convites.filter((x) => x.situacao === "respondeu").length, declinaram: convites.filter((x) => x.situacao === "declinou").length,
    pendentes: convites.filter((x) => !["respondeu", "declinou"].includes(x.situacao)).length,
  };
}

export async function obterSolicitacao(a: Ator, id: string): Promise<SolicitacaoCompleta> {
  exigir(a, "cotacao.ver");
  await encerrarVencidas(a.orgaoId);
  return comContexto(ctx(a), async (c) => carregar(c, a, await base(c, a, id), { comLinks: pode(a, "cotacao.solicitar") }));
}

export type ResumoSolicitacao = {
  id: string; numero: number; titulo: string; situacao: SituacaoSolicitacao; prazo: Date; criterio: Criterio; obraId: string; obraCodigo: string; obraNome: string;
  orcamentoId: string; orcamentoNumero: number; orcamentoVersao: number; materiais: number; convidados: number; respondidas: number; declinaram: number;
  totalReferencia: string | null; totalResultado: string | null; economia: string | null; criadoEm: Date;
};

export async function listarSolicitacoes(a: Ator, f: { orcamentoId?: string; obraId?: string; situacao?: string } = {}): Promise<ResumoSolicitacao[]> {
  exigir(a, "cotacao.ver");
  await encerrarVencidas(a.orgaoId);
  return comContexto(ctx(a), async (c) => {
    const v = visivel(a, 1);
    const params: unknown[] = [...v.params];
    const filtros = [v.sql];
    if (uuid(f.orcamentoId)) { params.push(f.orcamentoId); filtros.push(`s.orcamento_id = $${params.length}`); }
    if (uuid(f.obraId)) { params.push(f.obraId); filtros.push(`s.obra_id = $${params.length}`); }
    if (f.situacao && f.situacao in ROTULO_SITUACAO_COTACAO) { params.push(f.situacao); filtros.push(`s.situacao = $${params.length}`); }
    return (await c.query(
      `select s.id, s.numero, s.titulo, s.situacao, s.prazo, s.criterio, s.obra_id as "obraId", b.codigo as "obraCodigo", b.nome as "obraNome",
              s.orcamento_id as "orcamentoId", o.numero as "orcamentoNumero", o.versao as "orcamentoVersao", s.criado_em as "criadoEm",
              (select count(*)::int from solicitacao_material m where m.solicitacao_id = s.id) as materiais,
              (select count(*)::int from convite_cotacao cv where cv.solicitacao_id = s.id) as convidados,
              (select count(*)::int from convite_cotacao cv where cv.solicitacao_id = s.id and cv.situacao = 'respondeu') as respondidas,
              (select count(*)::int from convite_cotacao cv where cv.solicitacao_id = s.id and cv.situacao = 'declinou') as declinaram,
              ap."totalReferencia", ap."totalResultado", ap.economia
         from solicitacao_cotacao s join obra b on b.id = s.obra_id join orcamento o on o.id = s.orcamento_id
         left join lateral (select x.total_referencia::text as "totalReferencia", x.total_resultado::text as "totalResultado", x.economia::text
                              from apuracao x where x.solicitacao_id = s.id and s.situacao = 'apurada' order by x.numero desc limit 1) ap on true
        where ${filtros.join(" and ")} order by s.criado_em desc`, params)).rows;
  });
}

// ---------------------------------------------------------------------------
// Avaliação dos itens e homologação
// ---------------------------------------------------------------------------
export async function avaliarItem(a: Ator, id: string, d: { conviteId: string; materialId: string; tipo: string; justificativa: string }) {
  exigir(a, "cotacao.apurar");
  if (!["nao_atende", "desconsiderado"].includes(d.tipo)) throw new ErroDeRegra("Escolha o motivo.");
  const j = justificar(d.justificativa);
  await encerrarVencidas(a.orgaoId);
  await comContexto(ctx(a), async (c) => {
    const s = await base(c, a, id);
    if (s.situacao !== "encerrada") throw new ErroDeRegra("A avaliação dos itens é feita com a solicitação encerrada e antes da homologação.");
    if (!uuid(d.conviteId) || !uuid(d.materialId)) throw new ErroDeRegra("Item não encontrado.");
    if ((await c.query("select 1 from avaliacao_item where convite_id = $1 and material_id = $2", [d.conviteId, d.materialId])).rowCount)
      throw new ErroDeRegra("Este item já tem uma avaliação registrada. Remova a anterior para registrar outra.");
    await c.query("insert into avaliacao_item (orgao_id, solicitacao_id, convite_id, material_id, tipo, justificativa) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, id, d.conviteId, d.materialId, d.tipo, j]);
    const m = (await c.query("select codigo, descricao from solicitacao_material where id = $1", [d.materialId])).rows[0];
    await evento(c, a.orgaoId, id, "avaliacao", d.tipo === "nao_atende" ? `Item não atende à especificação: ${m.descricao}` : `Preço desconsiderado: ${m.descricao}`,
      { conviteId: d.conviteId, usuarioId: a.id, detalhe: { codigo: m.codigo, justificativa: j } });
  });
}

/** Mínimo de propostas na comparação quando há mais do que isso recebidas. */
export const MINIMO_COMPARADAS = 3;

/** Define quais propostas recebidas entram no mapa, na média, na mediana e na apuração. */
export async function escolherComparadas(a: Ator, id: string, conviteIds: string[]) {
  exigir(a, "cotacao.apurar");
  await encerrarVencidas(a.orgaoId);
  await comContexto(ctx(a), async (c) => {
    const s = await carregar(c, a, await base(c, a, id));
    if (!s.precosVisiveis || !["aberta", "encerrada"].includes(s.situacao)) throw new ErroDeRegra("A escolha dos fornecedores é feita com os preços abertos e antes da homologação.");
    if (s.propostas.length <= MINIMO_COMPARADAS) throw new ErroDeRegra("Com até três propostas, todas entram na comparação.");
    const marcados = new Set(conviteIds);
    const dentro = s.propostas.filter((p) => marcados.has(p.conviteId));
    if (dentro.length < MINIMO_COMPARADAS) throw new ErroDeRegra("Marque pelo menos três fornecedores.");
    const antes = new Set(s.comparadas.map((p) => p.conviteId));
    if (dentro.length === antes.size && dentro.every((p) => antes.has(p.conviteId))) return;
    const ids = s.propostas.map((p) => p.conviteId);
    await c.query("update convite_cotacao set na_comparacao = (id = any($2::uuid[])) where solicitacao_id = $1 and id = any($3::uuid[])", [id, dentro.map((p) => p.conviteId), ids]);
    const fora = s.propostas.filter((p) => !marcados.has(p.conviteId)).map((p) => p.fornecedor);
    await evento(c, a.orgaoId, id, "comparacao", fora.length ? `Comparação com ${dentro.length} de ${s.propostas.length} propostas` : "Comparação com todas as propostas",
      { usuarioId: a.id, detalhe: { naComparacao: dentro.map((p) => p.fornecedor), fora } });
  });
}

export async function removerAvaliacao(a: Ator, id: string, conviteId: string, materialId: string) {
  exigir(a, "cotacao.apurar");
  await comContexto(ctx(a), async (c) => {
    await base(c, a, id);
    const r = await c.query("delete from avaliacao_item where solicitacao_id = $1 and convite_id = $2 and material_id = $3 returning justificativa", [id, conviteId, materialId]);
    if (r.rowCount) await evento(c, a.orgaoId, id, "avaliacao", "Avaliação de item removida", { conviteId, usuarioId: a.id, detalhe: { justificativaAnterior: r.rows[0].justificativa } });
  });
}

export async function homologar(a: Ator, id: string, d: { escolhidoConviteId?: string | null; justificativa?: string | null } = {}) {
  exigir(a, "cotacao.homologar");
  await encerrarVencidas(a.orgaoId);
  return comContexto(ctx(a), async (c) => {
    const s = await carregar(c, a, await base(c, a, id));
    if (s.situacao !== "encerrada") throw new ErroDeRegra("Só uma solicitação encerrada pode ser homologada.");
    if (!s.mapa || !s.comparadas.length) throw new ErroDeRegra("Não há proposta para apurar.");
    const menosDeTres = s.comparadas.length < 3;
    const anteriores = s.apuracoes.length > 0;
    const previa = s.previa!;
    const escolhido = s.criterio !== "item" && uuid(d.escolhidoConviteId) ? d.escolhidoConviteId : null;
    const difere = !!escolhido && escolhido !== previa.vencedor?.conviteId;
    if (difere && !s.mapa.fornecedores.find((f) => f.conviteId === escolhido)?.completa) throw new ErroDeRegra("O fornecedor escolhido precisa ter cotado todos os itens.");
    const j = limpo(d.justificativa, 1000);
    if ((difere || menosDeTres || anteriores) && (!j || j.length < 10)) {
      throw new ErroDeRegra(difere ? "Justifique a escolha de um fornecedor diferente do primeiro classificado."
        : anteriores ? "Justifique a nova apuração." : "Há menos de três propostas. Justifique a homologação.");
    }
    const resultado = apurar(s.mapa, s.comparadas, s.avaliacoes, s.criterio, s.pesos, escolhido);
    if (!resultado.itens.some((i) => i.conviteId)) throw new ErroDeRegra(resultado.semVencedor ?? "Não há resultado para homologar.");
    const codigo = sha(JSON.stringify({ id, resultado, propostas: s.comparadas.map((p) => p.resumo).sort() }));
    await c.query(
      `insert into apuracao (orgao_id, solicitacao_id, numero, criterio, pesos, resultado, total_referencia, total_resultado, economia,
                             vencedor_convite_id, escolhido_convite_id, justificativa, codigo, homologada_por)
       values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [a.orgaoId, id, s.criterio, JSON.stringify(s.pesos), JSON.stringify(resultado), resultado.totalReferencia, resultado.totalResultado, resultado.economia,
        previa.vencedor?.conviteId ?? null, resultado.vencedor?.conviteId ?? null, j, codigo, a.id]);
    await c.query("update solicitacao_cotacao set situacao = 'apurada' where id = $1", [id]);
    await evento(c, a.orgaoId, id, "homologacao", "Apuração homologada", { usuarioId: a.id, detalhe: { criterio: s.criterio, total: resultado.totalResultado, codigo, justificativa: j } });
    return codigo;
  });
}

// ---------------------------------------------------------------------------
// Painel geral
// ---------------------------------------------------------------------------
export async function painelCotacoes(a: Ator, f: { obraId?: string; situacao?: string } = {}) {
  const todas = await listarSolicitacoes(a);
  const lista = todas.filter((s) => (!f.obraId || s.obraId === f.obraId) && (!f.situacao || s.situacao === f.situacao));
  const fornecedores = await comContexto(ctx(a), async (c) => {
    const v = visivel(a, 1);
    return (await c.query(
      `select e.id, e.razao_social as "razaoSocial", count(*)::int as convites, count(*) filter (where cv.situacao = 'respondeu')::int as respostas,
              count(*) filter (where cv.situacao = 'declinou')::int as declinios
         from convite_cotacao cv join solicitacao_cotacao s on s.id = cv.solicitacao_id join empresa e on e.id = cv.empresa_id
        where s.situacao <> 'rascunho' and ${v.sql} group by e.id order by convites desc, e.razao_social limit 30`, v.params)).rows as
      { id: string; razaoSocial: string; convites: number; respostas: number; declinios: number }[];
  });
  const apuradas = lista.filter((s) => s.situacao === "apurada");
  const obras = [...new Map(todas.map((s) => [s.obraId, { id: s.obraId, codigo: s.obraCodigo, nome: s.obraNome }])).values()];
  return {
    lista, fornecedores, obras,
    porSituacao: Object.fromEntries((Object.keys(ROTULO_SITUACAO_COTACAO) as SituacaoSolicitacao[]).map((k) => [k, lista.filter((s) => s.situacao === k).length])) as Record<SituacaoSolicitacao, number>,
    economia: apuradas.reduce((t, s) => t + Number(s.economia ?? 0), 0),
    referenciaApurada: apuradas.reduce((t, s) => t + (s.economia != null ? Number(s.totalReferencia ?? 0) : 0), 0),
    vencendo: lista.filter((s) => s.situacao === "aberta" && s.prazo.getTime() - Date.now() < 3 * 86400000),
  };
}

/** Marcas já informadas em propostas, para sugerir no preenchimento. */
export async function marcasConhecidas(a: Ator) {
  exigir(a, "cotacao.ver");
  return comContexto(ctx(a), async (c) => (await c.query("select nome from marca order by nome limit 300")).rows.map((m) => m.nome as string));
}

/** Último preço apurado de cada material em outras solicitações do órgão. */
export async function precosAnteriores(a: Ator, id: string) {
  exigir(a, "cotacao.ver");
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select distinct on (m.codigo, m.descricao) m.codigo, m.descricao, ap.resultado, ap.homologada_em as em, s.numero, s.id as "solicitacaoId"
         from solicitacao_material m join solicitacao_cotacao s on s.id = m.solicitacao_id join apuracao ap on ap.solicitacao_id = s.id
        where s.id <> $1 and s.situacao = 'apurada'
          and (m.codigo, m.descricao) in (select codigo, descricao from solicitacao_material where solicitacao_id = $1)
        order by m.codigo, m.descricao, ap.homologada_em desc`, [id]);
    const mapa = new Map<string, { preco: string; fornecedor: string; marca: string | null; em: Date }>();
    for (const l of r.rows) {
      const i = (l.resultado as Apuracao).itens.find((x) => x.codigo === l.codigo && x.descricao === l.descricao && x.preco);
      if (i) mapa.set(`${l.codigo}|${l.descricao}`, { preco: i.preco!, fornecedor: i.fornecedor ?? "", marca: i.marca, em: l.em });
    }
    return mapa;
  });
}

// ---------------------------------------------------------------------------
// Página do fornecedor (sem login, pelo link)
// ---------------------------------------------------------------------------
const tentativas = new Map<string, { n: number; ate: number }>();
/** Freio simples contra tentativa de adivinhar links. */
function frear(rede: string | null) {
  const k = rede ?? "?";
  const t = tentativas.get(k);
  if (t && t.ate > Date.now() && t.n >= 20) throw new ErroDeRegra("Muitas tentativas. Aguarde alguns minutos.");
  return () => {
    const atual = tentativas.get(k);
    tentativas.set(k, atual && atual.ate > Date.now() ? { n: atual.n + 1, ate: atual.ate } : { n: 1, ate: Date.now() + 10 * 60000 });
    if (tentativas.size > 5000) tentativas.clear();
  };
}

export async function acesso(token: string, rede: string | null) {
  const falhou = frear(rede);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) { falhou(); return null; }
  const r = await pool().query("select orgao_id, convite_id, revogado_em from cotacao_link where token_hash = $1", [sha(token)]);
  const l = r.rows[0];
  if (!l) { falhou(); return null; }
  return { orgaoId: l.orgao_id as string, conviteId: l.convite_id as string, revogado: !!l.revogado_em };
}

export type PaginaFornecedor = {
  estado: "aberta" | "encerrada" | "cancelada" | "revogado";
  orgao: string; obra: string; numero: number; titulo: string; prazo: Date; localEntrega: string | null; freteIncluso: boolean; validadeMinima: number | null;
  observacao: string | null; fornecedor: string; cnpjFinal: string; cnpj: string; pontua: string[];
  materiais: { id: string; ordem: number; codigo: string; descricao: string; unidade: string; quantidade: string; semSinapi: boolean }[];
  situacao: "convidado" | "abriu" | "respondeu" | "declinou"; rascunho: DadosProposta | null; marcas: string[];
  enviada: { versao: number; protocolo: string; enviadaEm: Date; resumo: string; dados: DadosProposta; total: string } | null;
};

export async function paginaDoFornecedor(token: string, rede: string | null): Promise<PaginaFornecedor | null> {
  const ac = await acesso(token, rede);
  if (!ac) return null;
  return paginaDoConvite(ac.orgaoId, ac.conviteId, rede, ac.revogado);
}

/** Dados que o fornecedor vê de um convite. Serve ao link e à área do fornecedor. */
export async function paginaDoConvite(orgaoId: string, conviteId: string, rede: string | null, revogado = false): Promise<PaginaFornecedor | null> {
  await encerrarVencidas(orgaoId);
  return comContexto({ usuarioId: null, orgaoId }, async (c) => {
    const r = (await c.query(
      `select cv.id, cv.situacao, cv.rascunho, cv.solicitacao_id, e.razao_social, e.cnpj, g.nome as orgao, b.nome as obra, s.numero, s.titulo, s.prazo, s.situacao as sit,
              s.local_entrega, s.frete_incluso, s.validade_minima, s.observacao, s.criterio, s.pesos, s.arredondamento
         from convite_cotacao cv join solicitacao_cotacao s on s.id = cv.solicitacao_id join empresa e on e.id = cv.empresa_id
         join orgao g on g.id = s.orgao_id join obra b on b.id = s.obra_id where cv.id = $1`, [conviteId])).rows[0];
    if (!r) return null;
    const estado: PaginaFornecedor["estado"] = revogado ? "revogado" : r.sit === "aberta" ? "aberta" : r.sit === "cancelada" ? "cancelada" : "encerrada";
    if (estado === "aberta" && r.situacao === "convidado") {
      await c.query("update convite_cotacao set situacao = 'abriu', aberto_em = now() where id = $1", [r.id]);
      await evento(c, orgaoId, r.solicitacao_id, "acesso", `${r.razao_social} abriu o convite`, { conviteId: r.id, rede });
      r.situacao = "abriu";
    }
    const materiais = (await c.query(
      `select id, ordem, codigo, descricao, unidade, quantidade::text, sem_sinapi as "semSinapi" from solicitacao_material where solicitacao_id = $1 order by ordem`, [r.solicitacao_id])).rows;
    const p = (await c.query("select * from proposta where convite_id = $1 order by versao desc limit 1", [r.id])).rows[0];
    let enviada: PaginaFornecedor["enviada"] = null;
    if (p && r.situacao === "respondeu") {
      const itens = (await c.query(
        `select i.material_id, i.preco_unitario::text as preco, i.marca, i.modelo, i.observacao, i.indisponivel, m.quantidade::text as quantidade
           from proposta_item i join solicitacao_material m on m.id = i.material_id where i.proposta_id = $1`, [p.id])).rows;
      const mapa = comparar(materiais.map((m) => ({ ...m, precoReferencia: null })), [{
        conviteId: r.id, fornecedor: r.razao_social, enviadaEm: "", prazoEntrega: null, pagamentoDias: null, garantiaMeses: null, historico: null,
        itens: Object.fromEntries(itens.map((i) => [i.material_id, { preco: i.preco, marca: i.marca, modelo: i.modelo, indisponivel: i.indisponivel }])),
      }], [], r.arredondamento);
      const br = (v: string | null) => (v == null ? "" : String(Number(v)).replace(".", ","));
      enviada = {
        versao: p.versao, protocolo: protocolo(p.resumo, p.versao), enviadaEm: p.enviada_em, resumo: p.resumo, total: mapa.fornecedores[0].total,
        dados: {
          responsavelNome: p.responsavel_nome, responsavelCargo: p.responsavel_cargo ?? "", responsavelTelefone: p.responsavel_telefone ?? "",
          prazoEntrega: p.prazo_entrega?.toString() ?? "", validadeDias: p.validade_dias?.toString() ?? "", pagamentoDias: p.pagamento_dias?.toString() ?? "",
          condicaoPagamento: p.condicao_pagamento ?? "", frete: Number(p.frete) ? br(p.frete) : "", garantiaMeses: p.garantia_meses?.toString() ?? "", observacao: p.observacao ?? "",
          itens: Object.fromEntries(itens.map((i) => [i.material_id, { preco: br(i.preco), marca: i.marca ?? "", modelo: i.modelo ?? "", observacao: i.observacao ?? "", indisponivel: i.indisponivel }])),
        },
      };
    }
    const pesos = r.pesos as Pesos;
    const pontua = r.criterio === "custo_beneficio"
      ? [pesos.prazo ? "prazo de entrega" : "", pesos.pagamento ? "prazo de pagamento" : "", pesos.garantia ? "garantia" : ""].filter(Boolean) : [];
    const marcas = estado === "aberta" ? (await c.query("select nome from marca order by nome limit 300")).rows.map((m) => m.nome as string) : [];
    return {
      estado, orgao: r.orgao, obra: r.obra, numero: r.numero, titulo: r.titulo, prazo: r.prazo, localEntrega: r.local_entrega, freteIncluso: r.frete_incluso,
      validadeMinima: r.validade_minima, observacao: r.observacao, fornecedor: r.razao_social, cnpjFinal: (r.cnpj as string).slice(-6), cnpj: r.cnpj, pontua,
      materiais, situacao: r.situacao, rascunho: estado === "aberta" ? r.rascunho : null, marcas, enviada,
    };
  });
}

async function conviteAberto(c: PoolClient, conviteId: string) {
  const r = (await c.query(
    `select cv.id, cv.solicitacao_id, e.razao_social, e.cnpj, s.situacao, s.prazo, s.validade_minima
       from convite_cotacao cv join solicitacao_cotacao s on s.id = cv.solicitacao_id join empresa e on e.id = cv.empresa_id where cv.id = $1`, [conviteId])).rows[0];
  if (!r || r.situacao !== "aberta" || new Date(r.prazo).getTime() < Date.now()) throw new ErroDeRegra("O prazo desta cotação terminou.");
  return r;
}

async function linkValido(token: string, rede: string | null) {
  const ac = await acesso(token, rede);
  if (!ac || ac.revogado) throw new ErroDeRegra("Link inválido.");
  return ac;
}

export async function salvarRascunho(token: string, d: DadosProposta, rede: string | null) {
  const ac = await linkValido(token, rede);
  await salvarRascunhoDoConvite(ac.orgaoId, ac.conviteId, d);
}

export async function salvarRascunhoDoConvite(orgaoId: string, conviteId: string, d: DadosProposta) {
  const dados = JSON.stringify(d);
  if (dados.length > 200_000) throw new ErroDeRegra("Rascunho grande demais.");
  await comContexto({ usuarioId: null, orgaoId }, async (c) => {
    await conviteAberto(c, conviteId);
    await c.query("update convite_cotacao set rascunho = $2, rascunho_em = now() where id = $1", [conviteId, dados]);
  });
}

export async function enviarProposta(token: string, d: DadosProposta, rede: string | null) {
  const ac = await linkValido(token, rede);
  return enviarPropostaDoConvite(ac.orgaoId, ac.conviteId, d, rede);
}

export async function enviarPropostaDoConvite(orgaoId: string, conviteId: string, d: DadosProposta, rede: string | null) {
  const r = await comContexto({ usuarioId: null, orgaoId }, async (c) => {
    const cv = await conviteAberto(c, conviteId);
    if (soDigitos(d.cnpj ?? "") !== cv.cnpj) throw new ErroDeRegra("O CNPJ informado não confere com o da empresa convidada.");
    const materiais = (await c.query("select id, codigo, descricao from solicitacao_material where solicitacao_id = $1 order by ordem", [cv.solicitacao_id])).rows;
    const g = await gravarProposta(c, orgaoId, conviteId, cv.solicitacao_id, conferirProposta(d, materiais, cv.validade_minima), { origem: "fornecedor", rede, fornecedor: cv.razao_social });
    return { ...g, solicitacaoId: cv.solicitacao_id as string, fornecedor: cv.razao_social as string };
  });
  await avisarPropostaRecebida(orgaoId, r.solicitacaoId, r.fornecedor, r.versao).catch(() => {});
  return r;
}

export async function declinar(token: string, motivo: string | null, rede: string | null) {
  const ac = await linkValido(token, rede);
  await declinarConvite(ac.orgaoId, ac.conviteId, motivo, rede);
}

export async function declinarConvite(orgaoId: string, conviteId: string, motivo: string | null, rede: string | null) {
  await comContexto({ usuarioId: null, orgaoId }, async (c) => {
    const cv = await conviteAberto(c, conviteId);
    await c.query("update convite_cotacao set situacao = 'declinou', declinou_em = now(), declinou_motivo = $2, rascunho = null where id = $1", [conviteId, limpo(motivo, 300)]);
    await evento(c, orgaoId, cv.solicitacao_id, "declinio", `${cv.razao_social} informou que não vai participar`, { conviteId, rede, detalhe: { motivo: limpo(motivo, 300) } });
  });
}

export { rotuloOrcamento, SemPermissao };
