import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { ajustar, dec, div, lerNumeroBr, lerValorBr, mul, paraNumero, texto, UM, ZERO, type Dec } from "../lib/decimal";
import { versaoParaAditivo } from "./cronogramas";
import { anoDepois, contratoNaTransacao, LIMITE_ADITIVO, type Executor, type ResumoContrato } from "./contratos";
import { somarDias } from "./cpm";
import type { Ator } from "./obras";
import { exigir, pode, SemPermissao } from "./permissoes";
import type { Fonte } from "./precos";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string | null | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);
const dataValida = (v: string | null | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const limpo = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const dataBr = (iso: string) => iso.split("-").reverse().join("/");

export type SituacaoAditivo = "rascunho" | "assinado" | "cancelado";
export type TipoRevisao = "reajuste" | "reequilibrio";

export const ROTULO_SITUACAO_ADITIVO: Record<SituacaoAditivo, string> = { rascunho: "Em elaboração", assinado: "Assinado", cancelado: "Cancelado" };
export const ROTULO_REVISAO: Record<TipoRevisao, string> = { reajuste: "Reajuste", reequilibrio: "Reequilíbrio econômico-financeiro" };
export const FUNDAMENTOS = [
  "Lei 14.133/2021, art. 124, I, a (modificação do projeto ou das especificações)",
  "Lei 14.133/2021, art. 124, I, b (acréscimo ou diminuição quantitativa do objeto)",
  "Lei 14.133/2021, art. 124, II, d (reequilíbrio econômico-financeiro)",
  "Lei 14.133/2021, art. 107 (prorrogação de prazo de serviço contínuo)",
  "Lei 14.133/2021, art. 111 (prorrogação do prazo de conclusão do escopo)",
];

export const rotuloAditivo = (a: { numero: number }) => `${a.numero}º termo aditivo`;
export const rotuloRevisao = (r: { numero: number; tipo: TipoRevisao }) => `${r.numero}º apostilamento · ${r.tipo === "reajuste" ? "reajuste" : "reequilíbrio"}`;

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
export type Aditivo = {
  id: string; contratoId: string; numero: number; objeto: string; justificativa: string; fundamento: string | null;
  prazoDias: number; novaVigencia: string | null; situacao: SituacaoAditivo; dataAssinatura: string | null;
  acrescimo: string; supressao: string; assinadoPorNome: string | null; assinadoEm: Date | null; canceladoMotivo: string | null;
  criadoPorNome: string | null; criadoEm: Date; itens: number;
};

const COLUNAS = `d.id, d.contrato_id as "contratoId", d.numero, d.objeto, d.justificativa, d.fundamento, d.prazo_dias as "prazoDias",
  to_char(d.nova_vigencia, 'YYYY-MM-DD') as "novaVigencia", d.situacao, to_char(d.data_assinatura, 'YYYY-MM-DD') as "dataAssinatura",
  coalesce(d.valor_acrescimo, (select sum(valor) from aditivo_item where aditivo_id = d.id and valor > 0), 0)::text as acrescimo,
  coalesce(d.valor_supressao, (select -sum(valor) from aditivo_item where aditivo_id = d.id and valor < 0), 0)::text as supressao,
  ua.nome as "assinadoPorNome", d.assinado_em as "assinadoEm", d.cancelado_motivo as "canceladoMotivo", uc.nome as "criadoPorNome", d.criado_em as "criadoEm",
  (select count(*)::int from aditivo_item where aditivo_id = d.id) as itens`;
const DE = "from aditivo d left join usuario ua on ua.id = d.assinado_por left join usuario uc on uc.id = d.criado_por";

export type RevisaoPreco = {
  id: string; numero: number; tipo: TipoRevisao; indice: string | null; indiceBase: string | null; indiceAtual: string | null;
  percentual: string; inicio: string; justificativa: string | null; documento: string | null; valorSaldo: string; valorImpacto: string;
  criadoPorNome: string | null; criadoEm: Date; fatorAcumulado: string;
};

async function lerRevisoes(c: PoolClient, contratoId: string): Promise<RevisaoPreco[]> {
  return (await c.query(
    `select r.id, r.numero, r.tipo, r.indice, r.indice_base::text as "indiceBase", r.indice_atual::text as "indiceAtual", r.percentual::text,
            to_char(r.inicio, 'YYYY-MM-DD') as inicio, r.justificativa, r.documento, r.valor_saldo::text as "valorSaldo",
            r.valor_impacto::text as "valorImpacto", u.nome as "criadoPorNome", r.criado_em as "criadoEm",
            fator_revisao(r.contrato_id, r.inicio)::text as "fatorAcumulado"
       from revisao_preco r left join usuario u on u.id = r.criado_por where r.contrato_id = $1 order by r.numero`, [contratoId])).rows;
}

export type Alteracoes = {
  contrato: ResumoContrato; aditivos: Aditivo[]; revisoes: RevisaoPreco[];
  base: string; limiteAcrescimoPct: number; limiteAcrescimo: string; limiteSupressao: string;
  acrescimoPct: number; supressaoPct: number; saldoAcrescimo: string; saldoSupressao: string;
  proximoReajuste: string | null; fatorAtual: string; reajustePct: number;
  podeElaborar: boolean; podeRegistrarRevisao: boolean;
};

/** Base dos limites: valor inicial atualizado pelos reajustes em vigor. */
function limites(k: ResumoContrato) {
  const base = ajustar(mul(dec(k.valorInicial), dec(k.fatorReajuste)), 2, "arredondar");
  const limiteAcrescimoPct = LIMITE_ADITIVO[k.natureza];
  const limiteAcrescimo = ajustar((base * BigInt(limiteAcrescimoPct)) / 100n, 2, "arredondar");
  const limiteSupressao = ajustar((base * 25n) / 100n, 2, "arredondar");
  const pct = (v: Dec) => (base > ZERO ? paraNumero(div(v * 100n, base)) : 0);
  return { base, limiteAcrescimoPct, limiteAcrescimo, limiteSupressao, pct };
}

/** Aditivos e revisões de preço do contrato, com os limites legais. */
export async function alteracoesDoContrato(a: Ator, contratoId: string): Promise<Alteracoes> {
  return comContexto(ctx(a), async (c) => {
    const k = await contratoNaTransacao(c, a, contratoId);
    const aditivos = (await c.query(`select ${COLUNAS} ${DE} where d.contrato_id = $1 order by d.numero`, [contratoId])).rows as Aditivo[];
    const revisoes = await lerRevisoes(c, contratoId);
    const l = limites(k);
    const acr = dec(k.acrescimos), sup = dec(k.supressoes);
    const ultimoReajuste = revisoes.filter((r) => r.tipo === "reajuste").at(-1)?.inicio ?? null;
    const ref = ultimoReajuste ?? k.dataBase ?? k.dataAssinatura;
    const proximoReajuste = ref ? anoDepois(ref) : null;
    return {
      contrato: k, aditivos, revisoes, base: texto(l.base), limiteAcrescimoPct: l.limiteAcrescimoPct,
      limiteAcrescimo: texto(l.limiteAcrescimo), limiteSupressao: texto(l.limiteSupressao),
      acrescimoPct: l.pct(acr), supressaoPct: l.pct(sup),
      saldoAcrescimo: texto(l.limiteAcrescimo - acr), saldoSupressao: texto(l.limiteSupressao - sup),
      proximoReajuste, fatorAtual: k.fatorRevisao, reajustePct: paraNumero((dec(k.fatorRevisao) - UM) * 100n),
      podeElaborar: k.situacao === "vigente" && pode(a, "aditivo.elaborar"),
      podeRegistrarRevisao: k.situacao === "vigente" && k.regime !== "direta" && pode(a, "revisao.registrar"),
    };
  });
}

export type LinhaAditivo = {
  itemServicoId: string; etapa: string; numero: string; codigo: string | null; descricao: string; unidade: string; executor: Executor; fonte: Fonte;
  precoUnitario: string; novo: boolean; anterior: string; medido: string; variacao: string; nova: string; valorAnterior: string; valorVariacao: string; valorNovo: string;
};

export type AditivoCompleto = Aditivo & {
  contrato: ResumoContrato; linhas: LinhaAditivo[]; etapas: { nome: string; valorVariacao: string; linhas: LinhaAditivo[] }[];
  liquido: string; valorAnterior: string; valorNovo: string;
  base: string; limiteAcrescimoPct: number; limiteAcrescimo: string; limiteSupressao: string;
  acrescimoAnterior: string; supressaoAnterior: string; acrescimoAcumulado: string; supressaoAcumulado: string;
  acrescimoPct: number; supressaoPct: number; acrescimoAcumuladoPct: number; supressaoAcumuladoPct: number;
  prazoAnterior: number | null; prazoNovo: number | null; fimExecucaoAnterior: string | null; fimExecucaoNovo: string | null;
  vigenciaAnterior: string | null; vigenciaNova: string | null;
  pendencias: string[]; podeEditar: boolean; podeAssinar: boolean; etapasExistentes: string[]; hoje: string;
};

async function cabecalho(c: PoolClient, a: Ator, id: string, travar = false): Promise<{ d: Aditivo; k: ResumoContrato }> {
  if (!uuid(id)) throw new ErroDeRegra("Aditivo não encontrado.");
  if (travar) await c.query("select 1 from aditivo where id = $1 for update", [id]);
  const d = (await c.query(`select ${COLUNAS} ${DE} where d.id = $1`, [id])).rows[0] as Aditivo | undefined;
  if (!d) throw new ErroDeRegra("Aditivo não encontrado.");
  const k = await contratoNaTransacao(c, a, d.contratoId);
  return { d, k };
}

export async function obterAditivo(a: Ator, id: string): Promise<AditivoCompleto> {
  return comContexto(ctx(a), async (c) => {
    const { d, k } = await cabecalho(c, a, id);
    // Quantidade anterior: inicial mais os aditivos assinados antes deste.
    const rows = (await c.query(
      `select i.id as "itemServicoId", i.etapa, i.numero, i.codigo, i.descricao, i.unidade, i.executor, i.fonte, i.preco_unitario::text as "precoUnitario",
              i.aditivo_id = $2 as novo,
              (i.quantidade + coalesce((select sum(ai.quantidade) from aditivo_item ai join aditivo x on x.id = ai.aditivo_id
                                         where ai.item_servico_id = i.id and x.situacao = 'assinado' and x.numero < $3), 0))::text as anterior,
              coalesce((select sum(m.quantidade) from item_medido m join medicao y on y.id = m.medicao_id
                         where m.item_servico_id = i.id and y.situacao <> 'cancelada'), 0)::text as medido,
              coalesce(n.quantidade, 0)::text as variacao, coalesce(n.valor, 0)::text as "valorVariacao", i.total::text as "totalInicial", i.quantidade::text as inicial
         from item_servico i left join aditivo_item n on n.item_servico_id = i.id and n.aditivo_id = $2
        where i.contrato_id = $1
          and (i.aditivo_id is null or i.aditivo_id = $2
               or exists (select 1 from aditivo x where x.id = i.aditivo_id and x.situacao = 'assinado' and x.numero < $3))
        order by i.ordem`, [d.contratoId, id, d.numero])).rows;
    const linhas: LinhaAditivo[] = rows.map((l) => {
      const anterior = dec(l.anterior), variacao = dec(l.variacao), pu = dec(l.precoUnitario);
      const valorAnterior = anterior === dec(l.inicial) ? dec(l.totalInicial) : ajustar(mul(anterior, pu), 2, k.arredondamento);
      const valorVariacao = dec(l.valorVariacao);
      return {
        itemServicoId: l.itemServicoId, etapa: l.etapa, numero: l.numero, codigo: l.codigo, descricao: l.descricao, unidade: l.unidade,
        executor: l.executor, fonte: l.fonte, precoUnitario: l.precoUnitario, novo: l.novo,
        anterior: texto(anterior, 4), medido: texto(dec(l.medido), 4), variacao: texto(variacao, 4), nova: texto(anterior + variacao, 4),
        valorAnterior: texto(valorAnterior), valorVariacao: texto(valorVariacao), valorNovo: texto(valorAnterior + valorVariacao),
      };
    });
    const etapas: AditivoCompleto["etapas"] = [];
    for (const l of linhas) {
      let e = etapas.find((x) => x.nome === l.etapa);
      if (!e) { e = { nome: l.etapa, valorVariacao: "0", linhas: [] }; etapas.push(e); }
      e.linhas.push(l);
    }
    for (const e of etapas) e.valorVariacao = texto(e.linhas.reduce((s, l) => s + dec(l.valorVariacao), ZERO));

    const anteriores = (await c.query(
      `select coalesce(sum(valor_acrescimo), 0)::text as acr, coalesce(sum(valor_supressao), 0)::text as sup,
              coalesce(sum(prazo_dias), 0)::int as prazo, to_char(max(nova_vigencia), 'YYYY-MM-DD') as vig
         from aditivo where contrato_id = $1 and situacao = 'assinado' and numero < $2`, [d.contratoId, d.numero])).rows[0];
    const acr = dec(d.acrescimo), sup = dec(d.supressao);
    const acrAnt = dec(anteriores.acr), supAnt = dec(anteriores.sup);
    const l = limites(k);
    const valorAnterior = dec(k.valorInicial) + acrAnt - supAnt;
    const prazoAnterior = k.prazoInicialDias == null ? null : k.prazoInicialDias + anteriores.prazo;
    const prazoNovo = prazoAnterior == null ? null : prazoAnterior + d.prazoDias;
    const fim = (p: number | null) => (k.dataOrdemServico && p ? somarDias(k.dataOrdemServico, p - 1) : null);
    const vigenciaAnterior = [k.vigenciaInicial, anteriores.vig].filter(Boolean).sort().at(-1) ?? null;
    const vigenciaNova = d.novaVigencia ?? vigenciaAnterior;
    const hj = hoje();

    const pendencias: string[] = [];
    if (d.situacao === "rascunho") {
      if (acr === ZERO && sup === ZERO && d.prazoDias === 0 && !d.novaVigencia) pendencias.push("O aditivo não altera valor, prazo nem vigência.");
      const novosSem = linhas.filter((x) => x.novo && dec(x.variacao) === ZERO);
      if (novosSem.length) pendencias.push(`Item novo sem quantidade: ${novosSem.map((x) => x.numero).join(", ")}.`);
      const abaixo = linhas.filter((x) => dec(x.nova) < dec(x.medido));
      if (abaixo.length) pendencias.push(`Supressão abaixo do já medido nos itens ${abaixo.map((x) => x.numero).join(", ")}.`);
      if (acrAnt + acr > l.limiteAcrescimo) pendencias.push(`Os acréscimos passam do limite de ${l.limiteAcrescimoPct}% do valor inicial atualizado.`);
      if (supAnt + sup > l.limiteSupressao) pendencias.push("As supressões passam do limite de 25% do valor inicial atualizado.");
      const fimNovo = fim(prazoNovo);
      if (fimNovo && vigenciaNova && fimNovo > vigenciaNova) pendencias.push(`O prazo de execução vai até ${dataBr(fimNovo)}, depois do fim da vigência (${dataBr(vigenciaNova)}).`);
      if (d.novaVigencia && vigenciaAnterior && d.novaVigencia <= vigenciaAnterior) pendencias.push("A nova vigência deve ser posterior à atual.");
      if (k.vigenciaFim && hj > k.vigenciaFim) pendencias.push("A vigência do contrato já terminou.");
    }
    const etapasExistentes = [...new Set(linhas.map((x) => x.etapa))];
    return {
      ...d, contrato: k, linhas, etapas, liquido: texto(acr - sup), valorAnterior: texto(valorAnterior), valorNovo: texto(valorAnterior + acr - sup),
      base: texto(l.base), limiteAcrescimoPct: l.limiteAcrescimoPct, limiteAcrescimo: texto(l.limiteAcrescimo), limiteSupressao: texto(l.limiteSupressao),
      acrescimoAnterior: texto(acrAnt), supressaoAnterior: texto(supAnt), acrescimoAcumulado: texto(acrAnt + acr), supressaoAcumulado: texto(supAnt + sup),
      acrescimoPct: l.pct(acr), supressaoPct: l.pct(sup), acrescimoAcumuladoPct: l.pct(acrAnt + acr), supressaoAcumuladoPct: l.pct(supAnt + sup),
      prazoAnterior, prazoNovo, fimExecucaoAnterior: fim(prazoAnterior), fimExecucaoNovo: fim(prazoNovo), vigenciaAnterior, vigenciaNova,
      pendencias, podeEditar: d.situacao === "rascunho" && k.situacao === "vigente" && pode(a, "aditivo.elaborar"),
      podeAssinar: d.situacao === "rascunho" && k.situacao === "vigente" && pode(a, "aditivo.assinar"),
      etapasExistentes, hoje: hj,
    };
  });
}

// ---------------------------------------------------------------------------
// Elaboração
// ---------------------------------------------------------------------------
export type DadosAditivo = { objeto: string; justificativa: string; fundamento?: string | null; prazoDias?: string | number | null; novaVigencia?: string | null };

function validar(d: DadosAditivo) {
  if (!d.objeto.trim()) throw new ErroDeRegra("Informe o objeto do aditivo.");
  if (!d.justificativa.trim()) throw new ErroDeRegra("Informe a justificativa técnica.");
  const prazo = d.prazoDias == null || d.prazoDias === "" ? 0 : Number(d.prazoDias);
  if (!Number.isInteger(prazo) || prazo < 0 || prazo > 3650) throw new ErroDeRegra("Acréscimo de prazo inválido.");
  const vig = limpo(d.novaVigencia);
  if (vig && !dataValida(vig)) throw new ErroDeRegra("Data da nova vigência inválida.");
  return { prazo, vig };
}

export async function criarAditivo(a: Ator, contratoId: string, d: DadosAditivo): Promise<string> {
  exigir(a, "aditivo.elaborar");
  const v = validar(d);
  return comContexto(ctx(a), async (c) => {
    const k = await contratoNaTransacao(c, a, contratoId, true);
    if (k.situacao !== "vigente") throw new ErroDeRegra("Só contrato vigente recebe aditivo.");
    if (k.aditivosAbertos) throw new ErroDeRegra("Já existe um aditivo em elaboração neste contrato. Assine ou cancele antes de abrir outro.");
    const numero = (await c.query("select coalesce(max(numero), 0) + 1 as n from aditivo where contrato_id = $1", [contratoId])).rows[0].n as number;
    return (await c.query(
      `insert into aditivo (orgao_id, contrato_id, numero, objeto, justificativa, fundamento, prazo_dias, nova_vigencia)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [a.orgaoId, contratoId, numero, d.objeto.trim(), d.justificativa.trim(), limpo(d.fundamento), v.prazo, v.vig])).rows[0].id as string;
  });
}

async function emElaboracao(c: PoolClient, a: Ator, id: string) {
  exigir(a, "aditivo.elaborar");
  const r = await cabecalho(c, a, id, true);
  if (r.d.situacao !== "rascunho") throw new ErroDeRegra("Aditivo assinado ou cancelado não pode ser alterado.");
  if (r.k.situacao !== "vigente") throw new ErroDeRegra("Só contrato vigente recebe aditivo.");
  return r;
}

export type LinhaVariacao = { itemServicoId: string; variacao: string };

/** Grava os dados e a planilha do aditivo: variação vazia ou zero tira o item do aditivo. */
export async function salvarAditivo(a: Ator, id: string, d: DadosAditivo & { linhas: LinhaVariacao[] }) {
  const v = validar(d);
  await comContexto(ctx(a), async (c) => {
    const { k } = await emElaboracao(c, a, id);
    await c.query("update aditivo set objeto = $2, justificativa = $3, fundamento = $4, prazo_dias = $5, nova_vigencia = $6 where id = $1",
      [id, d.objeto.trim(), d.justificativa.trim(), limpo(d.fundamento), v.prazo, v.vig]);
    const itens = new Map((await c.query(
      "select id, numero, preco_unitario::text as pu, aditivo_id from item_servico where contrato_id = $1", [k.id])).rows.map((i) => [i.id as string, i]));
    for (const l of d.linhas) {
      const i = itens.get(l.itemServicoId);
      if (!i) throw new ErroDeRegra("Item não pertence a este contrato.");
      const q = l.variacao.trim() === "" ? ZERO : lerNumeroBr(l.variacao);
      if (q == null) throw new ErroDeRegra(`Item ${i.numero}: variação inválida.`);
      if (q === ZERO) {
        await c.query("delete from aditivo_item where aditivo_id = $1 and item_servico_id = $2", [id, i.id]);
        continue;
      }
      const pu = dec(i.pu);
      const valor = ajustar(mul(q, pu), 2, k.arredondamento);
      await c.query(
        `insert into aditivo_item (orgao_id, aditivo_id, item_servico_id, quantidade, preco_unitario, valor) values ($1,$2,$3,$4,$5,$6)
         on conflict (aditivo_id, item_servico_id) do update set quantidade = excluded.quantidade, valor = excluded.valor`,
        [a.orgaoId, id, i.id, texto(q, 4), i.pu, texto(valor)]);
    }
  });
}

export type DadosItemNovo = {
  etapa: string; descricao: string; unidade: string; quantidade: string; precoUnitario: string;
  codigo?: string | null; fonte?: Fonte | null; executor?: Executor | null;
};

const FONTES: Fonte[] = ["sinapi", "sicro", "propria", "cotacao", "demonstracao"];

/** Inclui serviço novo na planilha pelo aditivo, com preço e quantidade. */
export async function incluirItem(a: Ator, id: string, d: DadosItemNovo): Promise<string> {
  if (!d.etapa.trim()) throw new ErroDeRegra("Informe a etapa.");
  if (!d.descricao.trim()) throw new ErroDeRegra("Informe a descrição do serviço.");
  if (!d.unidade.trim()) throw new ErroDeRegra("Informe a unidade.");
  const q = lerNumeroBr(d.quantidade);
  const pu = lerValorBr(d.precoUnitario);
  if (q == null || q <= ZERO) throw new ErroDeRegra("Informe a quantidade.");
  if (pu == null || pu <= ZERO) throw new ErroDeRegra("Informe o preço unitário.");
  const fonte = d.fonte && FONTES.includes(d.fonte) ? d.fonte : "cotacao";
  return comContexto(ctx(a), async (c) => {
    const { d: ad, k } = await emElaboracao(c, a, id);
    const executor: Executor = k.regime === "direta" ? "equipe_propria" : d.executor === "equipe_propria" ? "equipe_propria" : "contratada";
    let planilha = (await c.query("select planilha_id from aditivo where id = $1", [id])).rows[0].planilha_id as string | null;
    if (!planilha) {
      const versao = (await c.query("select coalesce(max(versao), 0) + 1 as v from planilha_contratual where contrato_id = $1", [k.id])).rows[0].v as number;
      planilha = (await c.query("insert into planilha_contratual (orgao_id, contrato_id, versao, origem) values ($1,$2,$3,'aditivo') returning id",
        [a.orgaoId, k.id, versao])).rows[0].id as string;
      await c.query("update aditivo set planilha_id = $2 where id = $1", [id, planilha]);
    }
    const n = (await c.query("select count(*)::int as n from item_servico where aditivo_id = $1", [id])).rows[0].n as number;
    const numero = `A${String(ad.numero).padStart(2, "0")}.${n + 1}`;
    const ordem = (await c.query("select coalesce(max(ordem), 0) + 1 as o from item_servico where contrato_id = $1", [k.id])).rows[0].o as number;
    const puTxt = texto(ajustar(pu, 2, k.arredondamento));
    const itemId = (await c.query(
      `insert into item_servico (orgao_id, contrato_id, planilha_id, aditivo_id, etapa, numero, ordem, fonte, codigo, descricao, unidade, quantidade, preco_unitario, total, executor)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,0,$13) returning id`,
      [a.orgaoId, k.id, planilha, id, d.etapa.trim(), numero, ordem, fonte, limpo(d.codigo), d.descricao.trim(), d.unidade.trim(), puTxt, executor])).rows[0].id as string;
    const valor = ajustar(mul(q, dec(puTxt)), 2, k.arredondamento);
    await c.query("insert into aditivo_item (orgao_id, aditivo_id, item_servico_id, quantidade, preco_unitario, valor) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, id, itemId, texto(q, 4), puTxt, texto(valor)]);
    return itemId;
  });
}

export async function removerItem(a: Ator, id: string, itemId: string) {
  await comContexto(ctx(a), async (c) => {
    await emElaboracao(c, a, id);
    const i = (await c.query("select id from item_servico where id = $1 and aditivo_id = $2", [itemId, id])).rows[0];
    if (!i) throw new ErroDeRegra("Item novo não encontrado neste aditivo.");
    await c.query("delete from aditivo_item where item_servico_id = $1", [itemId]);
    await c.query("delete from item_servico where id = $1", [itemId]);
  });
}

export async function assinarAditivo(a: Ator, id: string, dataAssinatura: string) {
  exigir(a, "aditivo.assinar");
  if (!dataValida(dataAssinatura)) throw new ErroDeRegra("Informe a data de assinatura.");
  if (dataAssinatura > hoje()) throw new ErroDeRegra("A data de assinatura não pode ser futura.");
  await comContexto(ctx(a), async (c) => {
    const { d } = await cabecalho(c, a, id, true);
    if (d.situacao !== "rascunho") throw new ErroDeRegra("Este aditivo já foi assinado ou cancelado.");
    await c.query("select 1 from contrato where id = $1 for update", [d.contratoId]);
    await c.query("update aditivo set situacao = 'assinado', data_assinatura = $2, assinado_por = $3, assinado_em = now() where id = $1", [id, dataAssinatura, a.id]);
    // Nova versão do cronograma, em elaboração, para gravar a nova linha de base com o aditivo.
    await versaoParaAditivo(c, d.contratoId, rotuloAditivo(d).replace(/^./, (x) => x.toUpperCase()));
  });
}

export async function cancelarAditivo(a: Ator, id: string, motivo: string) {
  if (!pode(a, "aditivo.elaborar") && !pode(a, "aditivo.assinar")) throw new SemPermissao();
  if (!motivo.trim()) throw new ErroDeRegra("Informe o motivo do cancelamento.");
  await comContexto(ctx(a), async (c) => {
    const { d } = await cabecalho(c, a, id, true);
    if (d.situacao !== "rascunho") throw new ErroDeRegra("Só aditivo em elaboração pode ser cancelado.");
    await c.query("update aditivo set situacao = 'cancelado', cancelado_motivo = $2 where id = $1", [id, motivo.trim()]);
  });
}

// ---------------------------------------------------------------------------
// Revisão de preço (apostilamento)
// ---------------------------------------------------------------------------
export type DadosRevisao = {
  tipo: TipoRevisao; inicio: string; indice?: string | null; indiceBase?: string | null; indiceAtual?: string | null;
  percentual?: string | null; justificativa?: string | null; documento?: string | null;
};

/** Percentual do reajuste pelos índices, em quatro casas: (atual ÷ base − 1) × 100. */
export function percentualDoIndice(base: Dec, atual: Dec) {
  return ajustar((div(atual, base) - UM) * 100n, 4, "arredondar");
}

export async function registrarRevisao(a: Ator, contratoId: string, d: DadosRevisao): Promise<string> {
  exigir(a, "revisao.registrar");
  if (d.tipo !== "reajuste" && d.tipo !== "reequilibrio") throw new ErroDeRegra("Escolha o tipo de revisão.");
  if (!dataValida(d.inicio)) throw new ErroDeRegra("Informe a data de início dos novos preços.");
  let pct: Dec;
  let base: Dec | null = null, atual: Dec | null = null;
  if (d.tipo === "reajuste") {
    if (!limpo(d.indice)) throw new ErroDeRegra("Informe o índice de reajuste.");
    base = lerNumeroBr(d.indiceBase ?? "");
    atual = lerNumeroBr(d.indiceAtual ?? "");
    if (base == null || base <= ZERO) throw new ErroDeRegra("Informe o número-índice da data-base.");
    if (atual == null || atual <= ZERO) throw new ErroDeRegra("Informe o número-índice atual.");
    pct = percentualDoIndice(base, atual);
    if (pct === ZERO) throw new ErroDeRegra("Os índices não variaram.");
  } else {
    const p = lerNumeroBr(d.percentual ?? "");
    if (p == null || p === ZERO) throw new ErroDeRegra("Informe o percentual de reequilíbrio.");
    pct = ajustar(p, 4, "arredondar");
    if (!limpo(d.justificativa)) throw new ErroDeRegra("Informe a justificativa do reequilíbrio.");
    if (!limpo(d.documento)) throw new ErroDeRegra("Informe o processo ou parecer que fundamenta o reequilíbrio.");
  }
  if (pct <= -100n * UM) throw new ErroDeRegra("Percentual inválido.");
  return comContexto(ctx(a), async (c) => {
    const k = await contratoNaTransacao(c, a, contratoId, true);
    if (k.situacao !== "vigente") throw new ErroDeRegra("Só contrato vigente recebe revisão de preço.");
    if (k.regime === "direta") throw new ErroDeRegra("Execução direta não tem reajuste de preço.");
    if (k.dataAssinatura && d.inicio < k.dataAssinatura) throw new ErroDeRegra("O início da revisão é anterior à assinatura do contrato.");
    if (d.tipo === "reajuste") {
      const ult = (await c.query("select to_char(max(inicio), 'YYYY-MM-DD') as d from revisao_preco where contrato_id = $1 and tipo = 'reajuste'", [contratoId])).rows[0].d as string | null;
      const ref = ult ?? k.dataBase ?? k.dataAssinatura;
      if (ref && d.inicio < anoDepois(ref)) {
        throw new ErroDeRegra(`O reajuste só vale após 12 meses da ${ult ? "data do último reajuste" : "data-base do orçamento"} (a partir de ${dataBr(anoDepois(ref))}).`);
      }
    }
    const fatorAntes = dec((await c.query("select fator_revisao($1, $2)::text as f", [contratoId, d.inicio])).rows[0].f);
    const saldo = dec(k.saldo) > ZERO ? dec(k.saldo) : ZERO;
    const impacto = ajustar(mul(mul(saldo, fatorAntes), pct / 100n), 2, "arredondar");
    const numero = (await c.query("select coalesce(max(numero), 0) + 1 as n from revisao_preco where contrato_id = $1", [contratoId])).rows[0].n as number;
    return (await c.query(
      `insert into revisao_preco (orgao_id, contrato_id, numero, tipo, indice, indice_base, indice_atual, percentual, inicio, justificativa, documento, valor_saldo, valor_impacto)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [a.orgaoId, contratoId, numero, d.tipo, d.tipo === "reajuste" ? limpo(d.indice) : null, base == null ? null : texto(base, 6), atual == null ? null : texto(atual, 6),
        texto(pct, 4), d.inicio, limpo(d.justificativa), limpo(d.documento), texto(saldo), texto(impacto)])).rows[0].id as string;
  });
}

export async function obterRevisao(a: Ator, id: string): Promise<RevisaoPreco & { contrato: ResumoContrato }> {
  if (!uuid(id)) throw new ErroDeRegra("Apostilamento não encontrado.");
  return comContexto(ctx(a), async (c) => {
    const r = (await c.query("select contrato_id from revisao_preco where id = $1", [id])).rows[0];
    if (!r) throw new ErroDeRegra("Apostilamento não encontrado.");
    const contrato = await contratoNaTransacao(c, a, r.contrato_id);
    const rev = (await lerRevisoes(c, r.contrato_id)).find((x) => x.id === id)!;
    return { ...rev, contrato };
  });
}
