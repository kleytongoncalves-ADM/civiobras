import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { ajustar, dec, div, lerNumeroBr, lerValorBr, mul, paraNumero, texto, UM, ZERO, type Dec, type Regra } from "../lib/decimal";
import { diaLocal } from "../lib/formato";
import { rotuloContrato, type Regime, type SituacaoContrato } from "./contratos";
import { planejadoAte, somarDias, type AtividadeCurva, type Calendario } from "./cpm";
import type { Ator } from "./obras";
import { exigir, pode, SemPermissao } from "./permissoes";
import { impeditivasDoContrato } from "./qualidade";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string | null | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);
const dataValida = (v: string | null | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const limpo = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const moedaBr = (v: Dec) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(texto(v)));
export const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

export type SituacaoMedicao = "rascunho" | "atestada" | "aprovada" | "cancelada";
export type TipoRetencao = "iss" | "inss" | "ir" | "caucao" | "outra";
export type SituacaoPagamento = "a_pagar" | "parcial" | "paga" | "sem_valor";

export const ROTULO_SITUACAO_MEDICAO: Record<SituacaoMedicao, string> = {
  rascunho: "Em elaboração", atestada: "Atestada", aprovada: "Aprovada", cancelada: "Cancelada",
};
export const ROTULO_PAGAMENTO: Record<SituacaoPagamento, string> = {
  a_pagar: "A pagar", parcial: "Paga em parte", paga: "Paga", sem_valor: "Sem valor a pagar",
};
export const ROTULO_RETENCAO: Record<TipoRetencao, string> = {
  iss: "ISS", inss: "INSS", ir: "IR", caucao: "Caução", outra: "Outra",
};
/** Base e alíquota sugeridas ao lançar a retenção. O órgão confere com a legislação local. */
export const SUGESTAO_RETENCAO: Record<TipoRetencao, { basePct: number; aliquota: number }> = {
  iss: { basePct: 50, aliquota: 5 }, inss: { basePct: 50, aliquota: 11 }, ir: { basePct: 100, aliquota: 1.2 },
  caucao: { basePct: 100, aliquota: 5 }, outra: { basePct: 100, aliquota: 1 },
};
export const ROTULO_TRAMITE: Record<string, string> = {
  elaborada: "Elaborada", atestada: "Atestada pelo fiscal", devolvida: "Devolvida para correção", aprovada: "Aprovada", cancelada: "Cancelada",
};

export const rotuloMedicao = (m: { numero: number; ajuste: boolean }) =>
  `Medição ${String(m.numero).padStart(2, "0")}${m.ajuste ? " (ajuste)" : ""}`;

// ---------------------------------------------------------------------------
// Cabeçalho e acesso
// ---------------------------------------------------------------------------
type ContratoDaMedicao = {
  contratoId: string; contratoNumero: string; regime: Regime; contratoSituacao: SituacaoContrato; obraId: string; obraCodigo: string; obraNome: string;
  empresaNome: string | null; empresaCnpj: string | null; objeto: string; arredondamento: Regra; gestorId: string | null; fiscalId: string | null;
  gestorNome: string | null; fiscalNome: string | null; dataOrdemServico: string | null; valorInicial: string; valorContratual: string; processo: string | null;
};

export type CabecalhoMedicao = ContratoDaMedicao & {
  id: string; numero: number; ajuste: boolean; periodoInicio: string; periodoFim: string; observacao: string | null; situacao: SituacaoMedicao;
  valorBruto: string | null; valorGlosa: string | null; valorRetencao: string | null; valorLiquido: string | null;
  reajustePct: string; valorReajuste: string;
  atestadaPor: string | null; atestadaPorNome: string | null; atestadaEm: Date | null;
  aprovadaPor: string | null; aprovadaPorNome: string | null; aprovadaEm: Date | null;
  criadoPor: string | null; criadoPorNome: string | null; criadoEm: Date;
};

const COLUNAS_CONTRATO = `k.id as "contratoId", k.numero as "contratoNumero", k.regime, k.situacao as "contratoSituacao", k.obra_id as "obraId",
  b.codigo as "obraCodigo", b.nome as "obraNome", e.razao_social as "empresaNome", e.cnpj as "empresaCnpj", k.objeto, o.arredondamento,
  k.gestor_id as "gestorId", k.fiscal_id as "fiscalId", ug.nome as "gestorNome", uf.nome as "fiscalNome",
  to_char(k.data_ordem_servico, 'YYYY-MM-DD') as "dataOrdemServico", k.valor_inicial::text as "valorInicial", k.processo,
  (k.valor_inicial + coalesce((select sum(ad.valor_acrescimo - ad.valor_supressao) from aditivo ad
                                where ad.contrato_id = k.id and ad.situacao = 'assinado'), 0))::text as "valorContratual"`;
const DE_CONTRATO = `contrato k join obra b on b.id = k.obra_id join orcamento o on o.id = k.orcamento_id left join empresa e on e.id = k.empresa_id
  left join usuario ug on ug.id = k.gestor_id left join usuario uf on uf.id = k.fiscal_id`;

const COLUNAS = `m.id, m.numero, m.ajuste, to_char(m.periodo_inicio, 'YYYY-MM-DD') as "periodoInicio", to_char(m.periodo_fim, 'YYYY-MM-DD') as "periodoFim",
  m.observacao, m.situacao, m.valor_bruto::text as "valorBruto", m.valor_glosa::text as "valorGlosa", m.valor_retencao::text as "valorRetencao",
  m.valor_liquido::text as "valorLiquido", m.reajuste_pct::text as "reajustePct", m.valor_reajuste::text as "valorReajuste", m.atestada_por as "atestadaPor", ua.nome as "atestadaPorNome", m.atestada_em as "atestadaEm",
  m.aprovada_por as "aprovadaPor", up.nome as "aprovadaPorNome", m.aprovada_em as "aprovadaEm",
  m.criado_por as "criadoPor", uc.nome as "criadoPorNome", m.criado_em as "criadoEm", ${COLUNAS_CONTRATO}`;
const DE = `from medicao m join ${DE_CONTRATO} on k.id = m.contrato_id
  left join usuario ua on ua.id = m.atestada_por left join usuario up on up.id = m.aprovada_por left join usuario uc on uc.id = m.criado_por`;

function visivel(a: Ator, n: number) {
  if (pode(a, "obra.ver_todas")) return { sql: "true", params: [] as unknown[] };
  return {
    sql: `exists (select 1 from vinculo_obra v where v.obra_id = k.obra_id and v.usuario_id = $${n} and (v.fim is null or v.fim >= hoje_local()))`,
    params: [a.id],
  };
}

function exigirVer(a: Ator) {
  if (!pode(a, "medicao.ver")) throw new SemPermissao();
}

async function cabecalho(c: PoolClient, a: Ator, id: string, travar = false): Promise<CabecalhoMedicao> {
  if (!uuid(id)) throw new ErroDeRegra("Medição não encontrada.");
  if (travar) await c.query("select 1 from medicao where id = $1 for update", [id]);
  const v = visivel(a, 2);
  const r = await c.query(`select ${COLUNAS} ${DE} where m.id = $1 and ${v.sql}`, [id, ...v.params]);
  if (!r.rows[0]) throw new ErroDeRegra("Medição não encontrada ou fora do seu acesso.");
  return r.rows[0];
}

async function contratoVisivel(c: PoolClient, a: Ator, contratoId: string): Promise<ContratoDaMedicao> {
  if (!uuid(contratoId)) throw new ErroDeRegra("Contrato não encontrado.");
  const v = visivel(a, 2);
  const r = await c.query(`select ${COLUNAS_CONTRATO} from ${DE_CONTRATO} where k.id = $1 and ${v.sql}`, [contratoId, ...v.params]);
  if (!r.rows[0]) throw new ErroDeRegra("Contrato não encontrado ou fora do seu acesso.");
  return r.rows[0];
}

/** O fiscal e o gestor designados no contrato fazem seus passos. A direção e o administrador também podem. */
const designado = (a: Ator, id: string | null) => a.administrador || a.perfil === "direcao" || a.id === id;

// ---------------------------------------------------------------------------
// Elaboração
// ---------------------------------------------------------------------------
/** Período sugerido para a próxima medição: do dia seguinte à anterior até o fim daquele mês (ou hoje). */
export async function sugestaoPeriodo(a: Ator, contratoId: string) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const k = await contratoVisivel(c, a, contratoId);
    const ult = (await c.query(
      `select to_char(max(periodo_fim), 'YYYY-MM-DD') as f from medicao where contrato_id = $1 and situacao <> 'cancelada' and not ajuste`, [contratoId])).rows[0].f as string | null;
    const inicio = ult ? somarDias(ult, 1) : (k.dataOrdemServico ?? hoje());
    const [y, m] = inicio.split("-").map(Number);
    const fimMes = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const hj = hoje();
    return { inicio, fim: fimMes < hj ? fimMes : hj < inicio ? inicio : hj };
  });
}

export async function criarMedicao(a: Ator, contratoId: string, d: { periodoInicio: string; periodoFim: string; ajuste?: boolean; observacao?: string | null }): Promise<string> {
  exigir(a, "medicao.elaborar");
  if (!dataValida(d.periodoInicio) || !dataValida(d.periodoFim)) throw new ErroDeRegra("Informe o período da medição.");
  if (d.periodoFim < d.periodoInicio) throw new ErroDeRegra("O fim do período não pode ser anterior ao início.");
  const ajuste = !!d.ajuste;
  if (ajuste && !limpo(d.observacao)) throw new ErroDeRegra("Informe o motivo da medição de ajuste.");
  return comContexto(ctx(a), async (c) => {
    await c.query("select 1 from contrato where id = $1 for update", [contratoId]);
    const k = await contratoVisivel(c, a, contratoId);
    if (k.contratoSituacao !== "vigente") throw new ErroDeRegra("Só contrato vigente recebe medição.");
    if (k.dataOrdemServico && d.periodoInicio < k.dataOrdemServico) throw new ErroDeRegra("O período começa antes da ordem de serviço.");
    if (!ajuste) {
      const aberta = (await c.query(
        "select numero from medicao where contrato_id = $1 and situacao in ('rascunho', 'atestada') and not ajuste limit 1", [contratoId])).rows[0];
      if (aberta) throw new ErroDeRegra(`A medição ${String(aberta.numero).padStart(2, "0")} ainda está em andamento. Conclua ou cancele antes de abrir outra.`);
      const ult = (await c.query(
        "select to_char(max(periodo_fim), 'YYYY-MM-DD') as f from medicao where contrato_id = $1 and situacao <> 'cancelada' and not ajuste", [contratoId])).rows[0].f as string | null;
      if (ult && d.periodoInicio <= ult) throw new ErroDeRegra(`O período se sobrepõe à medição anterior, que vai até ${ult.split("-").reverse().join("/")}.`);
    }
    const numero = (await c.query("select coalesce(max(numero), 0) + 1 as n from medicao where contrato_id = $1", [contratoId])).rows[0].n as number;
    const id = (await c.query(
      `insert into medicao (orgao_id, contrato_id, numero, ajuste, periodo_inicio, periodo_fim, observacao) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [a.orgaoId, contratoId, numero, ajuste, d.periodoInicio, d.periodoFim, limpo(d.observacao)])).rows[0].id as string;
    await tramitar(c, a, id, "elaborada", null);
    return id;
  });
}

async function tramitar(c: PoolClient, a: Ator, medicaoId: string, acao: string, observacao: string | null) {
  await c.query("insert into medicao_tramite (orgao_id, medicao_id, acao, observacao, usuario_id) values ($1,$2,$3,$4,$5)",
    [a.orgaoId, medicaoId, acao, observacao, a.id]);
}

export type LinhaBoletim = { itemServicoId: string; quantidade: string; memoria: string };

/** Grava o boletim inteiro: linhas com quantidade entram ou mudam; linhas vazias saem. */
export async function salvarBoletim(a: Ator, id: string, d: { periodoInicio: string; periodoFim: string; observacao?: string | null; linhas: LinhaBoletim[] }) {
  exigir(a, "medicao.elaborar");
  if (!dataValida(d.periodoInicio) || !dataValida(d.periodoFim)) throw new ErroDeRegra("Informe o período da medição.");
  if (d.periodoFim < d.periodoInicio) throw new ErroDeRegra("O fim do período não pode ser anterior ao início.");
  await comContexto(ctx(a), async (c) => {
    const m = await cabecalho(c, a, id, true);
    if (m.situacao !== "rascunho") throw new ErroDeRegra("O boletim só muda com a medição em elaboração.");
    if (m.ajuste && !limpo(d.observacao)) throw new ErroDeRegra("Informe o motivo da medição de ajuste.");
    if (m.dataOrdemServico && d.periodoInicio < m.dataOrdemServico) throw new ErroDeRegra("O período começa antes da ordem de serviço.");
    if (!m.ajuste) {
      const ult = (await c.query(
        "select to_char(max(periodo_fim), 'YYYY-MM-DD') as f from medicao where contrato_id = $1 and situacao <> 'cancelada' and not ajuste and id <> $2",
        [m.contratoId, id])).rows[0].f as string | null;
      if (ult && d.periodoInicio <= ult) throw new ErroDeRegra(`O período se sobrepõe à medição anterior, que vai até ${ult.split("-").reverse().join("/")}.`);
    }
    await c.query("update medicao set periodo_inicio = $2, periodo_fim = $3, observacao = $4 where id = $1", [id, d.periodoInicio, d.periodoFim, limpo(d.observacao)]);
    const itens = new Map((await c.query(
      "select id, numero, preco_unitario::text as pu, executor from item_servico where contrato_id = $1", [m.contratoId])).rows.map((i) => [i.id as string, i]));
    const existentes = new Set((await c.query("select item_servico_id as id from item_medido where medicao_id = $1", [id])).rows.map((r) => r.id as string));
    for (const l of d.linhas) {
      const i = itens.get(l.itemServicoId);
      if (!i) throw new ErroDeRegra("Item não pertence ao contrato.");
      const vazio = l.quantidade.trim() === "";
      const q = vazio ? ZERO : lerNumeroBr(l.quantidade);
      if (q == null) throw new ErroDeRegra(`Item ${i.numero}: quantidade inválida.`);
      if (q === ZERO) {
        if (existentes.has(l.itemServicoId)) await c.query("delete from item_medido where medicao_id = $1 and item_servico_id = $2", [id, l.itemServicoId]);
        continue;
      }
      if (m.regime !== "direta" && i.executor !== "contratada") throw new ErroDeRegra(`Item ${i.numero}: executado pela equipe própria, fora da medição da contratada.`);
      if (q < ZERO && !m.ajuste) throw new ErroDeRegra(`Item ${i.numero}: quantidade negativa só em medição de ajuste.`);
      const memoria = l.memoria.trim();
      if (!memoria) throw new ErroDeRegra(`Item ${i.numero}: informe a memória de cálculo.`);
      const q4 = ajustar(q, 4, "arredondar");
      const valor = ajustar(mul(q4, dec(i.pu)), 2, m.arredondamento);
      await c.query(
        `insert into item_medido (orgao_id, medicao_id, item_servico_id, quantidade, preco_unitario, valor, memoria) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (medicao_id, item_servico_id) do update set quantidade = excluded.quantidade, valor = excluded.valor, memoria = excluded.memoria`,
        [a.orgaoId, id, l.itemServicoId, texto(q4, 4), i.pu, texto(valor), memoria]);
    }
  });
}

// ---------------------------------------------------------------------------
// Glosas e retenções
// ---------------------------------------------------------------------------
async function aberta(c: PoolClient, a: Ator, id: string) {
  exigir(a, "medicao.ajustar");
  const m = await cabecalho(c, a, id, true);
  if (m.situacao !== "rascunho" && m.situacao !== "atestada") throw new ErroDeRegra("Medição aprovada ou cancelada não pode ser alterada.");
  return m;
}

export async function adicionarGlosa(a: Ator, id: string, d: { motivo: string; valor: string; itemServicoId?: string | null }) {
  const valor = lerValorBr(d.valor);
  if (valor == null || valor <= ZERO) throw new ErroDeRegra("Informe o valor da glosa.");
  if (!d.motivo.trim()) throw new ErroDeRegra("Informe o motivo da glosa.");
  await comContexto(ctx(a), async (c) => {
    const m = await aberta(c, a, id);
    const t = await totais(c, id);
    if (t.glosa + t.retencao + valor > t.bruto + t.reajuste) throw new ErroDeRegra("As glosas passam do valor medido.");
    const item = uuid(d.itemServicoId) ? d.itemServicoId : null;
    if (item && !(await c.query("select 1 from item_medido where medicao_id = $1 and item_servico_id = $2", [id, item])).rowCount) {
      throw new ErroDeRegra("A glosa por item vale para itens medidos nesta medição.");
    }
    await c.query("insert into glosa (orgao_id, medicao_id, item_servico_id, motivo, valor) values ($1,$2,$3,$4,$5)",
      [a.orgaoId, m.id, item, d.motivo.trim(), texto(valor)]);
  });
}

export async function removerGlosa(a: Ator, id: string, glosaId: string) {
  await comContexto(ctx(a), async (c) => {
    await aberta(c, a, id);
    if (!(await c.query("delete from glosa where id = $1 and medicao_id = $2", [glosaId, id])).rowCount) throw new ErroDeRegra("Glosa não encontrada.");
  });
}

export async function adicionarRetencao(a: Ator, id: string, d: { tipo: TipoRetencao; base: string; aliquota: string; descricao?: string | null }) {
  if (!ROTULO_RETENCAO[d.tipo]) throw new ErroDeRegra("Escolha o tipo de retenção.");
  const base = lerValorBr(d.base);
  const aliquota = lerNumeroBr(d.aliquota);
  if (base == null || base <= ZERO) throw new ErroDeRegra("Informe a base de cálculo.");
  if (aliquota == null || aliquota <= ZERO || aliquota > dec(100)) throw new ErroDeRegra("Alíquota inválida.");
  if (d.tipo === "outra" && !limpo(d.descricao)) throw new ErroDeRegra("Descreva a retenção.");
  await comContexto(ctx(a), async (c) => {
    const m = await aberta(c, a, id);
    if (m.regime === "direta") throw new ErroDeRegra("Execução direta não tem retenção nem pagamento à contratada.");
    const t = await totais(c, id);
    if (base > t.bruto + t.reajuste) throw new ErroDeRegra("A base de cálculo passa do valor medido.");
    const valor = ajustar(mul(base, aliquota / 100n), 2, m.arredondamento);
    if (valor <= ZERO) throw new ErroDeRegra("A retenção calculada é zero.");
    if (t.glosa + t.retencao + valor > t.bruto + t.reajuste) throw new ErroDeRegra("Glosas e retenções passam do valor medido.");
    await c.query("insert into retencao (orgao_id, medicao_id, tipo, descricao, base, aliquota, valor) values ($1,$2,$3,$4,$5,$6,$7)",
      [a.orgaoId, id, d.tipo, limpo(d.descricao), texto(base), texto(aliquota, 4), texto(valor)]);
  });
}

export async function removerRetencao(a: Ator, id: string, retencaoId: string) {
  await comContexto(ctx(a), async (c) => {
    await aberta(c, a, id);
    if (!(await c.query("delete from retencao where id = $1 and medicao_id = $2", [retencaoId, id])).rowCount) throw new ErroDeRegra("Retenção não encontrada.");
  });
}

/**
 * Totais do boletim em elaboração. O reajuste é o fator acumulado das revisões de preço
 * com início até o começo do período, aplicado sobre o valor medido.
 */
async function totais(c: PoolClient, id: string) {
  const r = (await c.query(
    `select coalesce((select sum(valor) from item_medido where medicao_id = $1), 0)::text as bruto,
            coalesce((select sum(valor) from glosa where medicao_id = $1), 0)::text as glosa,
            coalesce((select sum(valor) from retencao where medicao_id = $1), 0)::text as retencao,
            fator_revisao(m.contrato_id, m.periodo_inicio)::text as fator
       from medicao m where m.id = $1`, [id])).rows[0];
  const bruto = dec(r.bruto), glosa = dec(r.glosa), retencao = dec(r.retencao), fator = dec(r.fator);
  const reajuste = ajustar(mul(bruto, fator - UM), 2, "arredondar");
  return { bruto, reajuste, fator, glosa, retencao, liquido: bruto + reajuste - glosa - retencao };
}

/** Percentual de reajuste a partir do fator acumulado (1,05 → 5). */
const pctDoFator = (fator: Dec) => texto((fator - UM) * 100n, 6);

// ---------------------------------------------------------------------------
// Fluxo
// ---------------------------------------------------------------------------
/** O que falta para atestar. Lista vazia quer dizer pronto. */
function pendenciasParaAtestar(m: CabecalhoMedicao, itens: number, hj: string) {
  const p: string[] = [];
  if (!itens) p.push("Boletim sem itens medidos.");
  if (m.periodoFim > hj) p.push("O período ainda não terminou.");
  if (!m.fiscalId) p.push("Contrato sem fiscal designado.");
  return p;
}

export async function atestarMedicao(a: Ator, id: string, observacao?: string | null) {
  exigir(a, "medicao.atestar");
  await comContexto(ctx(a), async (c) => {
    const m = await cabecalho(c, a, id, true);
    if (m.situacao !== "rascunho") throw new ErroDeRegra("Só medição em elaboração pode ser atestada.");
    if (!designado(a, m.fiscalId)) throw new SemPermissao("Só o fiscal designado no contrato atesta a medição.");
    const n = (await c.query("select count(*)::int as n from item_medido where medicao_id = $1", [id])).rows[0].n as number;
    const p = pendenciasParaAtestar(m, n, hoje());
    if (p.length) throw new ErroDeRegra(`Resolva antes de atestar: ${p.join(" ")}`);
    await c.query("update medicao set situacao = 'atestada', atestada_por = $2, atestada_em = now() where id = $1", [id, a.id]);
    await tramitar(c, a, id, "atestada", limpo(observacao));
  });
}

export async function devolverMedicao(a: Ator, id: string, motivo: string) {
  if (!pode(a, "medicao.atestar") && !pode(a, "medicao.aprovar")) throw new SemPermissao();
  if (!motivo.trim()) throw new ErroDeRegra("Informe o motivo da devolução.");
  await comContexto(ctx(a), async (c) => {
    const m = await cabecalho(c, a, id, true);
    if (m.situacao !== "atestada") throw new ErroDeRegra("Só medição atestada pode ser devolvida.");
    if (!designado(a, m.gestorId) && !designado(a, m.fiscalId)) throw new SemPermissao("Só o gestor ou o fiscal do contrato devolvem a medição.");
    await c.query("update medicao set situacao = 'rascunho', atestada_por = null, atestada_em = null where id = $1", [id]);
    await tramitar(c, a, id, "devolvida", motivo.trim());
  });
}

export async function cancelarMedicao(a: Ator, id: string, motivo: string) {
  if (!pode(a, "medicao.elaborar") && !pode(a, "medicao.aprovar")) throw new SemPermissao();
  if (!motivo.trim()) throw new ErroDeRegra("Informe o motivo do cancelamento.");
  await comContexto(ctx(a), async (c) => {
    const m = await cabecalho(c, a, id, true);
    if (m.situacao !== "rascunho" && m.situacao !== "atestada") throw new ErroDeRegra("Medição aprovada não pode ser cancelada. A correção é feita por medição de ajuste.");
    await c.query("update medicao set situacao = 'cancelada' where id = $1", [id]);
    await tramitar(c, a, id, "cancelada", motivo.trim());
  });
}

export async function aprovarMedicao(a: Ator, id: string, observacao?: string | null) {
  exigir(a, "medicao.aprovar");
  await comContexto(ctx(a), async (c) => {
    const m = await cabecalho(c, a, id, true);
    if (m.situacao !== "atestada") throw new ErroDeRegra("A medição precisa ser atestada pelo fiscal antes da aprovação.");
    if (!designado(a, m.gestorId)) throw new SemPermissao("Só o gestor designado no contrato aprova a medição.");
    if (m.atestadaPor === a.id) throw new ErroDeRegra("Quem atestou a medição não pode aprová-la.");
    const t = await totais(c, id);
    if (t.bruto > ZERO && t.glosa + t.retencao > t.bruto + t.reajuste) throw new ErroDeRegra("Glosas e retenções passam do valor medido.");
    await c.query(
      `update medicao set situacao = 'aprovada', aprovada_por = $2, aprovada_em = now(),
              valor_bruto = $3, valor_glosa = $4, valor_retencao = $5, valor_liquido = $6, reajuste_pct = $7, valor_reajuste = $8 where id = $1`,
      [id, a.id, texto(t.bruto), texto(t.glosa), texto(t.retencao), texto(t.liquido), pctDoFator(t.fator), texto(t.reajuste)]);
    await tramitar(c, a, id, "aprovada", limpo(observacao));
    await lancarAvanco(c, a, m);
  });
}

/**
 * Leva o medido ao cronograma: o percentual acumulado de cada item (medições aprovadas)
 * é distribuído pelas atividades do item na linha de base, na ordem em que acontecem.
 * Só registra quando o avanço sobe, porque o avanço físico não volta para trás.
 */
async function lancarAvanco(c: PoolClient, a: Ator, m: CabecalhoMedicao) {
  const crono = (await c.query(
    "select id, to_char(inicio, 'YYYY-MM-DD') as inicio from cronograma where contrato_id = $1 and situacao = 'linha_base'", [m.contratoId])).rows[0];
  if (!crono) return;
  const itens = (await c.query(
    `select i.id, quantidade_vigente(i.id)::text as contratado,
            (select coalesce(sum(x.quantidade), 0) from item_medido x join medicao y on y.id = x.medicao_id
              where x.item_servico_id = i.id and y.situacao = 'aprovada')::text as medido
       from item_servico i where i.id in (select item_servico_id from item_medido where medicao_id = $1)`, [m.id])).rows;
  const hj = hoje();
  for (const i of itens) {
    const contratado = dec(i.contratado);
    if (contratado <= ZERO) continue;
    const pctItem = div(dec(i.medido) * 100n, contratado);
    const ats = (await c.query(
      `select a.id, a.parcela::text,
              (select max(v.percentual) from avanco v where v.atividade_id = a.id)::text as atual,
              (select to_char(max(v.data), 'YYYY-MM-DD') from avanco v where v.atividade_id = a.id) as ultima
         from atividade a where a.cronograma_id = $1 and a.item_servico_id = $2 order by a.inicio nulls last, a.ordem`, [crono.id, i.id])).rows;
    let antes = ZERO;
    for (const at of ats) {
      const parcela = dec(at.parcela);
      const feito = pctItem - antes;
      antes += parcela;
      let p = feito <= ZERO ? ZERO : div(feito * 100n, parcela);
      if (p > dec(100)) p = dec(100);
      p = ajustar(p, 4, "truncar");
      if (p <= dec(at.atual ?? "0")) continue;
      let data = m.periodoFim < hj ? m.periodoFim : hj;
      if (at.ultima && at.ultima > data) data = at.ultima;
      if (data < crono.inicio) data = crono.inicio;
      await c.query("insert into avanco (orgao_id, atividade_id, data, percentual, origem, justificativa) values ($1,$2,$3,$4,'medicao',$5)",
        [a.orgaoId, at.id, data, texto(p, 4), `${rotuloMedicao(m)} aprovada`]);
    }
  }
}

// ---------------------------------------------------------------------------
// Nota fiscal e pagamento
// ---------------------------------------------------------------------------
async function aprovadaParaPagar(c: PoolClient, a: Ator, id: string) {
  exigir(a, "pagamento.registrar");
  const m = await cabecalho(c, a, id, true);
  if (m.situacao !== "aprovada") throw new ErroDeRegra("Só medição aprovada recebe nota fiscal e pagamento.");
  if (m.regime === "direta") throw new ErroDeRegra("Execução direta não tem pagamento à contratada.");
  return m;
}

export async function registrarNotaFiscal(a: Ator, id: string, d: { numero: string; data: string; valor: string }) {
  const valor = lerValorBr(d.valor);
  if (!d.numero.trim()) throw new ErroDeRegra("Informe o número da nota fiscal.");
  if (!dataValida(d.data)) throw new ErroDeRegra("Informe a data da nota fiscal.");
  if (valor == null || valor <= ZERO) throw new ErroDeRegra("Informe o valor da nota fiscal.");
  await comContexto(ctx(a), async (c) => {
    const m = await aprovadaParaPagar(c, a, id);
    const esperado = dec(m.valorBruto) + dec(m.valorReajuste) - dec(m.valorGlosa);
    if (valor !== esperado) {
      throw new ErroDeRegra(`O valor da nota fiscal deve ser o medido${dec(m.valorReajuste) !== ZERO ? " com o reajuste" : ""} menos as glosas: R$ ${moedaBr(esperado)}.`);
    }
    try {
      await c.query("insert into nota_fiscal (orgao_id, medicao_id, numero, data, valor) values ($1,$2,$3,$4,$5)", [a.orgaoId, id, d.numero.trim(), d.data, texto(valor)]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ErroDeRegra("Nota fiscal já registrada nesta medição.");
      throw e;
    }
  });
}

export async function registrarPagamento(a: Ator, id: string, d: { data: string; valor: string; empenho?: string | null; liquidacao?: string | null; ordemBancaria?: string | null }) {
  const valor = lerValorBr(d.valor);
  if (!dataValida(d.data)) throw new ErroDeRegra("Informe a data do pagamento.");
  if (d.data > hoje()) throw new ErroDeRegra("A data do pagamento não pode ser futura.");
  if (valor == null || valor <= ZERO) throw new ErroDeRegra("Informe o valor pago.");
  if (!limpo(d.empenho)) throw new ErroDeRegra("Informe a nota de empenho.");
  await comContexto(ctx(a), async (c) => {
    const m = await aprovadaParaPagar(c, a, id);
    if (m.aprovadaEm && d.data < diaLocal(m.aprovadaEm)) throw new ErroDeRegra("O pagamento não pode ser anterior à aprovação da medição.");
    if (!(await c.query("select 1 from nota_fiscal where medicao_id = $1", [id])).rowCount) throw new ErroDeRegra("Registre a nota fiscal antes do pagamento.");
    await c.query("insert into pagamento (orgao_id, medicao_id, data, valor, empenho, liquidacao, ordem_bancaria) values ($1,$2,$3,$4,$5,$6,$7)",
      [a.orgaoId, id, d.data, texto(valor), limpo(d.empenho), limpo(d.liquidacao), limpo(d.ordemBancaria)]);
  });
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
export type LinhaMedida = {
  itemServicoId: string; etapa: string; numero: string; codigo: string | null; descricao: string; unidade: string; executor: string;
  contratado: string; precoUnitario: string; totalContratado: string;
  anterior: string; nesta: string; acumulado: string; saldo: string; valorNesta: string; valorAcumulado: string; pctAcumulado: number;
  memoria: string | null; medivel: boolean;
  travadaPor: { id: string; numero: number; titulo: string } | null;
};

export type MedicaoCompleta = CabecalhoMedicao & {
  linhas: LinhaMedida[]; etapas: { nome: string; valorNesta: string; linhas: LinhaMedida[] }[];
  glosas: { id: string; motivo: string; valor: string; itemNumero: string | null; por: string | null; em: Date }[];
  retencoes: { id: string; tipo: TipoRetencao; descricao: string | null; base: string; aliquota: string; valor: string }[];
  notas: { id: string; numero: string; data: string; valor: string }[];
  pagamentos: { id: string; data: string; valor: string; empenho: string | null; liquidacao: string | null; ordemBancaria: string | null; por: string | null }[];
  tramites: { acao: string; observacao: string | null; por: string | null; em: Date }[];
  bruto: string; reajuste: string; reajustePctAplicado: number; glosa: string; retencao: string; liquido: string; pago: string; aPagar: string;
  situacaoPagamento: SituacaoPagamento | null; valorNota: string;
  acumuladoContrato: string; acumuladoPct: number; previstoPeriodo: number | null; previstoAcumulado: number | null;
  pendencias: string[]; podeAtestar: boolean; podeAprovar: boolean; hoje: string;
};

export async function obterMedicao(a: Ator, id: string): Promise<MedicaoCompleta> {
  exigirVer(a);
  const r = await comContexto(ctx(a), async (c) => {
    const m = await cabecalho(c, a, id);
    const linhas = (await c.query(
      `select i.id as "itemServicoId", i.etapa, i.numero, i.codigo, i.descricao, i.unidade, i.executor, quantidade_vigente(i.id)::text as contratado,
              i.quantidade::text as "contratadoInicial", i.aditivo_id is not null as "incluidoPorAditivo",
              i.preco_unitario::text as "precoUnitario", total_vigente(i.id)::text as "totalContratado",
              coalesce((select sum(x.quantidade) from item_medido x join medicao y on y.id = x.medicao_id
                         where x.item_servico_id = i.id and y.situacao = 'aprovada' and y.id <> $2 and (y.numero < $3 or $4 <> 'aprovada')), 0)::text as anterior,
              coalesce((select sum(x.valor) from item_medido x join medicao y on y.id = x.medicao_id
                         where x.item_servico_id = i.id and y.situacao = 'aprovada' and y.id <> $2 and (y.numero < $3 or $4 <> 'aprovada')), 0)::text as "valorAnterior",
              coalesce(n.quantidade, 0)::text as nesta, coalesce(n.valor, 0)::text as "valorNesta", n.memoria
         from item_servico i left join item_medido n on n.item_servico_id = i.id and n.medicao_id = $2
        where i.contrato_id = $1 and item_vigente(i.id)
        order by i.ordem`, [m.contratoId, id, m.numero, m.situacao])).rows;
    const glosas = (await c.query(
      `select g.id, g.motivo, g.valor::text, i.numero as "itemNumero", u.nome as por, g.criado_em as em
         from glosa g left join item_servico i on i.id = g.item_servico_id left join usuario u on u.id = g.criado_por where g.medicao_id = $1 order by g.criado_em`, [id])).rows;
    const retencoes = (await c.query(
      "select id, tipo, descricao, base::text, aliquota::text, valor::text from retencao where medicao_id = $1 order by criado_em", [id])).rows;
    const notas = (await c.query("select id, numero, to_char(data, 'YYYY-MM-DD') as data, valor::text from nota_fiscal where medicao_id = $1 order by data", [id])).rows;
    const pagamentos = (await c.query(
      `select p.id, to_char(p.data, 'YYYY-MM-DD') as data, p.valor::text, p.empenho, p.liquidacao, p.ordem_bancaria as "ordemBancaria", u.nome as por
         from pagamento p left join usuario u on u.id = p.criado_por where p.medicao_id = $1 order by p.data, p.criado_em`, [id])).rows;
    const tramites = (await c.query(
      `select t.acao, t.observacao, u.nome as por, t.em from medicao_tramite t left join usuario u on u.id = t.usuario_id where t.medicao_id = $1 order by t.em`, [id])).rows;
    const t = await totais(c, id);
    const travas = await impeditivasDoContrato(c, m.contratoId);
    return { m, linhas, glosas, retencoes, notas, pagamentos, tramites, t, travas };
  });
  const { m, t } = r;
  const hj = hoje();
  const linhas: LinhaMedida[] = r.linhas.map((l) => {
    const contratado = dec(l.contratado), anterior = dec(l.anterior), nesta = dec(l.nesta);
    const acumulado = anterior + nesta;
    const valorAcumulado = dec(l.valorAnterior) + dec(l.valorNesta);
    return {
      ...l, contratado: texto(contratado, 4), anterior: texto(anterior, 4), nesta: texto(nesta, 4), acumulado: texto(acumulado, 4), saldo: texto(contratado - acumulado, 4),
      valorAcumulado: texto(valorAcumulado), pctAcumulado: contratado > ZERO ? paraNumero(div(acumulado * 100n, contratado)) : 0,
      medivel: m.regime === "direta" || l.executor === "contratada",
      travadaPor: r.travas.get(l.itemServicoId) ?? null,
    };
  });
  const etapas: MedicaoCompleta["etapas"] = [];
  for (const l of linhas) {
    let e = etapas.find((x) => x.nome === l.etapa);
    if (!e) { e = { nome: l.etapa, valorNesta: "0", linhas: [] }; etapas.push(e); }
    e.linhas.push(l);
  }
  for (const e of etapas) e.valorNesta = texto(e.linhas.reduce((s, l) => s + dec(l.valorNesta), ZERO));
  const aprovada = m.situacao === "aprovada";
  const bruto = aprovada ? dec(m.valorBruto) : t.bruto;
  const reajuste = aprovada ? dec(m.valorReajuste) : t.reajuste;
  const reajustePct = aprovada ? Number(m.reajustePct) : Number(pctDoFator(t.fator));
  const glosa = aprovada ? dec(m.valorGlosa) : t.glosa;
  const retencao = aprovada ? dec(m.valorRetencao) : t.retencao;
  const liquido = aprovada ? dec(m.valorLiquido) : t.liquido;
  const pago = r.pagamentos.reduce((s, p) => s + dec(p.valor), ZERO);
  const acumuladoContrato = linhas.reduce((s, l) => s + dec(l.valorAcumulado), ZERO);
  const valorContrato = dec(m.valorContratual);
  const previsto = await previstoDoContrato(a, m.contratoId, m.periodoInicio, m.periodoFim);
  const itensMedidos = linhas.filter((l) => dec(l.nesta) !== ZERO).length;
  return {
    ...m, linhas, etapas, glosas: r.glosas, retencoes: r.retencoes, notas: r.notas, pagamentos: r.pagamentos, tramites: r.tramites,
    bruto: texto(bruto), reajuste: texto(reajuste), reajustePctAplicado: reajustePct, glosa: texto(glosa), retencao: texto(retencao), liquido: texto(liquido), pago: texto(pago),
    valorNota: texto(bruto + reajuste - glosa),
    aPagar: texto(aprovada && liquido > pago ? liquido - pago : ZERO),
    situacaoPagamento: aprovada && m.regime !== "direta" ? situacaoPagamento(liquido, pago) : null,
    acumuladoContrato: texto(acumuladoContrato), acumuladoPct: valorContrato > ZERO ? paraNumero(div(acumuladoContrato * 100n, valorContrato)) : 0,
    previstoPeriodo: previsto?.periodo ?? null, previstoAcumulado: previsto?.acumulado ?? null,
    pendencias: m.situacao === "rascunho" ? [
      ...pendenciasParaAtestar(m, itensMedidos, hj),
      ...linhas.filter((l) => l.travadaPor && dec(l.nesta) > ZERO).map((l) => `Item ${l.numero} com não conformidade nº ${l.travadaPor!.numero} impeditiva em aberto.`),
    ] : [],
    podeAtestar: m.situacao === "rascunho" && pode(a, "medicao.atestar") && designado(a, m.fiscalId),
    podeAprovar: m.situacao === "atestada" && pode(a, "medicao.aprovar") && designado(a, m.gestorId) && m.atestadaPor !== a.id,
    hoje: hj,
  };
}

function situacaoPagamento(liquido: Dec, pago: Dec): SituacaoPagamento {
  if (liquido <= ZERO) return "sem_valor";
  if (pago >= liquido) return "paga";
  return pago > ZERO ? "parcial" : "a_pagar";
}

/** Valor previsto pela linha de base do cronograma no período e acumulado até o fim dele. */
async function previstoDoContrato(a: Ator, contratoId: string, de: string, ate: string) {
  return comContexto(ctx(a), async (c) => {
    const k = (await c.query(
      "select id, calendario from cronograma where contrato_id = $1 and situacao = 'linha_base'", [contratoId])).rows[0];
    if (!k) return null;
    const ats = (await c.query(
      `select to_char(a.inicio, 'YYYY-MM-DD') as inicio, to_char(a.fim, 'YYYY-MM-DD') as fim, a.duracao,
              coalesce(total_vigente(i.id) * a.parcela / 100, 0)::float8 as valor
         from atividade a left join item_servico i on i.id = a.item_servico_id where a.cronograma_id = $1 and a.inicio is not null`, [k.id])).rows;
    const fer = (await c.query("select to_char(data, 'YYYY-MM-DD') as d from feriado")).rows.map((l) => l.d as string);
    const cal: Calendario = { tipo: k.calendario, feriados: new Set(fer) };
    const curva: AtividadeCurva[] = ats.map((x, n) => ({ id: String(n), inicio: x.inicio, fim: x.fim, duracao: x.duracao, valor: x.valor, avancos: [] }));
    const ateFim = curva.reduce((s, x) => s + planejadoAte(x, ate, cal), 0);
    const antes = curva.reduce((s, x) => s + planejadoAte(x, somarDias(de, -1), cal), 0);
    return { periodo: Math.round((ateFim - antes) * 100) / 100, acumulado: Math.round(ateFim * 100) / 100 };
  });
}

export type ResumoMedicao = {
  id: string; numero: number; ajuste: boolean; periodoInicio: string; periodoFim: string; situacao: SituacaoMedicao;
  contratoId: string; contratoNumero: string; regime: Regime; obraId: string; obraCodigo: string; obraNome: string; empresaNome: string | null;
  bruto: string; reajuste: string; glosa: string; retencao: string; liquido: string; pago: string; situacaoPagamento: SituacaoPagamento | null;
  criadoEm: Date; atestadaEm: Date | null; aprovadaEm: Date | null; diasEmAndamento: number;
};

export async function listarMedicoes(a: Ator, f: { contratoId?: string; obraId?: string; situacao?: SituacaoMedicao | "a_pagar" } = {}): Promise<ResumoMedicao[]> {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const v = visivel(a, 1);
    const params = [...v.params];
    const cond = [v.sql];
    if (f.contratoId) { params.push(f.contratoId); cond.push(`m.contrato_id = $${params.length}`); }
    if (f.obraId) { params.push(f.obraId); cond.push(`k.obra_id = $${params.length}`); }
    if (f.situacao && f.situacao !== "a_pagar") { params.push(f.situacao); cond.push(`m.situacao = $${params.length}`); }
    const r = await c.query(
      `select m.id, m.numero, m.ajuste, to_char(m.periodo_inicio, 'YYYY-MM-DD') as "periodoInicio", to_char(m.periodo_fim, 'YYYY-MM-DD') as "periodoFim",
              m.situacao, k.id as "contratoId", k.numero as "contratoNumero", k.regime, k.obra_id as "obraId", b.codigo as "obraCodigo", b.nome as "obraNome",
              e.razao_social as "empresaNome", m.criado_em as "criadoEm", m.atestada_em as "atestadaEm", m.aprovada_em as "aprovadaEm",
              coalesce(m.valor_bruto, (select sum(valor) from item_medido where medicao_id = m.id), 0)::text as bruto,
              case when m.situacao = 'aprovada' then m.valor_reajuste
                   else round(coalesce((select sum(valor) from item_medido where medicao_id = m.id), 0) * (fator_revisao(m.contrato_id, m.periodo_inicio) - 1), 2) end::text as reajuste,
              coalesce(m.valor_glosa, (select sum(valor) from glosa where medicao_id = m.id), 0)::text as glosa,
              coalesce(m.valor_retencao, (select sum(valor) from retencao where medicao_id = m.id), 0)::text as retencao,
              coalesce((select sum(valor) from pagamento where medicao_id = m.id), 0)::text as pago
         from medicao m join contrato k on k.id = m.contrato_id join obra b on b.id = k.obra_id left join empresa e on e.id = k.empresa_id
        where ${cond.join(" and ")}
        order by (m.situacao in ('rascunho', 'atestada')) desc, m.criado_em desc`, params);
    const agora = Date.now();
    const lista = r.rows.map((l) => {
      const liquido = dec(l.bruto) + dec(l.reajuste) - dec(l.glosa) - dec(l.retencao);
      return {
        ...l, liquido: texto(liquido),
        situacaoPagamento: l.situacao === "aprovada" && l.regime !== "direta" ? situacaoPagamento(liquido, dec(l.pago)) : null,
        diasEmAndamento: Math.floor((agora - new Date(l.criadoEm).getTime()) / 86_400_000),
      } as ResumoMedicao;
    });
    return f.situacao === "a_pagar" ? lista.filter((l) => l.situacaoPagamento === "a_pagar" || l.situacaoPagamento === "parcial") : lista;
  });
}

/** Totais financeiros por contrato a partir das medições aprovadas e dos pagamentos. */
export async function financeiroDosContratos(a: Ator, contratoIds: string[]) {
  if (!contratoIds.length || !pode(a, "medicao.ver")) return new Map<string, { medido: string; pago: string; liquido: string; retido: string; glosado: string }>();
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select m.contrato_id as id, coalesce(sum(m.valor_bruto), 0)::text as medido, coalesce(sum(m.valor_liquido), 0)::text as liquido,
              coalesce(sum(m.valor_retencao), 0)::text as retido, coalesce(sum(m.valor_glosa), 0)::text as glosado,
              coalesce(sum((select sum(p.valor) from pagamento p where p.medicao_id = m.id)), 0)::text as pago
         from medicao m where m.situacao = 'aprovada' and m.contrato_id = any($1::uuid[]) group by m.contrato_id`, [contratoIds]);
    return new Map(r.rows.map((l) => [l.id as string, l]));
  });
}

export type Extrato = {
  contratoId: string; rotulo: string; valorContrato: string; medido: string; reajustado: string; glosado: string; retido: string; liquido: string; pago: string;
  aPagar: string; saldo: string; executadoPct: number; medicoes: ResumoMedicao[];
};

/** Extrato financeiro do contrato: cada medição com seus valores e o saldo depois dela. */
export async function extratoDoContrato(a: Ator, contratoId: string): Promise<Extrato> {
  exigirVer(a);
  const k = await comContexto(ctx(a), (c) => contratoVisivel(c, a, contratoId));
  const medicoes = (await listarMedicoes(a, { contratoId })).sort((x, y) => x.numero - y.numero);
  const aprovadas = medicoes.filter((m) => m.situacao === "aprovada");
  const soma = (f: (m: ResumoMedicao) => string) => aprovadas.reduce((s, m) => s + dec(f(m)), ZERO);
  const medido = soma((m) => m.bruto), liquido = soma((m) => m.liquido), pago = soma((m) => m.pago);
  const valor = dec(k.valorContratual);
  return {
    contratoId, rotulo: rotuloContrato({ numero: k.contratoNumero, regime: k.regime }), valorContrato: k.valorContratual,
    medido: texto(medido), reajustado: texto(soma((m) => m.reajuste)), glosado: texto(soma((m) => m.glosa)), retido: texto(soma((m) => m.retencao)), liquido: texto(liquido), pago: texto(pago),
    aPagar: texto(liquido > pago ? liquido - pago : ZERO), saldo: texto(valor - medido),
    executadoPct: valor > ZERO ? paraNumero(div(medido * 100n, valor)) : 0, medicoes,
  };
}

/** Indicadores do painel de medições. */
export async function panoramaMedicoes(a: Ator) {
  const lista = await listarMedicoes(a);
  const hj = hoje();
  const mes = hj.slice(0, 7);
  const aprovadas = lista.filter((m) => m.situacao === "aprovada");
  const tempos = aprovadas.filter((m) => m.aprovadaEm).map((m) => (new Date(m.aprovadaEm!).getTime() - new Date(m.criadoEm).getTime()) / 86_400_000);
  const doMes = aprovadas.filter((m) => m.aprovadaEm && diaLocal(m.aprovadaEm).slice(0, 7) === mes);
  const somar = (xs: ResumoMedicao[], f: (m: ResumoMedicao) => string) => texto(xs.reduce((s, m) => s + dec(f(m)), ZERO));
  const aPagar = aprovadas.filter((m) => m.situacaoPagamento === "a_pagar" || m.situacaoPagamento === "parcial");
  return {
    lista,
    elaboracao: lista.filter((m) => m.situacao === "rascunho").length,
    paraAprovar: lista.filter((m) => m.situacao === "atestada").length,
    aPagar: aPagar.length,
    valorAPagar: texto(aPagar.reduce((s, m) => s + dec(m.liquido) - dec(m.pago), ZERO)),
    tempoMedioAprovacao: tempos.length ? tempos.reduce((s, x) => s + x, 0) / tempos.length : null,
    medidoNoMes: somar(doMes, (m) => m.bruto),
    retidoNoMes: somar(doMes, (m) => m.retencao),
    mes,
  };
}

export const valorRetencaoSugerido = (bruto: string, tipo: TipoRetencao) =>
  texto(mul(dec(bruto), dec(SUGESTAO_RETENCAO[tipo].basePct) / 100n));

/** Últimos pagamentos registrados nas obras visíveis. */
export async function pagamentosRecentes(a: Ator, limite = 50) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const v = visivel(a, 2);
    const r = await c.query(
      `select p.id, to_char(p.data, 'YYYY-MM-DD') as data, p.valor::text, p.empenho, p.ordem_bancaria as "ordemBancaria",
              m.id as "medicaoId", m.numero, m.ajuste, k.numero as "contratoNumero", b.codigo as "obraCodigo", e.razao_social as "empresaNome"
         from pagamento p join medicao m on m.id = p.medicao_id join contrato k on k.id = m.contrato_id join obra b on b.id = k.obra_id
         left join empresa e on e.id = k.empresa_id
        where ${v.sql}
        order by p.data desc, p.criado_em desc limit $1`, [limite, ...v.params]);
    const mesAtual = hoje().slice(0, 7);
    const pagoNoMes = (await c.query(
      `select coalesce(sum(p.valor), 0)::text as total
         from pagamento p join medicao m on m.id = p.medicao_id join contrato k on k.id = m.contrato_id join obra b on b.id = k.obra_id
        where to_char(p.data, 'YYYY-MM') = $1 and ${visivel(a, 2).sql}`, [mesAtual, ...visivel(a, 2).params])).rows[0].total as string;
    return r.rows.map((l) => ({ ...l, mesAtual, pagoNoMes })) as {
      id: string; data: string; valor: string; empenho: string | null; ordemBancaria: string | null; medicaoId: string; numero: number; ajuste: boolean;
      contratoNumero: string; obraCodigo: string; empresaNome: string | null; mesAtual: string; pagoNoMes: string;
    }[];
  });
}
