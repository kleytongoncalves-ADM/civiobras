import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { ajustar, dec, lerNumeroBr, lerValorBr, mul, soma, texto, ZERO, type Dec, type Regra } from "../lib/decimal";
import {
  bdiPadrao, calcularBdi, calcularCronograma, calcularItem, conferirBdi, cprbDoAno, curvaAbc, custoUnitario,
  precoDasCotacoes, validarBdi, PARCELAS_BDI, TIPOS_OBRA_BDI, type AvisoBdi, type Bdi, type TipoObraBdi,
} from "./calculo";
import { obterObra, type Ator } from "./obras";
import { exigir, pode, SemPermissao } from "./permissoes";
import type { Fonte, Regime, TipoInsumo } from "./precos";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string | null | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);

export type SituacaoOrcamento = "rascunho" | "aprovado" | "substituido" | "cancelado";
export type ModoItem = "servico" | "material" | "cotacao";
export type CriterioCotacao = "media" | "mediana" | "menor";

export const ROTULO_SITUACAO_ORC: Record<SituacaoOrcamento, string> = {
  rascunho: "Em elaboração", aprovado: "Aprovado", substituido: "Substituído", cancelado: "Cancelado",
};
export const ROTULO_MODO: Record<ModoItem, string> = { servico: "Serviço", material: "Material", cotacao: "Cotação" };
export const ROTULO_CRITERIO: Record<CriterioCotacao, string> = { media: "Média", mediana: "Mediana", menor: "Menor preço" };

export type Cabecalho = {
  id: string; obraId: string; obraNome: string; obraCodigo: string; obraSituacao: string;
  numero: number; versao: number; versaoAnteriorId: string | null; nome: string;
  tabelaId: string; fonte: Fonte; uf: string; mes: string; regime: Regime; arredondamento: Regra;
  situacao: SituacaoOrcamento; tipoObraBdi: TipoObraBdi; bdiObra: Bdi; bdiFornecimento: Bdi;
  encargosHorista: string | null; encargosMensalista: string | null;
  responsavelTecnico: string | null; registroProfissional: string | null; art: string | null;
  periodos: number; unidadePeriodo: "semana" | "mes"; inicio: string | null;
  aprovadoPor: string | null; aprovadoEm: Date | null; criadoEm: Date;
  nota: { ano: number; numero: number; emitidaEm: Date } | null;
};

export type Cotacao = { id: string; fornecedor: string; cnpj: string | null; data: string; valor: string; validade: string | null };
export type InsumoDoItem = {
  id: string; codigo: string; descricao: string; unidade: string; tipo: TipoInsumo; coeficiente: string; preco: string | null;
  fonte: Fonte | null; ordem: number | null;
  auxiliarCodigo: string | null; auxiliarDescricao: string | null; auxiliarUnidade: string | null; auxiliarCoeficiente: string | null;
};
/** Base de preços usada no orçamento: a principal e as dos itens lançados de outra fonte. */
export type BaseDoOrcamento = { tabelaId: string; fonte: Fonte; mes: string; regime: Regime; principal: boolean; itens: number };

export type Item = {
  id: string; etapaId: string; ordem: number; numero: string; modo: ModoItem; fonte: Fonte; codigo: string | null;
  descricao: string; unidade: string; quantidade: string; custoUnitario: string | null;
  material: string; maoDeObra: string; equipamento: string; tipoBdi: "obra" | "fornecimento";
  memoria: string | null; criterioCotacao: CriterioCotacao | null; justificativa: string | null;
  composicaoId: string | null; insumoId: string | null;
  /** Base do item (fonte, mês e regime), que pode ser outra além da principal. */
  tabelaId: string | null; baseMes: string | null; baseRegime: Regime | null;
  assuntoId: string | null; classificacao: string | null;
  cotacoes: Cotacao[];
  custoTotal: string; precoUnitario: string; total: string; semPreco: boolean;
  materialTotal: string; maoDeObraTotal: string; equipamentoTotal: string;
};

export type Totais = { custo: string; material: string; maoDeObra: string; equipamento: string; bdi: string; total: string };
export type Etapa = { id: string; ordem: number; nome: string; itens: Item[]; totais: Totais; percentuais: Record<number, string> };

export type OrcamentoCompleto = Cabecalho & {
  etapas: Etapa[];
  bases: BaseDoOrcamento[];
  modoMontagem: "assunto" | "livre" | null;
  totais: Totais;
  bdiObraPct: string; bdiFornecimentoPct: string;
  avisosBdi: AvisoBdi[];
  pendencias: string[];
  semPreco: number;
};

const COLUNAS = `o.id, o.obra_id as "obraId", b.nome as "obraNome", b.codigo as "obraCodigo", b.situacao as "obraSituacao",
  o.numero, o.versao, o.versao_anterior_id as "versaoAnteriorId", o.nome, o.tabela_id as "tabelaId", o.fonte, o.uf,
  to_char(o.mes, 'YYYY-MM') as mes, o.regime, o.arredondamento, o.situacao, o.tipo_obra_bdi as "tipoObraBdi",
  o.bdi_obra as "bdiObra", o.bdi_fornecimento as "bdiFornecimento",
  o.encargos_horista::text as "encargosHorista", o.encargos_mensalista::text as "encargosMensalista",
  o.responsavel_tecnico as "responsavelTecnico", o.registro_profissional as "registroProfissional", o.art,
  o.periodos, o.unidade_periodo as "unidadePeriodo", to_char(o.inicio, 'YYYY-MM-DD') as inicio,
  ua.nome as "aprovadoPor", o.aprovado_em as "aprovadoEm", o.criado_em as "criadoEm",
  case when n.id is null then null else json_build_object('ano', n.ano, 'numero', n.numero, 'emitidaEm', n.emitida_em) end as nota`;

const DE = `from orcamento o join obra b on b.id = o.obra_id
  left join usuario ua on ua.id = o.aprovado_por left join nota_orcamento n on n.orcamento_id = o.id`;

/** Mesmo critério de acesso das obras: direção vê todas, os demais só as obras a que estão vinculados. */
function visivel(a: Ator, n: number) {
  if (pode(a, "obra.ver_todas")) return { sql: "true", params: [] as unknown[] };
  return {
    sql: `exists (select 1 from vinculo_obra v where v.obra_id = o.obra_id and v.usuario_id = $${n} and (v.fim is null or v.fim >= hoje_local()))`,
    params: [a.id],
  };
}

function exigirVer(a: Ator) {
  if (!pode(a, "orcamento.ver")) throw new SemPermissao();
}

export const rotuloOrcamento = (o: { numero: number; versao: number }) => `${String(o.numero).padStart(3, "0")} v${o.versao}`;

export async function listarOrcamentos(a: Ator, f: { obraId?: string; situacao?: string } = {}) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const v = visivel(a, 1);
    const params = [...v.params];
    const cond = [v.sql];
    if (f.obraId) { params.push(f.obraId); cond.push(`o.obra_id = $${params.length}`); }
    if (f.situacao) { params.push(f.situacao); cond.push(`o.situacao = $${params.length}`); }
    const r = await c.query(`select ${COLUNAS} ${DE} where ${cond.join(" and ")} order by b.codigo, o.numero desc, o.versao desc`, params);
    const lista = r.rows as Cabecalho[];
    const totais = await totaisRapidos(c, lista);
    return lista.map((o) => ({ ...o, total: totais.get(o.id) ?? "0.00" }));
  });
}

/** Total de cada orçamento com a mesma regra de cálculo da tela, sem montar tudo. */
async function totaisRapidos(c: PoolClient, lista: Cabecalho[]) {
  const ids = lista.map((o) => o.id);
  const r = ids.length
    ? await c.query(
        `select orcamento_id as id, quantidade::text, custo_unitario::text, tipo_bdi from orcamento_item where orcamento_id = any($1::uuid[])`, [ids])
    : { rows: [] };
  const mapa = new Map<string, Dec>();
  const porId = new Map(lista.map((o) => [o.id, o]));
  for (const l of r.rows) {
    const o = porId.get(l.id)!;
    const bdi = { obra: calcularBdi(o.bdiObra), fornecimento: calcularBdi(o.bdiFornecimento) };
    const i = calcularItem({ quantidade: dec(l.quantidade), custoUnitario: l.custo_unitario == null ? null : dec(l.custo_unitario), material: ZERO, maoDeObra: ZERO, equipamento: ZERO, tipoBdi: l.tipo_bdi }, bdi, o.arredondamento);
    mapa.set(l.id, (mapa.get(l.id) ?? ZERO) + i.total);
  }
  return new Map([...mapa.entries()].map(([k, v]) => [k, texto(v)]));
}

async function cabecalho(c: PoolClient, a: Ator, id: string): Promise<Cabecalho> {
  if (!uuid(id)) throw new ErroDeRegra("Orçamento não encontrado.");
  const v = visivel(a, 2);
  const r = await c.query(`select ${COLUNAS} ${DE} where o.id = $1 and ${v.sql}`, [id, ...v.params]);
  if (!r.rows[0]) throw new ErroDeRegra("Orçamento não encontrado ou fora do seu acesso.");
  return r.rows[0];
}

async function emRascunho(c: PoolClient, a: Ator, id: string) {
  exigir(a, "orcamento.editar");
  const o = await cabecalho(c, a, id);
  if (o.situacao !== "rascunho") throw new ErroDeRegra("Orçamento aprovado não pode ser alterado. Crie uma nova versão.");
  return o;
}

// ---------------------------------------------------------------------------
// Criação e dados gerais
// ---------------------------------------------------------------------------
export type NovoOrcamento = { obraId: string; nome: string; tabelaId: string; arredondamento?: Regra | null; tipoObraBdi?: TipoObraBdi };

export async function criarOrcamento(a: Ator, d: NovoOrcamento): Promise<string> {
  exigir(a, "orcamento.editar");
  const obra = await obterObra(a, d.obraId);
  if (!d.nome.trim()) throw new ErroDeRegra("Informe o nome do orçamento.");
  if (!uuid(d.tabelaId)) throw new ErroDeRegra("Escolha a base de preços.");
  const tipoBdi: TipoObraBdi = d.tipoObraBdi && TIPOS_OBRA_BDI.includes(d.tipoObraBdi) ? d.tipoObraBdi
    : obra.tipo === "pavimentacao" ? "rodovias" : obra.tipo === "saneamento" ? "saneamento" : "edificacoes";
  return comContexto(ctx(a), async (c) => {
    const t = (await c.query("select fonte, uf, mes, regime, situacao, extract(year from mes)::int as ano from tabela_preco where id = $1", [d.tabelaId])).rows[0];
    if (!t) throw new ErroDeRegra("Base de preços não encontrada.");
    if (t.situacao !== "liberada") throw new ErroDeRegra("Esta base de preços ainda está em conferência.");
    const regra = d.arredondamento ?? (await c.query("select arredondamento from orgao where id = $1", [a.orgaoId])).rows[0].arredondamento;
    const numero = (await c.query("select coalesce(max(numero), 0) + 1 as n from orcamento where obra_id = $1", [d.obraId])).rows[0].n;
    const des = t.regime === "desonerado";
    const r = await c.query(
      `insert into orcamento (orgao_id, obra_id, numero, nome, tabela_id, fonte, uf, mes, regime, arredondamento, tipo_obra_bdi, bdi_obra, bdi_fornecimento)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [a.orgaoId, d.obraId, numero, d.nome.trim(), d.tabelaId, t.fonte, t.uf, t.mes, t.regime, regra, tipoBdi,
        JSON.stringify(bdiPadrao(tipoBdi, des, t.ano)), JSON.stringify(bdiPadrao("fornecimento", des, t.ano))],
    );
    return r.rows[0].id as string;
  });
}

export type DadosGerais = {
  nome: string; arredondamento: Regra; tipoObraBdi: TipoObraBdi; bdiObra: Bdi; bdiFornecimento: Bdi;
  encargosHorista?: string | null; encargosMensalista?: string | null;
  responsavelTecnico?: string | null; registroProfissional?: string | null; art?: string | null;
};

export async function salvarDadosGerais(a: Ator, id: string, d: DadosGerais) {
  if (!d.nome.trim()) throw new ErroDeRegra("Informe o nome do orçamento.");
  if (!["arredondar", "truncar"].includes(d.arredondamento)) throw new ErroDeRegra("Escolha arredondar ou truncar.");
  if (!TIPOS_OBRA_BDI.includes(d.tipoObraBdi)) throw new ErroDeRegra("Escolha o tipo de obra do BDI.");
  const limpa = (b: Bdi) => Object.fromEntries(PARCELAS_BDI.map((p) => {
    const v = lerNumeroBr(String(b[p] ?? ""));
    return [p, v == null ? "" : texto(v)];
  })) as Bdi;
  const obra = limpa(d.bdiObra), forn = limpa(d.bdiFornecimento);
  const erro = validarBdi(obra) ?? validarBdi(forn);
  if (erro) throw new ErroDeRegra(erro);
  const enc = (v?: string | null) => {
    if (!v?.trim()) return null;
    const x = lerNumeroBr(v);
    if (x == null || x < 0n || x > dec(300)) throw new ErroDeRegra("Encargos sociais entre 0% e 300%.");
    return texto(x);
  };
  const t = (v?: string | null) => v?.trim() || null;
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, id);
    await c.query(
      `update orcamento set nome=$2, arredondamento=$3, tipo_obra_bdi=$4, bdi_obra=$5, bdi_fornecimento=$6,
              encargos_horista=$7, encargos_mensalista=$8, responsavel_tecnico=$9, registro_profissional=$10, art=$11
        where id=$1`,
      [id, d.nome.trim(), d.arredondamento, d.tipoObraBdi, JSON.stringify(obra), JSON.stringify(forn),
        enc(d.encargosHorista), enc(d.encargosMensalista), t(d.responsavelTecnico), t(d.registroProfissional), t(d.art)],
    );
    // O ajuste de casas vale para os custos já congelados nos itens.
    await recalcularTodos(c, id, d.arredondamento);
  });
}

// ---------------------------------------------------------------------------
// Montagem: modo (por assunto ou livre) e bases usadas
// ---------------------------------------------------------------------------
export type BaseDisponivel = { tabelaId: string; fonte: Fonte; mes: string; regime: Regime; principal: boolean; escolhida: boolean };

/**
 * Bases que podem entrar no orçamento: a principal e, de cada outra fonte oficial (SINAPI, SICRO, SCO-Rio),
 * a tabela liberada mais recente da mesma UF, no mesmo regime quando houver.
 */
export async function basesDisponiveis(a: Ator, orcamentoId: string): Promise<BaseDisponivel[]> {
  return comContexto(ctx(a), async (c) => {
    await cabecalho(c, a, orcamentoId);
    const r = await c.query(
      `with o as (select * from orcamento where id = $1),
            candidatas as (
              select distinct on (t.fonte) t.id, t.fonte, t.mes, t.regime
                from tabela_preco t, o
               where t.situacao = 'liberada' and t.uf = o.uf and t.fonte in ('sinapi', 'sicro', 'sco') and t.fonte <> o.fonte
                 and t.orgao_id is not distinct from (select orgao_id from tabela_preco where id = o.tabela_id)
               order by t.fonte, t.mes desc, (t.regime = o.regime) desc)
       select t.id as "tabelaId", t.fonte, to_char(t.mes, 'YYYY-MM') as mes, t.regime, true as principal, true as escolhida
         from o join tabela_preco t on t.id = o.tabela_id
       union all
       select x.id, x.fonte, to_char(x.mes, 'YYYY-MM'), x.regime, false, x.id = any(o.tabelas_extras) from candidatas x, o
       union all
       select t.id, t.fonte, to_char(t.mes, 'YYYY-MM'), t.regime, false, true
         from o join tabela_preco t on t.id = any(o.tabelas_extras) where t.id not in (select id from candidatas)`,
      [orcamentoId]);
    return r.rows;
  });
}

/** Grava o modo de montagem e as bases extras. Uma base com itens lançados não sai. */
export async function configurarMontagem(a: Ator, orcamentoId: string, d: { modo: "assunto" | "livre"; tabelasExtras: string[] }) {
  if (d.modo !== "assunto" && d.modo !== "livre") throw new ErroDeRegra("Escolha como montar o orçamento.");
  await comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    const extras = [...new Set(d.tabelasExtras.filter((x) => uuid(x) && x !== o.tabelaId))];
    if (extras.length) {
      const ok = (await c.query("select id from tabela_preco where id = any($1::uuid[]) and situacao = 'liberada' and uf = $2", [extras, o.uf])).rows;
      if (ok.length !== extras.length) throw new ErroDeRegra("Uma das bases escolhidas não está liberada para esta UF.");
    }
    const emUso = (await c.query(
      `select distinct t.id from orcamento_item i join tabela_preco t on t.id = i.tabela_id
        where i.orcamento_id = $1 and i.tabela_id <> $2`, [orcamentoId, o.tabelaId])).rows.map((l) => l.id as string);
    await c.query("update orcamento set modo_montagem = $2, tabelas_extras = $3 where id = $1", [orcamentoId, d.modo, [...new Set([...extras, ...emUso])]]);
  });
}

/** Etapa com o nome dado; cria no fim quando não existe (usado ao lançar pelo assunto). */
export async function etapaPeloNome(a: Ator, orcamentoId: string, nome: string): Promise<string> {
  const n = nome.trim();
  if (!n) throw new ErroDeRegra("Informe o nome da etapa.");
  const existente = await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    return (await c.query("select id from orcamento_etapa where orcamento_id = $1 and lower(nome) = lower($2) order by ordem limit 1", [orcamentoId, n])).rows[0]?.id as string | undefined;
  });
  return existente ?? adicionarEtapa(a, orcamentoId, n);
}

/** Move uma etapa uma posição para cima ou para baixo. */
export async function moverEtapa(a: Ator, orcamentoId: string, etapaId: string, sentido: "subir" | "descer") {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const e = (await c.query("select ordem from orcamento_etapa where id = $1 and orcamento_id = $2", [etapaId, orcamentoId])).rows[0];
    if (!e) throw new ErroDeRegra("Etapa não encontrada.");
    const outra = (await c.query(
      `select id, ordem from orcamento_etapa where orcamento_id = $1 and ordem ${sentido === "subir" ? "<" : ">"} $2
        order by ordem ${sentido === "subir" ? "desc" : "asc"} limit 1`, [orcamentoId, e.ordem])).rows[0];
    if (!outra) return;
    // A ordem única é conferida só no fim da transação, então a troca é direta.
    await c.query("update orcamento_etapa set ordem = $2 where id = $1", [outra.id, e.ordem]);
    await c.query("update orcamento_etapa set ordem = $2 where id = $1", [etapaId, outra.ordem]);
  });
}

/** Move um item para outra etapa (vai para o fim dela) ou uma posição para cima ou para baixo na mesma etapa. */
export async function moverItem(a: Ator, orcamentoId: string, itemId: string, d: { etapaId?: string; sentido?: "subir" | "descer" }) {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const i = (await c.query("select id, etapa_id, ordem from orcamento_item where id = $1 and orcamento_id = $2", [itemId, orcamentoId])).rows[0];
    if (!i) throw new ErroDeRegra("Item não encontrado.");
    if (d.etapaId && d.etapaId !== i.etapa_id) {
      await etapaDoOrcamento(c, orcamentoId, d.etapaId);
      await c.query("update orcamento_item set etapa_id = $2, ordem = $3 where id = $1", [itemId, d.etapaId, await proximaOrdem(c, d.etapaId)]);
      await c.query(
        `update orcamento_item t set ordem = x.n from (select id, row_number() over (order by ordem) as n from orcamento_item where etapa_id = $1) x
          where t.id = x.id and t.ordem <> x.n`, [i.etapa_id]);
      return;
    }
    if (!d.sentido) return;
    const outro = (await c.query(
      `select id, ordem from orcamento_item where etapa_id = $1 and ordem ${d.sentido === "subir" ? "<" : ">"} $2
        order by ordem ${d.sentido === "subir" ? "desc" : "asc"} limit 1`, [i.etapa_id, i.ordem])).rows[0];
    if (!outro) return;
    await c.query("update orcamento_item set ordem = $2 where id = $1", [outro.id, i.ordem]);
    await c.query("update orcamento_item set ordem = $2 where id = $1", [itemId, outro.ordem]);
  });
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------
export async function adicionarEtapa(a: Ator, orcamentoId: string, nome: string): Promise<string> {
  if (!nome.trim()) throw new ErroDeRegra("Informe o nome da etapa.");
  return comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const ordem = (await c.query("select coalesce(max(ordem), 0) + 1 as n from orcamento_etapa where orcamento_id = $1", [orcamentoId])).rows[0].n;
    const r = await c.query("insert into orcamento_etapa (orgao_id, orcamento_id, ordem, nome) values ($1,$2,$3,$4) returning id", [a.orgaoId, orcamentoId, ordem, nome.trim()]);
    return r.rows[0].id;
  });
}

export async function renomearEtapa(a: Ator, orcamentoId: string, etapaId: string, nome: string) {
  if (!nome.trim()) throw new ErroDeRegra("Informe o nome da etapa.");
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    await c.query("update orcamento_etapa set nome = $3 where id = $2 and orcamento_id = $1", [orcamentoId, etapaId, nome.trim()]);
  });
}

export async function removerEtapa(a: Ator, orcamentoId: string, etapaId: string) {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const n = (await c.query("select count(*)::int as n from orcamento_item where etapa_id = $1", [etapaId])).rows[0].n;
    if (n > 0) throw new ErroDeRegra("Retire os itens da etapa antes de excluí-la.");
    await c.query("delete from orcamento_cronograma where etapa_id = $1", [etapaId]);
    await c.query("delete from orcamento_etapa where id = $1 and orcamento_id = $2", [etapaId, orcamentoId]);
    await c.query(
      `update orcamento_etapa e set ordem = x.n from (select id, row_number() over (order by ordem) as n from orcamento_etapa where orcamento_id = $1) x
        where e.id = x.id and e.ordem <> x.n`, [orcamentoId]);
  });
}

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------
type LinhaCongelada = {
  codigo: string; descricao: string; unidade: string; tipo: TipoInsumo; coeficiente: string; preco: string | null;
  fonte?: Fonte | null; ordem?: number | null;
  auxiliar_codigo?: string | null; auxiliar_descricao?: string | null; auxiliar_unidade?: string | null; auxiliar_coeficiente?: string | null;
};

function custoDasLinhas(linhas: LinhaCongelada[], regra: Regra) {
  return custoUnitario(linhas.map((l) => ({ coeficiente: dec(l.coeficiente), preco: l.preco == null ? null : dec(l.preco), tipo: l.tipo })), regra);
}

async function linhasDaComposicao(c: PoolClient, composicaoId: string, tabelaId: string): Promise<LinhaCongelada[]> {
  const r = await c.query(
    // Mesmo resultado de insumos_da_composicao, separado pela composição auxiliar de primeiro nível.
    `select i.codigo, i.descricao, i.unidade, i.tipo, round(x.coeficiente, 7)::text as coeficiente, p.preco::text as preco,
            i.fonte, x.ordem, ka.codigo as auxiliar_codigo, ka.descricao as auxiliar_descricao, ka.unidade as auxiliar_unidade,
            round(x.auxiliar_coeficiente, 7)::text as auxiliar_coeficiente
       from insumos_por_auxiliar($1, (select mes from tabela_preco where id = $2)) x
       join insumo i on i.id = x.insumo_id
       left join composicao ka on ka.id = x.auxiliar_id
       left join preco_insumo p on p.insumo_id = x.insumo_id and p.tabela_id = $2
      where round(x.coeficiente, 7) > 0
      order by x.ordem, i.tipo, i.descricao`,
    [composicaoId, tabelaId],
  );
  return r.rows;
}

function quantidade(q: string): string {
  const v = lerNumeroBr(q);
  if (v == null || v <= 0n) throw new ErroDeRegra("Informe uma quantidade maior que zero.");
  if (v > dec("999999999")) throw new ErroDeRegra("Quantidade grande demais.");
  return texto(v, 4);
}

async function proximaOrdem(c: PoolClient, etapaId: string) {
  return (await c.query("select coalesce(max(ordem), 0) + 1 as n from orcamento_item where etapa_id = $1", [etapaId])).rows[0].n as number;
}

async function etapaDoOrcamento(c: PoolClient, orcamentoId: string, etapaId: string) {
  if (!uuid(etapaId)) throw new ErroDeRegra("Escolha a etapa.");
  const r = await c.query("select 1 from orcamento_etapa where id = $1 and orcamento_id = $2", [etapaId, orcamentoId]);
  if (!r.rowCount) throw new ErroDeRegra("Escolha a etapa.");
}

async function inserirItem(
  c: PoolClient, a: Ator, o: Cabecalho, etapaId: string,
  d: { modo: ModoItem; fonte: Fonte; codigo: string | null; descricao: string; unidade: string; quantidade: string; tipoBdi?: "obra" | "fornecimento";
       memoria?: string | null; composicaoId?: string | null; insumoId?: string | null; criterio?: CriterioCotacao | null; justificativa?: string | null;
       tabelaId?: string | null; assuntoId?: string | null; classificacao?: string | null },
  linhas: LinhaCongelada[],
) {
  const cu = custoDasLinhas(linhas, o.arredondamento);
  const semPreco = cu.semPreco;
  const r = await c.query(
    `insert into orcamento_item (orgao_id, orcamento_id, etapa_id, ordem, modo, fonte, codigo, descricao, unidade, quantidade,
        custo_unitario, custo_material, custo_mao_obra, custo_equipamento, tipo_bdi, memoria, composicao_id, insumo_id, criterio_cotacao, justificativa,
        tabela_id, assunto_id, classificacao)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning id`,
    [a.orgaoId, o.id, etapaId, await proximaOrdem(c, etapaId), d.modo, d.fonte, d.codigo, d.descricao, d.unidade, d.quantidade,
      semPreco ? null : texto(cu.total), semPreco ? null : texto(cu.material), semPreco ? null : texto(cu.maoDeObra), semPreco ? null : texto(cu.equipamento),
      d.tipoBdi ?? "obra", d.memoria?.trim() || null, d.composicaoId ?? null, d.insumoId ?? null, d.criterio ?? null, d.justificativa?.trim() || null,
      d.modo === "cotacao" ? null : d.tabelaId ?? o.tabelaId, d.assuntoId ?? null, d.classificacao ?? null],
  );
  const itemId = r.rows[0].id as string;
  await gravarLinhas(c, a.orgaoId, itemId, linhas);
  return itemId;
}

/** Grava as linhas congeladas do item, com a fonte e a composição auxiliar de cada uma. */
async function gravarLinhas(c: PoolClient, orgaoId: string, itemId: string, linhas: LinhaCongelada[]) {
  if (!linhas.length) return;
  await c.query(
    `insert into orcamento_item_insumo (orgao_id, item_id, codigo, descricao, unidade, tipo, coeficiente, preco,
        fonte, ordem, auxiliar_codigo, auxiliar_descricao, auxiliar_unidade, auxiliar_coeficiente)
     select $1, $2, * from unnest($3::text[], $4::text[], $5::text[], $6::tipo_insumo[], $7::numeric[], $8::numeric[],
        $9::fonte_preco[], $10::int[], $11::text[], $12::text[], $13::text[], $14::numeric[])`,
    [orgaoId, itemId, linhas.map((l) => l.codigo), linhas.map((l) => l.descricao), linhas.map((l) => l.unidade),
      linhas.map((l) => l.tipo), linhas.map((l) => l.coeficiente), linhas.map((l) => l.preco),
      linhas.map((l) => l.fonte ?? null), linhas.map((l, i) => l.ordem ?? i), linhas.map((l) => l.auxiliar_codigo ?? null),
      linhas.map((l) => l.auxiliar_descricao ?? null), linhas.map((l) => l.auxiliar_unidade ?? null), linhas.map((l) => l.auxiliar_coeficiente ?? null)],
  );
}

type TabelaDoItem = { id: string; fonte: Fonte; mes: string; regime: Regime };

/**
 * Base de preços de um item novo: a do orçamento ou outra liberada (SINAPI, SICRO, SCO-Rio), que passa
 * a constar entre as bases do orçamento.
 */
async function tabelaDoItem(c: PoolClient, o: Cabecalho, tabelaId: string | null | undefined): Promise<TabelaDoItem> {
  const id = tabelaId || o.tabelaId;
  if (!uuid(id)) throw new ErroDeRegra("Base de preços não encontrada.");
  const t = (await c.query("select id, fonte, to_char(mes, 'YYYY-MM') as mes, regime, situacao, uf from tabela_preco where id = $1", [id])).rows[0];
  if (!t) throw new ErroDeRegra("Base de preços não encontrada.");
  if (t.situacao !== "liberada") throw new ErroDeRegra("Base de preços não liberada.");
  if (id !== o.tabelaId) {
    if (t.uf !== o.uf) throw new ErroDeRegra("A base de preços precisa ser da mesma UF do orçamento.");
    await c.query("update orcamento set tabelas_extras = array_append(tabelas_extras, $2) where id = $1 and not ($2 = any(tabelas_extras))", [o.id, id]);
  }
  return t;
}

export type NovoItemBase = {
  etapaId: string; quantidade: string; memoria?: string | null; tipoBdi?: "obra" | "fornecimento";
  /** Base do item; sem ela, a do orçamento. */
  tabelaId?: string | null;
  /** Assunto em que o serviço foi escolhido (orçamento por assunto). */
  assuntoId?: string | null;
};

/** Por serviço: a composição entra com material, mão de obra e equipamento, congelados na data-base. */
export async function adicionarComposicao(a: Ator, orcamentoId: string, composicaoId: string, d: NovoItemBase): Promise<string> {
  return comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    await etapaDoOrcamento(c, orcamentoId, d.etapaId);
    if (!uuid(composicaoId)) throw new ErroDeRegra("Composição não encontrada.");
    const k = (await c.query(
      `select k.id, k.fonte, k.codigo, k.descricao, k.unidade, k.aprovada, k.assunto_id,
              nullif(case when cl.codigo = cl.nome then cl.nome else concat_ws(' ', cl.codigo, cl.nome) end, '') as classificacao
         from composicao k left join classificacao cl on cl.id = k.classificacao_id where k.id = $1`, [composicaoId])).rows[0];
    if (!k) throw new ErroDeRegra("Composição não encontrada.");
    const t = await tabelaDoItem(c, o, k.fonte === "propria" ? o.tabelaId : d.tabelaId);
    if (k.fonte !== t.fonte && k.fonte !== "propria") throw new ErroDeRegra("A composição não é da base de preços escolhida.");
    if (!k.aprovada) throw new ErroDeRegra("A composição própria ainda não foi aprovada.");
    const linhas = await linhasDaComposicao(c, composicaoId, t.id);
    if (!linhas.length) throw new ErroDeRegra("A composição não tem insumos.");
    return inserirItem(c, a, o, d.etapaId, {
      modo: "servico", fonte: k.fonte, codigo: k.codigo, descricao: k.descricao, unidade: k.unidade, quantidade: quantidade(d.quantidade),
      tipoBdi: d.tipoBdi, memoria: d.memoria, composicaoId, tabelaId: t.id,
      assuntoId: d.assuntoId ?? k.assunto_id ?? null, classificacao: k.classificacao ?? null,
    }, linhas);
  });
}

/** Por material: o insumo entra com o preço da data-base. */
export async function adicionarInsumo(a: Ator, orcamentoId: string, insumoId: string, d: NovoItemBase): Promise<string> {
  return comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    await etapaDoOrcamento(c, orcamentoId, d.etapaId);
    if (!uuid(insumoId)) throw new ErroDeRegra("Insumo não encontrado.");
    const t = await tabelaDoItem(c, o, d.tabelaId);
    const i = (await c.query(
      `select i.fonte, i.codigo, i.descricao, i.unidade, i.tipo, p.preco::text as preco
         from insumo i left join preco_insumo p on p.insumo_id = i.id and p.tabela_id = $2 where i.id = $1`, [insumoId, t.id])).rows[0];
    if (!i) throw new ErroDeRegra("Insumo não encontrado.");
    if (i.fonte !== t.fonte) throw new ErroDeRegra("O insumo não é da base de preços escolhida.");
    return inserirItem(c, a, o, d.etapaId, {
      modo: "material", fonte: i.fonte, codigo: i.codigo, descricao: i.descricao, unidade: i.unidade, quantidade: quantidade(d.quantidade),
      tipoBdi: d.tipoBdi ?? "obra", memoria: d.memoria, insumoId, tabelaId: t.id, assuntoId: d.assuntoId ?? null,
    }, [{ codigo: i.codigo, descricao: i.descricao, unidade: i.unidade, tipo: i.tipo, coeficiente: "1.0000000", preco: i.preco, fonte: i.fonte, ordem: 0 }]);
  });
}

/** Fora da base oficial: preço por cotação de mercado, com no mínimo três cotações e justificativa. */
export async function adicionarItemCotado(
  a: Ator, orcamentoId: string,
  d: NovoItemBase & { descricao: string; unidade: string; tipo: TipoInsumo; criterio: CriterioCotacao; justificativa: string },
): Promise<string> {
  if (!d.descricao.trim() || !d.unidade.trim()) throw new ErroDeRegra("Informe a descrição e a unidade.");
  if (!d.justificativa.trim()) throw new ErroDeRegra("Informe por que o item está fora da base oficial.");
  if (!["media", "mediana", "menor"].includes(d.criterio)) throw new ErroDeRegra("Escolha o critério de preço.");
  return comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    await etapaDoOrcamento(c, orcamentoId, d.etapaId);
    return inserirItem(c, a, o, d.etapaId, {
      modo: "cotacao", fonte: "cotacao", codigo: null, descricao: d.descricao.trim().toUpperCase(), unidade: d.unidade.trim().toUpperCase(),
      quantidade: quantidade(d.quantidade), tipoBdi: d.tipoBdi, memoria: d.memoria, criterio: d.criterio, justificativa: d.justificativa,
    }, [{ codigo: "COT", descricao: d.descricao.trim().toUpperCase(), unidade: d.unidade.trim().toUpperCase(), tipo: d.tipo, coeficiente: "1.0000000", preco: null }]);
  });
}

async function itemDoOrcamento(c: PoolClient, orcamentoId: string, itemId: string) {
  if (!uuid(itemId)) throw new ErroDeRegra("Item não encontrado.");
  const r = await c.query("select * from orcamento_item where id = $1 and orcamento_id = $2", [itemId, orcamentoId]);
  if (!r.rows[0]) throw new ErroDeRegra("Item não encontrado.");
  return r.rows[0];
}

/** Só a quantidade (edição na própria linha da revisão); memória e BDI ficam como estão. */
export async function alterarQuantidade(a: Ator, orcamentoId: string, itemId: string, q: string) {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    await itemDoOrcamento(c, orcamentoId, itemId);
    await c.query("update orcamento_item set quantidade = $2 where id = $1", [itemId, quantidade(q)]);
  });
}

export async function editarItem(a: Ator, orcamentoId: string, itemId: string, d: { quantidade: string; memoria?: string | null; tipoBdi?: "obra" | "fornecimento" }) {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const i = await itemDoOrcamento(c, orcamentoId, itemId);
    await c.query("update orcamento_item set quantidade = $2, memoria = $3, tipo_bdi = $4 where id = $1",
      [itemId, quantidade(d.quantidade), d.memoria?.trim() || null, d.tipoBdi ?? i.tipo_bdi]);
  });
}

export async function removerItem(a: Ator, orcamentoId: string, itemId: string) {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const i = await itemDoOrcamento(c, orcamentoId, itemId);
    await c.query("delete from orcamento_item where id = $1", [itemId]);
    await c.query(
      `update orcamento_item t set ordem = x.n from (select id, row_number() over (order by ordem) as n from orcamento_item where etapa_id = $1) x
        where t.id = x.id and t.ordem <> x.n`, [i.etapa_id]);
  });
}

/** Recalcula o custo congelado de um item a partir das linhas dele (usado por cotação e mudança de regra). */
async function recalcularItem(c: PoolClient, itemId: string, regra: Regra) {
  const i = (await c.query("select modo, criterio_cotacao from orcamento_item where id = $1", [itemId])).rows[0];
  if (i.modo === "cotacao") {
    const v = (await c.query("select valor::text from cotacao where item_id = $1", [itemId])).rows.map((l) => dec(l.valor));
    const p = precoDasCotacoes(v, i.criterio_cotacao, regra);
    await c.query("update orcamento_item_insumo set preco = $2 where item_id = $1", [itemId, p == null ? null : texto(p)]);
  }
  const linhas = (await c.query("select codigo, descricao, unidade, tipo, coeficiente::text, preco::text from orcamento_item_insumo where item_id = $1", [itemId])).rows;
  const cu = custoDasLinhas(linhas, regra);
  await c.query(
    "update orcamento_item set custo_unitario = $2, custo_material = $3, custo_mao_obra = $4, custo_equipamento = $5 where id = $1",
    cu.semPreco ? [itemId, null, null, null, null] : [itemId, texto(cu.total), texto(cu.material), texto(cu.maoDeObra), texto(cu.equipamento)],
  );
}

async function recalcularTodos(c: PoolClient, orcamentoId: string, regra: Regra) {
  const r = await c.query("select id from orcamento_item where orcamento_id = $1", [orcamentoId]);
  for (const l of r.rows) await recalcularItem(c, l.id, regra);
}

export async function adicionarCotacao(
  a: Ator, orcamentoId: string, itemId: string, d: { fornecedor: string; cnpj?: string | null; data: string; valor: string; validade?: string | null },
) {
  if (!d.fornecedor.trim()) throw new ErroDeRegra("Informe o fornecedor.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.data)) throw new ErroDeRegra("Informe a data da cotação.");
  const valor = lerValorBr(d.valor);
  if (valor == null || valor <= 0n) throw new ErroDeRegra("Informe o valor da cotação.");
  if (d.validade && d.validade < d.data) throw new ErroDeRegra("A validade não pode ser antes da data da cotação.");
  await comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    const i = await itemDoOrcamento(c, orcamentoId, itemId);
    if (i.modo !== "cotacao") throw new ErroDeRegra("Este item usa preço da base oficial.");
    await c.query("insert into cotacao (orgao_id, item_id, fornecedor, cnpj, data, valor, validade) values ($1,$2,$3,$4,$5,$6,$7)",
      [a.orgaoId, itemId, d.fornecedor.trim(), d.cnpj?.trim() || null, d.data, texto(valor), d.validade || null]);
    await recalcularItem(c, itemId, o.arredondamento);
  });
}

export async function removerCotacao(a: Ator, orcamentoId: string, itemId: string, cotacaoId: string) {
  await comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    await itemDoOrcamento(c, orcamentoId, itemId);
    await c.query("delete from cotacao where id = $1 and item_id = $2", [cotacaoId, itemId]);
    await recalcularItem(c, itemId, o.arredondamento);
  });
}

export async function insumosDoItem(a: Ator, orcamentoId: string, itemId: string): Promise<InsumoDoItem[]> {
  return comContexto(ctx(a), async (c) => {
    await cabecalho(c, a, orcamentoId);
    await itemDoOrcamento(c, orcamentoId, itemId);
    const r = await c.query(
      `select id, codigo, descricao, unidade, tipo, coeficiente::text, preco::text, fonte, ordem, auxiliar_codigo as "auxiliarCodigo",
              auxiliar_descricao as "auxiliarDescricao", auxiliar_unidade as "auxiliarUnidade", auxiliar_coeficiente::text as "auxiliarCoeficiente"
         from orcamento_item_insumo where item_id = $1 order by ordem nulls last, tipo, descricao`, [itemId]);
    return r.rows;
  });
}

/** Composição analítica congelada de todos os itens, para a nota. */
export async function insumosDoOrcamento(a: Ator, orcamentoId: string): Promise<Map<string, InsumoDoItem[]>> {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    await cabecalho(c, a, orcamentoId);
    const r = await c.query(
      `select ii.item_id, ii.id, ii.codigo, ii.descricao, ii.unidade, ii.tipo, ii.coeficiente::text, ii.preco::text, ii.fonte, ii.ordem,
              ii.auxiliar_codigo as "auxiliarCodigo", ii.auxiliar_descricao as "auxiliarDescricao", ii.auxiliar_unidade as "auxiliarUnidade",
              ii.auxiliar_coeficiente::text as "auxiliarCoeficiente"
         from orcamento_item_insumo ii join orcamento_item i on i.id = ii.item_id
        where i.orcamento_id = $1 order by ii.ordem nulls last, ii.tipo, ii.descricao`, [orcamentoId]);
    const m = new Map<string, InsumoDoItem[]>();
    for (const { item_id, ...l } of r.rows) (m.get(item_id) ?? m.set(item_id, []).get(item_id)!).push(l);
    return m;
  });
}

// ---------------------------------------------------------------------------
// Troca de base: outro regime ou outro mês da mesma fonte
// ---------------------------------------------------------------------------
async function precificarEm(c: PoolClient, itemId: string, i: { modo: ModoItem; composicao_id: string | null; insumo_id: string | null }, tabelaId: string) {
  if (i.modo === "servico" && i.composicao_id) return linhasDaComposicao(c, i.composicao_id, tabelaId);
  if (i.modo === "material" && i.insumo_id) {
    const r = await c.query(
      `select i.codigo, i.descricao, i.unidade, i.tipo, '1.0000000' as coeficiente, p.preco::text as preco, i.fonte, 0 as ordem
         from insumo i left join preco_insumo p on p.insumo_id = i.id and p.tabela_id = $2 where i.id = $1`, [i.insumo_id, tabelaId]);
    return r.rows as LinhaCongelada[];
  }
  return (await c.query(
    `select codigo, descricao, unidade, tipo, coeficiente::text, preco::text, fonte, ordem, auxiliar_codigo, auxiliar_descricao,
            auxiliar_unidade, auxiliar_coeficiente::text from orcamento_item_insumo where item_id = $1`, [itemId])).rows as LinhaCongelada[];
}

export async function trocarBase(a: Ator, orcamentoId: string, tabelaId: string) {
  await comContexto(ctx(a), async (c) => {
    const o = await emRascunho(c, a, orcamentoId);
    const t = (await c.query("select fonte, uf, mes, regime, situacao, extract(year from mes)::int as ano from tabela_preco where id = $1", [tabelaId])).rows[0];
    if (!t || t.situacao !== "liberada") throw new ErroDeRegra("Base de preços não liberada.");
    if (t.fonte !== o.fonte) throw new ErroDeRegra("A nova base precisa ser da mesma fonte.");
    // Itens de outra base (ex.: SCO-Rio num orçamento SINAPI) continuam na base em que foram lançados.
    const itens = (await c.query(
      "select id, modo, composicao_id, insumo_id from orcamento_item where orcamento_id = $1 and (tabela_id is null or tabela_id = $2)",
      [orcamentoId, o.tabelaId])).rows;
    for (const i of itens) {
      if (i.modo === "cotacao") continue;
      const linhas = await precificarEm(c, i.id, i, tabelaId);
      await c.query("delete from orcamento_item_insumo where item_id = $1", [i.id]);
      await gravarLinhas(c, a.orgaoId, i.id, linhas);
      await c.query("update orcamento_item set tabela_id = $2 where id = $1", [i.id, tabelaId]);
    }
    const cprb = t.regime === "desonerado" ? cprbDoAno(t.ano) : "0.00";
    await c.query(
      `update orcamento set tabela_id = $2, uf = $3, mes = $4, regime = $5,
              bdi_obra = jsonb_set(bdi_obra, '{cprb}', to_jsonb($6::text)), bdi_fornecimento = jsonb_set(bdi_fornecimento, '{cprb}', to_jsonb($6::text))
        where id = $1`,
      [orcamentoId, tabelaId, t.uf, t.mes, t.regime, cprb]);
    await recalcularTodos(c, orcamentoId, o.arredondamento);
  });
}

/** Total do orçamento no outro regime, sem gravar nada. */
export async function compararRegimes(a: Ator, orcamentoId: string) {
  return comContexto(ctx(a), async (c) => {
    const o = await cabecalho(c, a, orcamentoId);
    const outra = (await c.query(
      `select t.id, t.regime, extract(year from t.mes)::int as ano from tabela_preco t join tabela_preco b on b.id = $1
        where t.fonte = b.fonte and t.uf = b.uf and t.mes = b.mes and t.regime <> b.regime and t.situacao = 'liberada'
          and t.orgao_id is not distinct from b.orgao_id`, [o.tabelaId])).rows[0];
    if (!outra) return null;
    const itens = (await c.query("select id, modo, composicao_id, insumo_id, tabela_id, quantidade::text, custo_unitario::text, tipo_bdi from orcamento_item where orcamento_id = $1", [orcamentoId])).rows;
    const bdiAtual = { obra: calcularBdi(o.bdiObra), fornecimento: calcularBdi(o.bdiFornecimento) };
    const cprb = outra.regime === "desonerado" ? cprbDoAno(outra.ano) : "0.00";
    const bdiOutro = { obra: calcularBdi({ ...o.bdiObra, cprb }), fornecimento: calcularBdi({ ...o.bdiFornecimento, cprb }) };
    let atual = ZERO, outro = ZERO, semPrecoOutro = 0;
    for (const i of itens) {
      const q = dec(i.quantidade);
      atual += calcularItem({ quantidade: q, custoUnitario: i.custo_unitario == null ? null : dec(i.custo_unitario), material: ZERO, maoDeObra: ZERO, equipamento: ZERO, tipoBdi: i.tipo_bdi }, bdiAtual, o.arredondamento).total;
      // Item de outra base (SICRO ou SCO-Rio num orçamento SINAPI, por exemplo) fica com o custo que tem.
      const daOutraBase = i.tabela_id && i.tabela_id !== o.tabelaId;
      const cu = daOutraBase
        ? custoDasLinhas(await precificarEm(c, i.id, { ...i, modo: "cotacao" }, outra.id), o.arredondamento)
        : custoDasLinhas(await precificarEm(c, i.id, i, outra.id), o.arredondamento);
      if (cu.semPreco) semPrecoOutro++;
      outro += calcularItem({ quantidade: q, custoUnitario: cu.semPreco ? null : cu.total, material: ZERO, maoDeObra: ZERO, equipamento: ZERO, tipoBdi: i.tipo_bdi }, bdiOutro, o.arredondamento).total;
    }
    return {
      atual: { regime: o.regime, total: texto(atual), bdi: texto(bdiAtual.obra) },
      outro: { regime: outra.regime as Regime, tabelaId: outra.id as string, total: texto(outro), bdi: texto(bdiOutro.obra), semPreco: semPrecoOutro },
      diferenca: texto(outro - atual),
    };
  });
}

// ---------------------------------------------------------------------------
// Cronograma físico-financeiro
// ---------------------------------------------------------------------------
export async function salvarCronograma(
  a: Ator, orcamentoId: string,
  d: { periodos: number; unidadePeriodo: "semana" | "mes"; inicio?: string | null; percentuais: Record<string, Record<number, string>> },
) {
  if (!Number.isInteger(d.periodos) || d.periodos < 1 || d.periodos > 60) throw new ErroDeRegra("Prazo entre 1 e 60 períodos.");
  if (!["semana", "mes"].includes(d.unidadePeriodo)) throw new ErroDeRegra("Escolha semanas ou meses.");
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, orcamentoId);
    const etapas = new Set((await c.query("select id from orcamento_etapa where orcamento_id = $1", [orcamentoId])).rows.map((l) => l.id));
    await c.query("update orcamento set periodos = $2, unidade_periodo = $3, inicio = $4 where id = $1", [orcamentoId, d.periodos, d.unidadePeriodo, d.inicio || null]);
    await c.query("delete from orcamento_cronograma where orcamento_id = $1", [orcamentoId]);
    for (const [etapaId, pcts] of Object.entries(d.percentuais)) {
      if (!etapas.has(etapaId)) continue;
      let total = ZERO;
      for (const [p, v] of Object.entries(pcts)) {
        const periodo = Number(p);
        const x = lerNumeroBr(v);
        if (x == null || x === 0n || periodo < 1 || periodo > d.periodos) continue;
        if (x < 0n || x > dec(100)) throw new ErroDeRegra("Cada percentual deve ficar entre 0% e 100%.");
        total += x;
        await c.query("insert into orcamento_cronograma (orgao_id, orcamento_id, etapa_id, periodo, percentual) values ($1,$2,$3,$4,$5)",
          [a.orgaoId, orcamentoId, etapaId, periodo, texto(x, 4)]);
      }
      if (total > dec(100)) throw new ErroDeRegra("A soma dos percentuais de uma etapa passou de 100%.");
    }
  });
}

// ---------------------------------------------------------------------------
// Montagem completa: itens, totais, pendências
// ---------------------------------------------------------------------------
const zeroTotais = (): Record<keyof Totais, Dec> => ({ custo: ZERO, material: ZERO, maoDeObra: ZERO, equipamento: ZERO, bdi: ZERO, total: ZERO });
const comoTexto = (t: Record<keyof Totais, Dec>): Totais => ({
  custo: texto(t.custo), material: texto(t.material), maoDeObra: texto(t.maoDeObra), equipamento: texto(t.equipamento), bdi: texto(t.bdi), total: texto(t.total),
});

async function montar(c: PoolClient, o: Cabecalho): Promise<OrcamentoCompleto> {
  // Em sequência: uma conexão do pg executa uma consulta por vez.
  const etapasR = await c.query("select id, ordem, nome from orcamento_etapa where orcamento_id = $1 order by ordem", [o.id]);
  const itensR = await c.query(
      `select i.id, i.etapa_id as "etapaId", i.ordem, i.modo, i.fonte, i.codigo, i.descricao, i.unidade, i.quantidade::text, i.custo_unitario::text as "custoUnitario",
              coalesce(i.custo_material, 0)::text as material, coalesce(i.custo_mao_obra, 0)::text as "maoDeObra", coalesce(i.custo_equipamento, 0)::text as equipamento,
              i.tipo_bdi as "tipoBdi", i.memoria, i.criterio_cotacao as "criterioCotacao", i.justificativa, i.composicao_id as "composicaoId", i.insumo_id as "insumoId",
              i.tabela_id as "tabelaId", to_char(t.mes, 'YYYY-MM') as "baseMes", t.regime as "baseRegime", i.assunto_id as "assuntoId", i.classificacao
         from orcamento_item i left join tabela_preco t on t.id = i.tabela_id where i.orcamento_id = $1 order by i.ordem`, [o.id]);
  const basesR = await c.query(
      `select t.id as "tabelaId", t.fonte, to_char(t.mes, 'YYYY-MM') as mes, t.regime, t.id = o.tabela_id as principal,
              (select count(*)::int from orcamento_item i where i.orcamento_id = o.id and i.tabela_id = t.id) as itens
         from orcamento o join tabela_preco t on t.id = o.tabela_id or t.id = any(o.tabelas_extras)
        where o.id = $1 order by (t.id = o.tabela_id) desc, t.fonte`, [o.id]);
  const modoR = await c.query("select modo_montagem from orcamento where id = $1", [o.id]);
  const cotR = await c.query(
      `select c.id, c.item_id, c.fornecedor, c.cnpj, to_char(c.data, 'YYYY-MM-DD') as data, c.valor::text as valor, to_char(c.validade, 'YYYY-MM-DD') as validade
         from cotacao c join orcamento_item i on i.id = c.item_id where i.orcamento_id = $1 order by c.data, c.fornecedor`, [o.id]);
  const cronoR = await c.query("select etapa_id, periodo, percentual::text from orcamento_cronograma where orcamento_id = $1", [o.id]);
  const bdi = { obra: calcularBdi(o.bdiObra), fornecimento: calcularBdi(o.bdiFornecimento) };
  const cotacoes = new Map<string, Cotacao[]>();
  for (const l of cotR.rows) cotacoes.set(l.item_id, [...(cotacoes.get(l.item_id) ?? []), l]);
  const geral = zeroTotais();
  let semPreco = 0, poucasCotacoes = 0;
  const etapas: Etapa[] = etapasR.rows.map((e) => {
    const t = zeroTotais();
    const itens: Item[] = itensR.rows.filter((i) => i.etapaId === e.id).map((i) => {
      const calc = calcularItem({
        quantidade: dec(i.quantidade), custoUnitario: i.custoUnitario == null ? null : dec(i.custoUnitario),
        material: dec(i.material), maoDeObra: dec(i.maoDeObra), equipamento: dec(i.equipamento), tipoBdi: i.tipoBdi,
      }, bdi, o.arredondamento);
      if (calc.semPreco) semPreco++;
      const cot = cotacoes.get(i.id) ?? [];
      if (i.modo === "cotacao" && cot.length < 3) poucasCotacoes++;
      t.custo += calc.custoTotal; t.material += calc.materialTotal; t.maoDeObra += calc.maoDeObraTotal;
      t.equipamento += calc.equipamentoTotal; t.total += calc.total;
      return {
        ...i, numero: `${e.ordem}.${i.ordem}`, cotacoes: cot,
        custoTotal: texto(calc.custoTotal), precoUnitario: texto(calc.precoUnitario), total: texto(calc.total), semPreco: calc.semPreco,
        materialTotal: texto(calc.materialTotal), maoDeObraTotal: texto(calc.maoDeObraTotal), equipamentoTotal: texto(calc.equipamentoTotal),
      };
    });
    t.bdi = t.total - t.custo;
    for (const k of Object.keys(geral) as (keyof Totais)[]) geral[k] += t[k];
    const percentuais: Record<number, string> = {};
    for (const p of cronoR.rows.filter((x) => x.etapa_id === e.id)) percentuais[p.periodo] = p.percentual;
    return { ...e, itens, totais: comoTexto(t), percentuais };
  });

  const pendencias: string[] = [];
  const nItens = itensR.rows.length;
  if (nItens === 0) pendencias.push("Nenhum item lançado.");
  if (semPreco) pendencias.push(semPreco === 1 ? "1 item sem preço." : `${semPreco} itens sem preço.`);
  if (poucasCotacoes) pendencias.push(poucasCotacoes === 1 ? "1 item com menos de três cotações." : `${poucasCotacoes} itens com menos de três cotações.`);
  const crono = calcularCronograma(etapas.map((e) => ({ id: e.id, total: dec(e.totais.total), percentuais: Object.fromEntries(Object.entries(e.percentuais).map(([k, v]) => [Number(k), dec(v)])) })), o.periodos, o.arredondamento);
  const abertas = etapas.filter((e, i) => e.itens.length && !crono.linhas[i].fechada);
  if (abertas.length) pendencias.push(`Cronograma: ${abertas.map((e) => `etapa ${e.ordem}`).join(", ")} não soma${abertas.length > 1 ? "m" : ""} 100%.`);
  if (!o.responsavelTecnico?.trim()) pendencias.push("Responsável técnico não informado.");

  return {
    ...o, etapas, bases: basesR.rows, modoMontagem: modoR.rows[0]?.modo_montagem ?? null, totais: comoTexto(geral), bdiObraPct: texto(bdi.obra), bdiFornecimentoPct: texto(bdi.fornecimento),
    avisosBdi: conferirBdi(o.bdiObra, o.tipoObraBdi), pendencias, semPreco,
  };
}

export async function obterOrcamento(a: Ator, id: string): Promise<OrcamentoCompleto> {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => montar(c, await cabecalho(c, a, id)));
}

/** Versões do mesmo orçamento (mesmo número na obra). */
export async function versoes(a: Ator, id: string) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const o = await cabecalho(c, a, id);
    const r = await c.query(`select ${COLUNAS} ${DE} where o.obra_id = $1 and o.numero = $2 order by o.versao desc`, [o.obraId, o.numero]);
    const lista = r.rows as Cabecalho[];
    const totais = await totaisRapidos(c, lista);
    return lista.map((x) => ({ ...x, total: totais.get(x.id) ?? "0.00" }));
  });
}

// ---------------------------------------------------------------------------
// Curva ABC
// ---------------------------------------------------------------------------
export async function curvaAbcServicos(a: Ator, id: string) {
  const o = await obterOrcamento(a, id);
  const linhas = o.etapas.flatMap((e) => e.itens).filter((i) => !i.semPreco)
    .map((i) => ({ numero: i.numero, codigo: i.codigo, fonte: i.fonte, descricao: i.descricao, unidade: i.unidade, quantidade: i.quantidade, precoUnitario: i.precoUnitario, valor: dec(i.total) }));
  return { orcamento: o, linhas: curvaAbc(linhas).map((l) => ({ ...l, valor: texto(l.valor), percentual: texto(l.percentual), acumulado: texto(l.acumulado) })) };
}

/** Insumos de todo o orçamento somados: quantidade total e custo (sem BDI). Base da lista de compras. */
export async function curvaAbcInsumos(a: Ator, id: string) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const o = await cabecalho(c, a, id);
    const r = await c.query(
      `select ii.codigo, ii.descricao, ii.unidade, ii.tipo, i.fonte, ii.coeficiente::text, ii.preco::text, i.quantidade::text
         from orcamento_item_insumo ii join orcamento_item i on i.id = ii.item_id where i.orcamento_id = $1`, [id]);
    const mapa = new Map<string, { codigo: string; descricao: string; unidade: string; tipo: TipoInsumo; fonte: Fonte; quantidade: Dec; preco: Dec | null; valor: Dec }>();
    for (const l of r.rows) {
      const chave = l.codigo === "COT" ? `COT|${l.descricao}` : `${l.fonte}|${l.codigo}`;
      const q = mul(dec(l.quantidade), dec(l.coeficiente));
      const atual = mapa.get(chave) ?? { codigo: l.codigo, descricao: l.descricao, unidade: l.unidade, tipo: l.tipo, fonte: l.fonte, quantidade: ZERO, preco: l.preco == null ? null : dec(l.preco), valor: ZERO };
      atual.quantidade += q;
      if (l.preco != null) atual.valor += mul(q, dec(l.preco));
      mapa.set(chave, atual);
    }
    const linhas = curvaAbc([...mapa.values()].map((l) => ({ ...l, valor: ajustar(l.valor, 2, o.arredondamento) })));
    return {
      orcamento: o,
      linhas: linhas.map((l) => ({
        codigo: l.codigo, descricao: l.descricao, unidade: l.unidade, tipo: l.tipo, fonte: l.fonte,
        quantidade: texto(l.quantidade, 4), preco: l.preco == null ? null : texto(l.preco),
        valor: texto(l.valor), percentual: texto(l.percentual), acumulado: texto(l.acumulado), classe: l.classe,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Cronograma calculado
// ---------------------------------------------------------------------------
export function cronogramaDo(o: OrcamentoCompleto) {
  const r = calcularCronograma(
    o.etapas.map((e) => ({ id: e.id, total: dec(e.totais.total), percentuais: Object.fromEntries(Object.entries(e.percentuais).map(([k, v]) => [Number(k), dec(v)])) })),
    o.periodos, o.arredondamento,
  );
  return {
    linhas: r.linhas.map((l) => ({ id: l.id, valores: l.valores.map((v) => texto(v)), soma: texto(l.somaPct), fechada: l.fechada })),
    porPeriodo: r.porPeriodo.map((v) => texto(v)), acumulado: r.acumulado.map((v) => texto(v)),
    pctPeriodo: r.pctPeriodo.map((v) => texto(v)), pctAcumulado: r.pctAcumulado.map((v) => texto(v)),
  };
}

// ---------------------------------------------------------------------------
// Aprovação, nota e versões
// ---------------------------------------------------------------------------
export async function aprovarOrcamento(a: Ator, id: string) {
  exigir(a, "orcamento.aprovar");
  return comContexto(ctx(a), async (c) => {
    await c.query("select 1 from orcamento where id = $1 for update", [id]);
    const o = await montar(c, await cabecalho(c, a, id));
    if (o.situacao !== "rascunho") throw new ErroDeRegra("Este orçamento já foi aprovado.");
    if (o.pendencias.length) throw new ErroDeRegra(`Resolva antes de aprovar: ${o.pendencias.join(" ")}`);
    // Uma obra tem um só orçamento aprovado em vigor: o anterior passa a substituído.
    await c.query("update orcamento set situacao = 'substituido' where obra_id = $1 and situacao = 'aprovado'", [o.obraId]);
    await c.query("update orcamento set situacao = 'aprovado', aprovado_por = $2, aprovado_em = now() where id = $1", [id, a.id]);
    const ano = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date()));
    await c.query("select pg_advisory_xact_lock(hashtext('nota_orcamento' || $1::text))", [a.orgaoId]);
    const numero = (await c.query("select coalesce(max(numero), 0) + 1 as n from nota_orcamento where orgao_id = $1 and ano = $2", [a.orgaoId, ano])).rows[0].n;
    await c.query(
      "insert into nota_orcamento (orgao_id, orcamento_id, ano, numero, emitida_por, resumo) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, id, ano, numero, a.id, JSON.stringify({ totais: o.totais, bdiObra: o.bdiObraPct, bdiFornecimento: o.bdiFornecimentoPct, dataBase: `${o.uf} ${o.mes}`, regime: o.regime, regra: o.arredondamento })],
    );
    if (o.obraSituacao === "em_estudo") {
      await c.query("select mudar_situacao_obra($1, 'orcada', $2)", [o.obraId, `Orçamento ${rotuloOrcamento(o)} aprovado, nota ${String(numero).padStart(4, "0")}/${ano}`]);
    }
    return { ano, numero };
  });
}

export async function cancelarOrcamento(a: Ator, id: string) {
  exigir(a, "orcamento.aprovar");
  await comContexto(ctx(a), async (c) => {
    const o = await cabecalho(c, a, id);
    if (o.situacao === "cancelado" || o.situacao === "substituido") throw new ErroDeRegra("Este orçamento não está em vigor.");
    await c.query("update orcamento set situacao = 'cancelado' where id = $1", [id]);
  });
}

/** Nova versão a partir de um orçamento aprovado: copia etapas, itens, preços congelados, cotações e cronograma. */
export async function novaVersao(a: Ator, id: string): Promise<string> {
  exigir(a, "orcamento.editar");
  return comContexto(ctx(a), async (c) => {
    const o = await cabecalho(c, a, id);
    if (o.situacao === "rascunho") throw new ErroDeRegra("Este orçamento ainda está em elaboração.");
    const emAberto = await c.query("select 1 from orcamento where obra_id = $1 and numero = $2 and situacao = 'rascunho'", [o.obraId, o.numero]);
    if (emAberto.rowCount) throw new ErroDeRegra("Já existe uma versão em elaboração deste orçamento.");
    const versao = (await c.query("select max(versao) + 1 as v from orcamento where obra_id = $1 and numero = $2", [o.obraId, o.numero])).rows[0].v;
    const novo = (await c.query(
      `insert into orcamento (orgao_id, obra_id, numero, versao, versao_anterior_id, nome, tabela_id, fonte, uf, mes, regime, arredondamento,
                              tipo_obra_bdi, bdi_obra, bdi_fornecimento, encargos_horista, encargos_mensalista, responsavel_tecnico,
                              registro_profissional, art, periodos, unidade_periodo, inicio, tabelas_extras, modo_montagem)
       select orgao_id, obra_id, numero, $2, id, nome, tabela_id, fonte, uf, mes, regime, arredondamento, tipo_obra_bdi, bdi_obra, bdi_fornecimento,
              encargos_horista, encargos_mensalista, responsavel_tecnico, registro_profissional, art, periodos, unidade_periodo, inicio,
              tabelas_extras, modo_montagem
         from orcamento where id = $1 returning id`, [id, versao])).rows[0].id as string;
    const etapas = (await c.query("select id, ordem, nome from orcamento_etapa where orcamento_id = $1", [id])).rows;
    for (const e of etapas) {
      const ne = (await c.query("insert into orcamento_etapa (orgao_id, orcamento_id, ordem, nome) values ($1,$2,$3,$4) returning id", [a.orgaoId, novo, e.ordem, e.nome])).rows[0].id;
      await c.query(
        `insert into orcamento_cronograma (orgao_id, orcamento_id, etapa_id, periodo, percentual)
         select orgao_id, $2, $3, periodo, percentual from orcamento_cronograma where etapa_id = $1`, [e.id, novo, ne]);
      const itens = (await c.query("select id from orcamento_item where etapa_id = $1 order by ordem", [e.id])).rows;
      for (const i of itens) {
        const ni = (await c.query(
          `insert into orcamento_item (orgao_id, orcamento_id, etapa_id, ordem, modo, fonte, codigo, descricao, unidade, quantidade, custo_unitario,
                                       custo_material, custo_mao_obra, custo_equipamento, tipo_bdi, memoria, criterio_cotacao, justificativa, composicao_id, insumo_id,
                                       tabela_id, assunto_id, classificacao)
           select orgao_id, $2, $3, ordem, modo, fonte, codigo, descricao, unidade, quantidade, custo_unitario, custo_material, custo_mao_obra,
                  custo_equipamento, tipo_bdi, memoria, criterio_cotacao, justificativa, composicao_id, insumo_id, tabela_id, assunto_id, classificacao
             from orcamento_item where id = $1 returning id`, [i.id, novo, ne])).rows[0].id;
        await c.query(
          `insert into orcamento_item_insumo (orgao_id, item_id, codigo, descricao, unidade, tipo, coeficiente, preco,
                                              fonte, ordem, auxiliar_codigo, auxiliar_descricao, auxiliar_unidade, auxiliar_coeficiente)
           select orgao_id, $2, codigo, descricao, unidade, tipo, coeficiente, preco,
                  fonte, ordem, auxiliar_codigo, auxiliar_descricao, auxiliar_unidade, auxiliar_coeficiente from orcamento_item_insumo where item_id = $1`, [i.id, ni]);
        await c.query(
          `insert into cotacao (orgao_id, item_id, fornecedor, cnpj, data, valor, validade, anexo)
           select orgao_id, $2, fornecedor, cnpj, data, valor, validade, anexo from cotacao where item_id = $1`, [i.id, ni]);
      }
    }
    return novo;
  });
}

export type LinhaComparacao = {
  chave: string; descricao: string; unidade: string;
  antes: { numero: string; quantidade: string; precoUnitario: string; total: string } | null;
  depois: { numero: string; quantidade: string; precoUnitario: string; total: string } | null;
  diferenca: string;
};

/** Comparação lado a lado com a versão anterior, item por item. */
export async function compararComAnterior(a: Ator, id: string) {
  const depois = await obterOrcamento(a, id);
  if (!depois.versaoAnteriorId) return null;
  const antes = await obterOrcamento(a, depois.versaoAnteriorId);
  const chave = (i: Item) => `${i.fonte}|${i.codigo ?? ""}|${i.descricao}`;
  const resumo = (i: Item) => ({ numero: i.numero, quantidade: i.quantidade, precoUnitario: i.precoUnitario, total: i.total });
  const mapa = new Map<string, LinhaComparacao>();
  for (const i of antes.etapas.flatMap((e) => e.itens)) mapa.set(chave(i), { chave: chave(i), descricao: i.descricao, unidade: i.unidade, antes: resumo(i), depois: null, diferenca: "0" });
  for (const i of depois.etapas.flatMap((e) => e.itens)) {
    const l = mapa.get(chave(i)) ?? { chave: chave(i), descricao: i.descricao, unidade: i.unidade, antes: null, depois: null, diferenca: "0" };
    l.depois = resumo(i);
    mapa.set(chave(i), l);
  }
  const linhas = [...mapa.values()].map((l) => ({ ...l, diferenca: texto(dec(l.depois?.total ?? "0") - dec(l.antes?.total ?? "0")) }))
    .filter((l) => l.diferenca !== "0.00" || !l.antes || !l.depois);
  return { antes, depois, linhas, diferenca: texto(dec(depois.totais.total) - dec(antes.totais.total)) };
}

export { soma };

// ---------------------------------------------------------------------------
// Medidas para a vista 3D (local de execução, altura e comprimento por item)
// ---------------------------------------------------------------------------
export type MedidaDoItem = { local: string; altura: number | null; comprimento: number | null };

export async function medidasDoOrcamento(a: Ator, orcamentoId: string): Promise<Record<string, MedidaDoItem>> {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    await cabecalho(c, a, orcamentoId);
    const r = await c.query("select item_id, local, altura::float8 as altura, comprimento::float8 as comprimento from orcamento_item_medida where orcamento_id = $1", [orcamentoId]);
    return Object.fromEntries(r.rows.map((l) => [l.item_id as string, { local: l.local as string, altura: l.altura as number | null, comprimento: l.comprimento as number | null }]));
  });
}

/** Grava as medidas de um item ou de todos os itens da etapa dele. Não mexe em quantidade nem em preço. */
export async function salvarMedidas(a: Ator, orcamentoId: string, itemId: string, d: { local: string; altura: number | null; comprimento: number | null; etapaInteira: boolean }) {
  exigir(a, "orcamento.editar");
  const local = d.local.trim();
  for (const v of [d.altura, d.comprimento]) if (v != null && !(v > 0 && v < 10000)) throw new ErroDeRegra("Informe medidas em metros, maiores que zero.");
  await comContexto(ctx(a), async (c) => {
    await cabecalho(c, a, orcamentoId);
    const item = (await c.query("select id, etapa_id, orgao_id from orcamento_item where id = $1 and orcamento_id = $2", [itemId, orcamentoId])).rows[0];
    if (!item) throw new ErroDeRegra("Item não encontrado.");
    const ids: string[] = d.etapaInteira
      ? (await c.query("select id from orcamento_item where etapa_id = $1 and orcamento_id = $2", [item.etapa_id, orcamentoId])).rows.map((l) => l.id)
      : [itemId];
    if (!local) { await c.query("delete from orcamento_item_medida where item_id = any($1)", [ids]); return; }
    for (const id of ids) {
      // Na etapa inteira, o comprimento vale só para o item escolhido; os demais saem da quantidade.
      await c.query(
        `insert into orcamento_item_medida (item_id, orgao_id, orcamento_id, local, altura, comprimento) values ($1, $2, $3, $4, $5, $6)
         on conflict (item_id) do update set local = excluded.local, altura = excluded.altura, comprimento = excluded.comprimento, atualizado_em = now()`,
        [id, item.orgao_id, orcamentoId, local, d.altura, id === itemId ? d.comprimento : null]);
    }
  });
}
