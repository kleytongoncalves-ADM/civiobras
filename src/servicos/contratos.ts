import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { ajustar, dec, lerNumeroBr, lerValorBr, mul, texto, UM, ZERO, type Dec, type Regra } from "../lib/decimal";
import { diasEntre, somarDias } from "./cpm";
import type { Ator } from "./obras";
import { obterOrcamento, rotuloOrcamento } from "./orcamentos";
import { exigir, pode, SemPermissao } from "./permissoes";
import type { Fonte } from "./precos";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string | null | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);
const limpo = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const dataValida = (v: string | null | undefined) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

export type TipoEmpresa = "contratada" | "fornecedor" | "terceirizada";
export type Regime = "preco_unitario" | "preco_global" | "integral" | "tarefa" | "integrada" | "semi_integrada" | "direta";
export type SituacaoContrato = "rascunho" | "vigente" | "encerrado" | "rescindido";
export type Executor = "contratada" | "equipe_propria";
export type Modalidade = "caucao" | "seguro_garantia" | "fianca_bancaria";
export type Natureza = "obra_nova" | "reforma";

export const REGIMES: Regime[] = ["preco_unitario", "preco_global", "integral", "tarefa", "integrada", "semi_integrada", "direta"];
export const ROTULO_REGIME_EXECUCAO: Record<Regime, string> = {
  preco_unitario: "Empreitada por preço unitário",
  preco_global: "Empreitada por preço global",
  integral: "Empreitada integral",
  tarefa: "Contratação por tarefa",
  integrada: "Contratação integrada",
  semi_integrada: "Contratação semi-integrada",
  direta: "Execução direta (equipe própria)",
};
export const ROTULO_SITUACAO_CONTRATO: Record<SituacaoContrato, string> = {
  rascunho: "Em elaboração", vigente: "Vigente", encerrado: "Encerrado", rescindido: "Rescindido",
};
export const ROTULO_EXECUTOR: Record<Executor, string> = { contratada: "Contratada", equipe_propria: "Equipe própria" };
export const ROTULO_MODALIDADE: Record<Modalidade, string> = {
  caucao: "Caução em dinheiro", seguro_garantia: "Seguro-garantia", fianca_bancaria: "Fiança bancária",
};
export const ROTULO_NATUREZA: Record<Natureza, string> = { obra_nova: "Obra ou serviço novo", reforma: "Reforma de edifício ou equipamento" };
/** Limite de acréscimo da Lei 14.133/2021, art. 125. */
export const LIMITE_ADITIVO: Record<Natureza, number> = { obra_nova: 25, reforma: 50 };
export const ROTULO_TIPO_EMPRESA: Record<TipoEmpresa, string> = { contratada: "Contratada", fornecedor: "Fornecedor", terceirizada: "Terceirizada" };
export const INDICES = ["INCC-DI", "IPCA", "SINAPI", "IGP-M"];

// ---------------------------------------------------------------------------
// Empresas
// ---------------------------------------------------------------------------
export type Empresa = {
  id: string; razaoSocial: string; cnpj: string; tipo: TipoEmpresa; responsavel: string | null;
  email: string | null; telefone: string | null; ativa: boolean; contratos: number;
};
export type DadosEmpresa = { razaoSocial: string; cnpj: string; tipo: TipoEmpresa; responsavel?: string | null; email?: string | null; telefone?: string | null };

export const soDigitos = (v: string) => v.replace(/\D/g, "");

/** Dígitos verificadores do CNPJ (formato numérico de 14 dígitos). */
export function cnpjValido(v: string) {
  const d = soDigitos(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (n: number) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((t, p, i) => t + p * Number(d[i]), 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export const formatarCnpj = (v: string) => soDigitos(v).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

export async function listarEmpresas(a: Ator): Promise<Empresa[]> {
  if (!pode(a, "contrato.ver")) throw new SemPermissao();
  return comContexto(ctx(a), async (c) => (await c.query(
    `select e.id, e.razao_social as "razaoSocial", e.cnpj, e.tipo, e.responsavel, e.email, e.telefone, e.ativa,
            (select count(*)::int from contrato k where k.empresa_id = e.id) as contratos
       from empresa e order by e.razao_social`)).rows);
}

export async function salvarEmpresa(a: Ator, d: DadosEmpresa, id?: string): Promise<string> {
  exigir(a, "contrato.editar");
  if (!d.razaoSocial.trim()) throw new ErroDeRegra("Informe a razão social.");
  if (!cnpjValido(d.cnpj)) throw new ErroDeRegra("CNPJ inválido.");
  const email = limpo(d.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroDeRegra("E-mail inválido.");
  const valores = [d.razaoSocial.trim(), soDigitos(d.cnpj), d.tipo, limpo(d.responsavel), email, limpo(d.telefone)];
  return comContexto(ctx(a), async (c) => {
    try {
      if (id) {
        const r = await c.query(
          "update empresa set razao_social = $2, cnpj = $3, tipo = $4, responsavel = $5, email = $6, telefone = $7 where id = $1 returning id", [id, ...valores]);
        if (!r.rowCount) throw new ErroDeRegra("Empresa não encontrada.");
        return id;
      }
      return (await c.query(
        "insert into empresa (orgao_id, razao_social, cnpj, tipo, responsavel, email, telefone) values ($1,$2,$3,$4,$5,$6,$7) returning id",
        [a.orgaoId, ...valores])).rows[0].id;
    } catch (e) {
      if ((e as { constraint?: string }).constraint === "empresa_cnpj_unico") throw new ErroDeRegra("Já existe uma empresa com este CNPJ.");
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------
export type DadosContrato = {
  orcamentoId: string; empresaId?: string | null; numero: string; processo?: string | null; objeto: string;
  regime: Regime; natureza: Natureza; desconto?: string | null;
  dataAssinatura?: string | null; dataOrdemServico?: string | null; prazoExecucaoDias?: string | number | null;
  vigenciaFim?: string | null; dataBase?: string | null; indiceReajuste?: string | null;
  gestorId?: string | null; fiscalId?: string | null;
};

export type ItemServico = {
  id: string; etapa: string; numero: string; ordem: number; fonte: Fonte; codigo: string | null; descricao: string;
  unidade: string; quantidade: string; precoUnitario: string; total: string; executor: Executor; orcamentoItemId: string | null;
  incluidoPorAditivo?: boolean; alteradoPorAditivo?: boolean;
};

export type Garantia = { id: string; modalidade: Modalidade; valor: string; instituicao: string | null; documento: string | null; inicio: string; vencimento: string };

export type Contrato = {
  id: string; obraId: string; obraNome: string; obraCodigo: string; obraSituacao: string;
  orcamentoId: string; orcamentoNome: string; orcamentoRotulo: string; arredondamento: Regra;
  empresaId: string | null; empresaNome: string | null; empresaCnpj: string | null;
  numero: string; processo: string | null; objeto: string; regime: Regime; natureza: Natureza; desconto: string;
  valorInicial: string; dataAssinatura: string | null; dataOrdemServico: string | null; prazoExecucaoDias: number | null;
  vigenciaFim: string | null; dataBase: string | null; indiceReajuste: string | null;
  gestorId: string | null; gestorNome: string | null; fiscalId: string | null; fiscalNome: string | null;
  situacao: SituacaoContrato; assinadoPor: string | null; assinadoEm: Date | null; criadoEm: Date;
  medidoAprovado: string; pagoTotal: string; medicoesAbertas: number;
  prazoInicialDias: number | null; vigenciaInicial: string | null; acrescimos: string; supressoes: string;
  aditivosAssinados: number; aditivosAbertos: number; revisoes: number; ultimoReajuste: string | null; reajusteMedido: string; fatorRevisao: string; fatorReajuste: string;
};

const COLUNAS = `k.id, k.obra_id as "obraId", b.nome as "obraNome", b.codigo as "obraCodigo", b.situacao as "obraSituacao",
  k.orcamento_id as "orcamentoId", o.nome as "orcamentoNome", lpad(o.numero::text, 3, '0') || ' v' || o.versao as "orcamentoRotulo", o.arredondamento,
  k.empresa_id as "empresaId", e.razao_social as "empresaNome", e.cnpj as "empresaCnpj",
  k.numero, k.processo, k.objeto, k.regime, k.natureza, k.desconto::text, k.valor_inicial::text as "valorInicial",
  to_char(k.data_assinatura, 'YYYY-MM-DD') as "dataAssinatura", to_char(k.data_ordem_servico, 'YYYY-MM-DD') as "dataOrdemServico",
  prazo_vigente(k.id) as "prazoExecucaoDias", to_char(vigencia_vigente(k.id), 'YYYY-MM-DD') as "vigenciaFim",
  k.prazo_execucao_dias as "prazoInicialDias", to_char(k.vigencia_fim, 'YYYY-MM-DD') as "vigenciaInicial",
  (select coalesce(sum(ad.valor_acrescimo), 0) from aditivo ad where ad.contrato_id = k.id and ad.situacao = 'assinado')::text as acrescimos,
  (select coalesce(sum(ad.valor_supressao), 0) from aditivo ad where ad.contrato_id = k.id and ad.situacao = 'assinado')::text as supressoes,
  (select count(*)::int from aditivo ad where ad.contrato_id = k.id and ad.situacao = 'assinado') as "aditivosAssinados",
  (select count(*)::int from aditivo ad where ad.contrato_id = k.id and ad.situacao = 'rascunho') as "aditivosAbertos",
  (select count(*)::int from revisao_preco rp where rp.contrato_id = k.id) as revisoes,
  (select to_char(max(rp.inicio), 'YYYY-MM-DD') from revisao_preco rp where rp.contrato_id = k.id and rp.tipo = 'reajuste') as "ultimoReajuste",
  (select coalesce(sum(mm.valor_reajuste), 0) from medicao mm where mm.contrato_id = k.id and mm.situacao = 'aprovada')::text as "reajusteMedido",
  fator_revisao(k.id, hoje_local())::text as "fatorRevisao", fator_revisao(k.id, hoje_local(), true)::text as "fatorReajuste",
  to_char(k.data_base, 'YYYY-MM-DD') as "dataBase", k.indice_reajuste as "indiceReajuste",
  k.gestor_id as "gestorId", ug.nome as "gestorNome", k.fiscal_id as "fiscalId", uf.nome as "fiscalNome",
  k.situacao, ua.nome as "assinadoPor", k.assinado_em as "assinadoEm", k.criado_em as "criadoEm",
  (select coalesce(sum(mm.valor_bruto), 0) from medicao mm where mm.contrato_id = k.id and mm.situacao = 'aprovada')::text as "medidoAprovado",
  (select coalesce(sum(p.valor), 0) from pagamento p join medicao mm on mm.id = p.medicao_id where mm.contrato_id = k.id)::text as "pagoTotal",
  (select count(*)::int from medicao mm where mm.contrato_id = k.id and mm.situacao in ('rascunho', 'atestada')) as "medicoesAbertas"`;

const DE = `from contrato k join obra b on b.id = k.obra_id join orcamento o on o.id = k.orcamento_id
  left join empresa e on e.id = k.empresa_id left join usuario ug on ug.id = k.gestor_id
  left join usuario uf on uf.id = k.fiscal_id left join usuario ua on ua.id = k.assinado_por`;

function visivel(a: Ator, n: number) {
  if (pode(a, "obra.ver_todas")) return { sql: "true", params: [] as unknown[] };
  return {
    sql: `exists (select 1 from vinculo_obra v where v.obra_id = k.obra_id and v.usuario_id = $${n} and (v.fim is null or v.fim >= hoje_local()))`,
    params: [a.id],
  };
}

function exigirVer(a: Ator) {
  if (!pode(a, "contrato.ver")) throw new SemPermissao();
}

export const rotuloContrato = (k: { numero: string; regime: Regime }) => (k.regime === "direta" ? `Execução direta ${k.numero}` : `Contrato ${k.numero}`);

/** Mesmo dia, um ano depois (29/02 vira 28/02). Marca quando cabe o próximo reajuste. */
export function anoDepois(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const ultimo = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}

/** Último dia do prazo de execução, contado em dias corridos a partir da ordem de serviço. */
export const fimDaExecucao = (k: { dataOrdemServico: string | null; prazoExecucaoDias: number | null }) =>
  k.dataOrdemServico && k.prazoExecucaoDias ? somarDias(k.dataOrdemServico, k.prazoExecucaoDias - 1) : null;

/**
 * valorContratual: inicial com acréscimos e supressões dos aditivos, a preços do contrato.
 * valorAtual: valorContratual com o reajuste já medido e o reajuste em vigor aplicado ao saldo.
 * saldo: valorContratual menos o medido, a preços do contrato.
 */
export type ResumoContrato = Contrato & {
  valorContratual: string; valorAtual: string; reajusteSaldo: string; medido: string; pago: string; saldo: string;
  executadoPct: number; diasParaVencer: number | null;
};

const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

function resumir(k: Contrato): ResumoContrato {
  const valorContratual = dec(k.valorInicial) + dec(k.acrescimos) - dec(k.supressoes);
  const medido = dec(k.medidoAprovado);
  const saldo = valorContratual - medido;
  const reajusteSaldo = saldo > ZERO ? ajustar(mul(saldo, dec(k.fatorRevisao) - UM), 2, "arredondar") : ZERO;
  const valorAtual = valorContratual + dec(k.reajusteMedido) + reajusteSaldo;
  return {
    ...k, valorContratual: texto(valorContratual), valorAtual: texto(valorAtual), reajusteSaldo: texto(reajusteSaldo),
    medido: texto(medido), pago: texto(dec(k.pagoTotal)), saldo: texto(saldo),
    executadoPct: valorContratual > ZERO ? Number(texto((medido * 100n * UM) / valorContratual, 4)) : 0,
    diasParaVencer: k.vigenciaFim ? diasEntre(hoje(), k.vigenciaFim) : null,
  };
}

export async function listarContratos(a: Ator, f: { obraId?: string; situacao?: string } = {}): Promise<ResumoContrato[]> {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const v = visivel(a, 1);
    const params = [...v.params];
    const cond = [v.sql];
    if (f.obraId) { params.push(f.obraId); cond.push(`k.obra_id = $${params.length}`); }
    if (f.situacao) { params.push(f.situacao); cond.push(`k.situacao = $${params.length}`); }
    const r = await c.query(`select ${COLUNAS} ${DE} where ${cond.join(" and ")} order by k.situacao = 'vigente' desc, k.vigencia_fim nulls last, k.numero`, params);
    return (r.rows as Contrato[]).map(resumir);
  });
}

async function cabecalho(c: PoolClient, a: Ator, id: string): Promise<Contrato> {
  if (!uuid(id)) throw new ErroDeRegra("Contrato não encontrado.");
  const v = visivel(a, 2);
  const r = await c.query(`select ${COLUNAS} ${DE} where k.id = $1 and ${v.sql}`, [id, ...v.params]);
  if (!r.rows[0]) throw new ErroDeRegra("Contrato não encontrado ou fora do seu acesso.");
  return r.rows[0];
}

/** Contrato visível ao ator, com os valores vigentes, dentro de uma transação já aberta. */
export async function contratoNaTransacao(c: PoolClient, a: Ator, id: string, travar = false): Promise<ResumoContrato> {
  exigirVer(a);
  if (travar && uuid(id)) await c.query("select 1 from contrato where id = $1 for update", [id]);
  return resumir(await cabecalho(c, a, id));
}

/** Orçamentos aprovados que ainda não têm contrato em elaboração ou vigente. */
export async function orcamentosParaContratar(a: Ator) {
  exigir(a, "contrato.editar");
  return comContexto(ctx(a), async (c) => {
    const vis = pode(a, "obra.ver_todas") ? "true"
      : "exists (select 1 from vinculo_obra v where v.obra_id = o.obra_id and v.usuario_id = $1 and (v.fim is null or v.fim >= hoje_local()))";
    const r = await c.query(
      `select o.id, o.nome, o.numero, o.versao, o.obra_id as "obraId", b.codigo as "obraCodigo", b.nome as "obraNome",
              b.forma_execucao as "formaExecucao", b.tipo as "tipoObra"
         from orcamento o join obra b on b.id = o.obra_id
        where o.situacao = 'aprovado' and ${vis}
          and not exists (select 1 from contrato k where k.orcamento_id = o.id and k.situacao in ('rascunho', 'vigente'))
        order by b.codigo`, pode(a, "obra.ver_todas") ? [] : [a.id]);
    return r.rows.map((o) => ({ ...o, rotulo: rotuloOrcamento(o) })) as {
      id: string; nome: string; rotulo: string; obraId: string; obraCodigo: string; obraNome: string; formaExecucao: string; tipoObra: string;
    }[];
  });
}

/** Pessoas do órgão que podem ser designadas gestor ou fiscal. */
export async function pessoasDesignaveis(a: Ator) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => (await c.query(
    `select id, nome, perfil from usuario where ativo and perfil in ('direcao', 'gestor_contrato', 'engenheiro', 'fiscal') order by nome`)).rows as
    { id: string; nome: string; perfil: string }[]);
}

function validar(d: DadosContrato) {
  if (!d.numero.trim()) throw new ErroDeRegra("Informe o número do contrato.");
  if (!d.objeto.trim()) throw new ErroDeRegra("Informe o objeto.");
  if (!REGIMES.includes(d.regime)) throw new ErroDeRegra("Escolha o regime de execução.");
  if (d.natureza !== "obra_nova" && d.natureza !== "reforma") throw new ErroDeRegra("Escolha a natureza do objeto.");
  if (d.regime !== "direta" && !uuid(d.empresaId)) throw new ErroDeRegra("Escolha a empresa contratada.");
  for (const [v, nome] of [[d.dataAssinatura, "assinatura"], [d.dataOrdemServico, "ordem de serviço"], [d.vigenciaFim, "fim da vigência"], [d.dataBase, "data-base"]] as const) {
    if (!dataValida(v)) throw new ErroDeRegra(`Data de ${nome} inválida.`);
  }
  const prazo = d.prazoExecucaoDias == null || d.prazoExecucaoDias === "" ? null : Number(d.prazoExecucaoDias);
  if (prazo != null && (!Number.isInteger(prazo) || prazo <= 0 || prazo > 3650)) throw new ErroDeRegra("Prazo de execução inválido.");
  if (d.dataAssinatura && d.dataOrdemServico && d.dataOrdemServico < d.dataAssinatura) throw new ErroDeRegra("A ordem de serviço não pode ser anterior à assinatura.");
  if (d.dataAssinatura && d.vigenciaFim && d.vigenciaFim < d.dataAssinatura) throw new ErroDeRegra("O fim da vigência não pode ser anterior à assinatura.");
  const fimExec = d.dataOrdemServico && prazo ? somarDias(d.dataOrdemServico, prazo - 1) : null;
  if (fimExec && d.vigenciaFim && d.vigenciaFim < fimExec) throw new ErroDeRegra("A vigência termina antes do fim do prazo de execução.");
  const desconto = d.desconto ? lerNumeroBr(d.desconto) : ZERO;
  if (desconto == null || desconto < ZERO || desconto >= dec(100)) throw new ErroDeRegra("Desconto inválido.");
  return { prazo, desconto };
}

/** Preço da proposta: preço do orçamento com o desconto, pela regra de casas do orçamento. */
export function precoComDesconto(preco: Dec, desconto: Dec, regra: Regra) {
  return ajustar(mul(preco, UM - desconto / 100n), 2, regra);
}

async function gerarPlanilha(c: PoolClient, a: Ator, contratoId: string, o: Awaited<ReturnType<typeof obterOrcamento>>, desconto: Dec, regime: Regime, formaExecucao: string) {
  await c.query("delete from item_servico where contrato_id = $1", [contratoId]);
  let planilha = (await c.query("select id from planilha_contratual where contrato_id = $1 and versao = 1", [contratoId])).rows[0]?.id as string | undefined;
  if (!planilha) {
    planilha = (await c.query("insert into planilha_contratual (orgao_id, contrato_id, versao, origem) values ($1,$2,1,'inicial') returning id", [a.orgaoId, contratoId])).rows[0].id as string;
  }
  const executor: Executor = regime === "direta" || formaExecucao === "direta" ? "equipe_propria" : "contratada";
  let total = ZERO;
  let ordem = 0;
  for (const e of o.etapas) {
    for (const i of e.itens) {
      ordem += 1;
      const pu = precoComDesconto(dec(i.precoUnitario), desconto, o.arredondamento);
      const t = ajustar(mul(dec(i.quantidade), pu), 2, o.arredondamento);
      total += t;
      await c.query(
        `insert into item_servico (orgao_id, contrato_id, planilha_id, orcamento_item_id, etapa, numero, ordem, fonte, codigo, descricao, unidade, quantidade, preco_unitario, total, executor)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [a.orgaoId, contratoId, planilha, i.id, `${e.ordem}. ${e.nome}`, i.numero, ordem, i.fonte, i.codigo, i.descricao, i.unidade, i.quantidade, texto(pu), texto(t), executor]);
    }
  }
  await c.query("update contrato set valor_inicial = $2 where id = $1", [contratoId, texto(total)]);
}

export async function criarContrato(a: Ator, d: DadosContrato): Promise<string> {
  exigir(a, "contrato.editar");
  const { prazo, desconto } = validar(d);
  if (!uuid(d.orcamentoId)) throw new ErroDeRegra("Escolha o orçamento aprovado.");
  const o = await obterOrcamento(a, d.orcamentoId);
  if (o.situacao !== "aprovado") throw new ErroDeRegra("O contrato precisa de um orçamento aprovado.");
  return comContexto(ctx(a), async (c) => {
    const forma = (await c.query("select forma_execucao from obra where id = $1", [o.obraId])).rows[0].forma_execucao as string;
    let id: string;
    try {
      id = (await c.query(
        `insert into contrato (orgao_id, obra_id, orcamento_id, empresa_id, numero, processo, objeto, regime, natureza, desconto,
                               data_assinatura, data_ordem_servico, prazo_execucao_dias, vigencia_fim, data_base, indice_reajuste, gestor_id, fiscal_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
        [a.orgaoId, o.obraId, o.id, d.regime === "direta" ? null : d.empresaId, d.numero.trim(), limpo(d.processo), d.objeto.trim(), d.regime, d.natureza,
          texto(desconto, 4), limpo(d.dataAssinatura), limpo(d.dataOrdemServico), prazo, limpo(d.vigenciaFim), limpo(d.dataBase) ?? `${o.mes}-01`,
          limpo(d.indiceReajuste), uuid(d.gestorId) ? d.gestorId : null, uuid(d.fiscalId) ? d.fiscalId : null])).rows[0].id;
    } catch (e) {
      const k = (e as { constraint?: string }).constraint;
      if (k === "contrato_numero_unico") throw new ErroDeRegra("Já existe um contrato com este número.");
      if (k === "contrato_um_por_orcamento") throw new ErroDeRegra("Este orçamento já tem contrato.");
      throw e;
    }
    await gerarPlanilha(c, a, id, o, desconto, d.regime, forma);
    return id;
  });
}

export async function salvarContrato(a: Ator, id: string, d: Omit<DadosContrato, "orcamentoId">) {
  exigir(a, "contrato.editar");
  // O orçamento é lido antes, fora da transação, para não segurar duas conexões ao mesmo tempo.
  const orcamentoId = await comContexto(ctx(a), async (c) => (await cabecalho(c, a, id)).orcamentoId);
  const orc = await obterOrcamento(a, orcamentoId);
  await comContexto(ctx(a), async (c) => {
    const k = await cabecalho(c, a, id);
    if (k.situacao !== "rascunho") throw new ErroDeRegra("Contrato assinado não pode ser alterado. A mudança é feita por aditivo ou apostilamento.");
    const { prazo, desconto } = validar({ ...d, orcamentoId: k.orcamentoId });
    try {
      await c.query(
        `update contrato set empresa_id = $2, numero = $3, processo = $4, objeto = $5, regime = $6, natureza = $7, desconto = $8,
                data_assinatura = $9, data_ordem_servico = $10, prazo_execucao_dias = $11, vigencia_fim = $12, data_base = $13,
                indice_reajuste = $14, gestor_id = $15, fiscal_id = $16 where id = $1`,
        [id, d.regime === "direta" ? null : d.empresaId, d.numero.trim(), limpo(d.processo), d.objeto.trim(), d.regime, d.natureza, texto(desconto, 4),
          limpo(d.dataAssinatura), limpo(d.dataOrdemServico), prazo, limpo(d.vigenciaFim), limpo(d.dataBase) ?? k.dataBase,
          limpo(d.indiceReajuste), uuid(d.gestorId) ? d.gestorId : null, uuid(d.fiscalId) ? d.fiscalId : null]);
    } catch (e) {
      if ((e as { constraint?: string }).constraint === "contrato_numero_unico") throw new ErroDeRegra("Já existe um contrato com este número.");
      throw e;
    }
    const mudouExecutor = (k.regime === "direta") !== (d.regime === "direta");
    if (dec(k.desconto) !== desconto || mudouExecutor) {
      const forma = (await c.query("select forma_execucao from obra where id = $1", [k.obraId])).rows[0].forma_execucao as string;
      await gerarPlanilha(c, a, id, orc, desconto, d.regime, forma);
    }
  });
}

export async function definirExecutor(a: Ator, id: string, itemId: string, executor: Executor) {
  exigir(a, "contrato.editar");
  if (executor !== "contratada" && executor !== "equipe_propria") throw new ErroDeRegra("Executor inválido.");
  await comContexto(ctx(a), async (c) => {
    const k = await cabecalho(c, a, id);
    if (k.regime === "direta" && executor === "contratada") throw new ErroDeRegra("Na execução direta todos os itens são da equipe própria.");
    const r = await c.query("update item_servico set executor = $3 where id = $2 and contrato_id = $1", [id, itemId, executor]);
    if (!r.rowCount) throw new ErroDeRegra("Item não encontrado.");
  });
}

/** O que falta para assinar. Lista vazia quer dizer pronto. */
export function pendenciasDoContrato(k: Contrato, itens: number) {
  const p: string[] = [];
  if (!itens) p.push("Planilha contratual vazia.");
  if (!k.dataAssinatura) p.push("Data de assinatura não informada.");
  if (!k.prazoExecucaoDias) p.push("Prazo de execução não informado.");
  if (!k.vigenciaFim) p.push("Fim da vigência não informado.");
  if (!k.gestorId) p.push("Gestor do contrato não designado.");
  if (!k.fiscalId) p.push("Fiscal não designado.");
  return p;
}

/** Assina o contrato. O cronograma em elaboração, sem pendências, vira a linha de base no mesmo ato. */
export async function assinarContrato(a: Ator, id: string): Promise<"gravada" | "pendente" | "sem_cronograma"> {
  exigir(a, "contrato.assinar");
  return comContexto(ctx(a), async (c) => {
    await c.query("select 1 from contrato where id = $1 for update", [id]);
    const k = await cabecalho(c, a, id);
    if (k.situacao !== "rascunho") throw new ErroDeRegra("Este contrato já foi assinado.");
    const itens = (await c.query("select count(*)::int as n from item_servico where contrato_id = $1", [id])).rows[0].n;
    const p = pendenciasDoContrato(k, itens);
    if (p.length) throw new ErroDeRegra(`Resolva antes de assinar: ${p.join(" ")}`);
    if ((await c.query("select situacao from orcamento where id = $1", [k.orcamentoId])).rows[0].situacao !== "aprovado") {
      throw new ErroDeRegra("O orçamento deste contrato não está mais em vigor.");
    }
    await c.query("update contrato set situacao = 'vigente', assinado_por = $2, assinado_em = now() where id = $1", [id, a.id]);
    // A obra acompanha o contrato: licitada e contratada, com o número do contrato como documento.
    if (k.regime !== "direta") {
      const doc = `Contrato ${k.numero}`;
      if (k.obraSituacao === "orcada") await c.query("select mudar_situacao_obra($1, 'licitada', $2)", [k.obraId, k.processo ? `Processo ${k.processo}` : doc]);
      if (k.obraSituacao === "orcada" || k.obraSituacao === "licitada") await c.query("select mudar_situacao_obra($1, 'contratada', $2)", [k.obraId, doc]);
    }
    const { linhaBaseNaAssinatura } = await import("./cronogramas");
    return linhaBaseNaAssinatura(c, a, id);
  });
}

export async function designar(a: Ator, id: string, gestorId: string | null, fiscalId: string | null) {
  exigir(a, "contrato.editar");
  await comContexto(ctx(a), async (c) => {
    await cabecalho(c, a, id);
    await c.query("update contrato set gestor_id = $2, fiscal_id = $3 where id = $1", [id, uuid(gestorId) ? gestorId : null, uuid(fiscalId) ? fiscalId : null]);
  });
}

export async function adicionarGarantia(a: Ator, id: string, d: { modalidade: Modalidade; valor: string; instituicao?: string | null; documento?: string | null; inicio: string; vencimento: string }) {
  exigir(a, "contrato.editar");
  if (!ROTULO_MODALIDADE[d.modalidade]) throw new ErroDeRegra("Escolha a modalidade.");
  const valor = lerValorBr(d.valor);
  if (valor == null || valor <= ZERO) throw new ErroDeRegra("Informe o valor da garantia.");
  if (!d.inicio || !d.vencimento || !dataValida(d.inicio) || !dataValida(d.vencimento)) throw new ErroDeRegra("Informe início e vencimento.");
  if (d.vencimento < d.inicio) throw new ErroDeRegra("O vencimento não pode ser anterior ao início.");
  await comContexto(ctx(a), async (c) => {
    const k = await cabecalho(c, a, id);
    if (k.situacao === "encerrado" || k.situacao === "rescindido") throw new ErroDeRegra("Contrato encerrado.");
    await c.query(
      "insert into garantia (orgao_id, contrato_id, modalidade, valor, instituicao, documento, inicio, vencimento) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [a.orgaoId, id, d.modalidade, texto(valor), limpo(d.instituicao), limpo(d.documento), d.inicio, d.vencimento]);
  });
}

export type Alerta = { nivel: "alto" | "medio"; texto: string };

export type ContratoCompleto = ResumoContrato & {
  itens: ItemServico[]; etapas: { nome: string; total: string; itens: ItemServico[] }[];
  garantias: Garantia[]; garantiaTotal: string; garantiaPct: string;
  fimExecucao: string | null; pendencias: string[]; alertas: Alerta[];
  valorOrcado: string; descontoValor: string; limiteAditivo: number; limiteAditivoValor: string;
};

export async function obterContrato(a: Ator, id: string): Promise<ContratoCompleto> {
  exigirVer(a);
  const { k, itens, garantias } = await comContexto(ctx(a), async (c) => {
    const k = await cabecalho(c, a, id);
    const itens = (await c.query(
      `select id, etapa, numero, ordem, fonte, codigo, descricao, unidade, quantidade_vigente(id)::text as quantidade, preco_unitario::text as "precoUnitario",
              total_vigente(id)::text as total, executor, orcamento_item_id as "orcamentoItemId", aditivo_id is not null as "incluidoPorAditivo",
              quantidade_vigente(id) <> quantidade as "alteradoPorAditivo"
         from item_servico where contrato_id = $1 and item_vigente(id) order by ordem`, [id])).rows as ItemServico[];
    const garantias = (await c.query(
      `select id, modalidade, valor::text, instituicao, documento, to_char(inicio, 'YYYY-MM-DD') as inicio, to_char(vencimento, 'YYYY-MM-DD') as vencimento
         from garantia where contrato_id = $1 order by vencimento`, [id])).rows as Garantia[];
    return { k, itens, garantias };
  });
  return montarContrato(a, k, itens, garantias);
}

async function montarContrato(a: Ator, k: Contrato, itens: ItemServico[], garantias: Garantia[]): Promise<ContratoCompleto> {
  const r = resumir(k);
  const etapas: ContratoCompleto["etapas"] = [];
  for (const i of itens) {
    let e = etapas.find((x) => x.nome === i.etapa);
    if (!e) { e = { nome: i.etapa, total: "0", itens: [] }; etapas.push(e); }
    e.itens.push(i);
  }
  for (const e of etapas) e.total = texto(e.itens.reduce((s, i) => s + dec(i.total), ZERO));
  const garantiaTotal = garantias.reduce((s, g) => s + dec(g.valor), ZERO);
  const base = dec(r.valorAtual);
  const fimExecucao = fimDaExecucao(k);
  const hj = hoje();
  const alertas: Alerta[] = [];
  const aviso = (dias: number, oque: string) => {
    if (dias < 0) alertas.push({ nivel: "alto", texto: `${oque} venceu há ${-dias} dia${dias === -1 ? "" : "s"}.` });
    else if (dias <= 30) alertas.push({ nivel: "alto", texto: `${oque} vence em ${dias} dia${dias === 1 ? "" : "s"}.` });
    else if (dias <= 90) alertas.push({ nivel: "medio", texto: `${oque} vence em ${dias} dias.` });
  };
  if (k.situacao === "vigente") {
    if (k.vigenciaFim) aviso(diasEntre(hj, k.vigenciaFim), "A vigência");
    if (fimExecucao) aviso(diasEntre(hj, fimExecucao), "O prazo de execução");
    for (const g of garantias) aviso(diasEntre(hj, g.vencimento), `A garantia (${ROTULO_MODALIDADE[g.modalidade].toLowerCase()})`);
    if (k.dataBase && k.regime !== "direta") {
      const aniversario = anoDepois(k.ultimoReajuste ?? k.dataBase);
      const d = diasEntre(hj, aniversario);
      if (d <= 0) alertas.push({ nivel: "medio", texto: `Reajuste disponível desde ${aniversario.split("-").reverse().join("/")}, pelo ${k.indiceReajuste ?? "índice do contrato"}.` });
      else if (d <= 90) alertas.push({ nivel: "medio", texto: `Reajuste disponível em ${d} dias, pelo ${k.indiceReajuste ?? "índice do contrato"}.` });
    }
  }
  let valorOrcado = ZERO;
  if (itens.length) {
    const o = await obterOrcamento(a, k.orcamentoId);
    valorOrcado = dec(o.totais.total);
  }
  return {
    ...r, itens, etapas, garantias, garantiaTotal: texto(garantiaTotal),
    garantiaPct: base > ZERO ? texto((garantiaTotal * 100n * UM) / base, 2) : "0.00",
    fimExecucao, pendencias: k.situacao === "rascunho" ? pendenciasDoContrato(k, itens.length) : [], alertas,
    valorOrcado: texto(valorOrcado), descontoValor: texto(valorOrcado - dec(k.valorInicial)), limiteAditivo: LIMITE_ADITIVO[k.natureza],
    limiteAditivoValor: texto(ajustar((ajustar(mul(dec(k.valorInicial), dec(k.fatorReajuste)), 2, "arredondar") * BigInt(LIMITE_ADITIVO[k.natureza])) / 100n, 2, "arredondar")),
  };
}
