import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { ajustar, dec, mul, texto, type Regra } from "../lib/decimal";
import type { Ator } from "./obras";
import { exigir } from "./permissoes";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export type Fonte = "sinapi" | "sicro" | "sco" | "propria" | "cotacao" | "demonstracao";
export type Regime = "desonerado" | "nao_desonerado";
export type TipoInsumo = "material" | "mao_de_obra" | "equipamento" | "servico" | "taxa";

export const ROTULO_FONTE: Record<Fonte, string> = {
  sinapi: "SINAPI", sicro: "SICRO", sco: "SCO-Rio", propria: "Própria", cotacao: "Cotação", demonstracao: "Demonstração",
};
export const ROTULO_REGIME: Record<Regime, string> = { desonerado: "Desonerado", nao_desonerado: "Não desonerado" };
export const ROTULO_TIPO_INSUMO: Record<TipoInsumo, string> = {
  material: "Material", mao_de_obra: "Mão de obra", equipamento: "Equipamento", servico: "Serviço", taxa: "Taxa",
};

export type TabelaPreco = {
  id: string; fonte: Fonte; uf: string; mes: string; regime: Regime; situacao: "em_conferencia" | "liberada" | "recusada";
  arquivo: string | null; carregadaEm: Date; liberadaEm: Date | null; conferencia: Record<string, unknown>;
  composicoes: number; precos: number;
};

const COLUNAS_TABELA = `t.id, t.fonte, t.uf, to_char(t.mes, 'YYYY-MM') as mes, t.regime, t.situacao, t.arquivo,
  t.carregada_em as "carregadaEm", t.liberada_em as "liberadaEm", t.conferencia`;

export async function listarTabelas(a: Ator, filtro: { somenteLiberadas?: boolean } = {}): Promise<TabelaPreco[]> {
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select ${COLUNAS_TABELA},
              (select count(*)::int from preco_insumo p where p.tabela_id = t.id) as precos,
              (select count(*)::int from custo_publicado p where p.tabela_id = t.id) as composicoes
         from tabela_preco t
        where ($1::boolean is not true or t.situacao = 'liberada')
        order by t.mes desc, t.fonte, t.uf, t.regime`,
      [filtro.somenteLiberadas ?? false],
    );
    return r.rows;
  });
}

export async function obterTabela(a: Ator, id: string): Promise<TabelaPreco> {
  if (!uuid(id)) throw new ErroDeRegra("Tabela não encontrada.");
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(`select ${COLUNAS_TABELA}, 0 as precos, 0 as composicoes from tabela_preco t where t.id = $1`, [id]);
    if (!r.rows[0]) throw new ErroDeRegra("Tabela não encontrada.");
    return r.rows[0];
  });
}

/** A tabela do outro regime, mesma fonte, UF e mês. */
export async function tabelaDoOutroRegime(a: Ator, id: string): Promise<TabelaPreco | null> {
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select ${COLUNAS_TABELA}, 0 as precos, 0 as composicoes from tabela_preco t
         join tabela_preco b on b.id = $1
        where t.fonte = b.fonte and t.uf = b.uf and t.mes = b.mes and t.regime <> b.regime
          and t.orgao_id is not distinct from b.orgao_id and t.situacao = 'liberada'`,
      [id],
    );
    return r.rows[0] ?? null;
  });
}

export type InsumoComPreco = {
  id: string; fonte: Fonte; codigo: string; descricao: string; unidade: string; tipo: TipoInsumo; preco: string | null;
};

const termos = (busca: string) => busca.trim().split(/\s+/).filter(Boolean).slice(0, 6);

export function filtroBusca(busca: string | undefined, coluna: string, params: unknown[]) {
  const t = termos(busca ?? "");
  if (!t.length) return "true";
  return t.map((x) => {
    params.push(`%${x}%`);
    return `(unaccent_simples(${coluna}) ilike unaccent_simples($${params.length}) or codigo ilike $${params.length})`;
  }).join(" and ");
}

export async function buscarInsumos(
  a: Ator, f: { tabelaId: string; busca?: string; tipo?: TipoInsumo | ""; limite?: number },
): Promise<InsumoComPreco[]> {
  if (!uuid(f.tabelaId)) return [];
  return comContexto(ctx(a), async (c) => {
    const params: unknown[] = [f.tabelaId];
    const cond = [filtroBusca(f.busca, "i.descricao", params)];
    if (f.tipo) { params.push(f.tipo); cond.push(`i.tipo = $${params.length}`); }
    const r = await c.query(
      `select i.id, i.fonte, i.codigo, i.descricao, i.unidade, i.tipo, p.preco::text as preco
         from insumo i
         join tabela_preco t on t.id = $1 and t.fonte = i.fonte
         left join preco_insumo p on p.insumo_id = i.id and p.tabela_id = t.id
        where ${cond.join(" and ")}
        order by (p.preco is null), i.descricao limit ${Math.min(f.limite ?? 50, 200)}`,
      params,
    );
    return r.rows;
  });
}

export type ComposicaoComCusto = {
  id: string; fonte: Fonte; codigo: string; descricao: string; unidade: string; grupo: string | null;
  aprovada: boolean; custo: string | null; material: string; maoDeObra: string; equipamento: string; semPreco: number;
};

/** Ajusta o custo calculado pelo banco na regra do orçamento. */
export function custoAjustado(l: { material: string; mao_de_obra: string; equipamento: string; sem_preco: number; insumos: number }, regra: Regra) {
  const total = ajustar(dec(l.material) + dec(l.mao_de_obra) + dec(l.equipamento), 2, regra);
  return {
    custo: l.insumos === 0 || l.sem_preco > 0 ? null : texto(total),
    material: texto(dec(l.material)), maoDeObra: texto(dec(l.mao_de_obra)), equipamento: texto(dec(l.equipamento)),
    semPreco: l.insumos === 0 ? 1 : l.sem_preco,
  };
}

/** Composições da fonte da tabela e as próprias do órgão, com o custo na tabela. */
export async function buscarComposicoes(
  a: Ator, f: { tabelaId: string; busca?: string; somentePropria?: boolean; limite?: number; regra?: Regra },
): Promise<ComposicaoComCusto[]> {
  if (!uuid(f.tabelaId)) return [];
  return comContexto(ctx(a), async (c) => {
    const params: unknown[] = [f.tabelaId];
    const cond = [filtroBusca(f.busca, "k.descricao", params)];
    cond.push(f.somentePropria ? "k.fonte = 'propria'" : "(k.fonte = t.fonte or k.fonte = 'propria')");
    const r = await c.query(
      // Primeiro escolhe as linhas da página; o custo (recursivo) é calculado só para elas.
      `select k.id, k.fonte, k.codigo, k.descricao, k.unidade, k.grupo, k.aprovada, x.*
         from (select k.*, t.id as tabela
                 from composicao k
                 join tabela_preco t on t.id = $1
                where ${cond.join(" and ")}
                order by (k.fonte = 'propria') desc, k.descricao limit ${Math.min(f.limite ?? 40, 100)}) k
         cross join lateral custo_composicao(k.id, k.tabela) x
        order by (k.fonte = 'propria') desc, k.descricao`,
      params,
    );
    return r.rows.map((l) => ({
      id: l.id, fonte: l.fonte, codigo: l.codigo, descricao: l.descricao, unidade: l.unidade, grupo: l.grupo, aprovada: l.aprovada,
      ...custoAjustado(l, f.regra ?? "arredondar"),
    }));
  });
}

export type LinhaComposicao = {
  id: string; tipoLinha: "insumo" | "composicao"; refId: string; codigo: string; descricao: string; unidade: string;
  tipo: TipoInsumo | null; coeficiente: string; precoUnitario: string | null; total: string | null;
};

export type DetalheComposicao = ComposicaoComCusto & {
  justificativa: string | null; criadoPor: string | null; aprovadaPor: string | null; aprovadaEm: Date | null;
  criadoPorId: string | null; linhas: LinhaComposicao[]; tabela: TabelaPreco;
};

export async function obterComposicao(a: Ator, id: string, tabelaId: string): Promise<DetalheComposicao> {
  if (!uuid(id)) throw new ErroDeRegra("Composição não encontrada.");
  const tabela = await obterTabela(a, tabelaId);
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select k.id, k.fonte, k.codigo, k.descricao, k.unidade, k.grupo, k.aprovada, k.justificativa,
              k.aprovada_em as "aprovadaEm", k.criado_por as "criadoPorId",
              uc.nome as "criadoPor", ua.nome as "aprovadaPor", x.*
         from composicao k
         left join usuario uc on uc.id = k.criado_por
         left join usuario ua on ua.id = k.aprovada_por
         cross join lateral custo_composicao(k.id, $2) x
        where k.id = $1`,
      [id, tabelaId],
    );
    const k = r.rows[0];
    if (!k) throw new ErroDeRegra("Composição não encontrada.");
    const linhas = await c.query(
      `select ci.id::text, case when ci.insumo_id is null then 'composicao' else 'insumo' end as "tipoLinha",
              coalesce(ci.insumo_id, ci.subcomposicao_id) as "refId",
              coalesce(i.codigo, s.codigo) as codigo, coalesce(i.descricao, s.descricao) as descricao,
              coalesce(i.unidade, s.unidade) as unidade, i.tipo, ci.coeficiente::text as coeficiente,
              case when ci.insumo_id is not null then p.preco::text
                   when sc.insumos > 0 and sc.sem_preco = 0 then (sc.material + sc.mao_de_obra + sc.equipamento)::text end as "precoUnitario"
         from composicao_item ci
         left join insumo i on i.id = ci.insumo_id
         left join composicao s on s.id = ci.subcomposicao_id
         left join preco_insumo p on p.insumo_id = ci.insumo_id and p.tabela_id = $2
         left join lateral (select * from custo_composicao(ci.subcomposicao_id, $2)) sc on ci.subcomposicao_id is not null
        where ci.composicao_id = $1 and ci.mes is not distinct from mes_da_estrutura($1, $3::date)
        order by (ci.insumo_id is null), coalesce(i.tipo::text, 'z'), coalesce(i.descricao, s.descricao)`,
      [id, tabelaId, `${tabela.mes}-01`],
    );
    return {
      ...k, tabela, ...custoAjustado(k, "arredondar"),
      linhas: linhas.rows.map((l) => ({
        ...l,
        precoUnitario: l.precoUnitario == null ? null : texto(dec(l.precoUnitario)),
        total: l.precoUnitario == null ? null : texto(mul(dec(l.coeficiente), dec(l.precoUnitario))),
      })),
    };
  });
}

export type PontoHistorico = { tabelaId: string; mes: string; uf: string; regime: Regime; preco: string };

export async function obterInsumo(a: Ator, id: string) {
  if (!uuid(id)) throw new ErroDeRegra("Insumo não encontrado.");
  return comContexto(ctx(a), async (c) => {
    const r = await c.query("select id, fonte, codigo, descricao, unidade, tipo, grupo from insumo where id = $1", [id]);
    if (!r.rows[0]) throw new ErroDeRegra("Insumo não encontrado.");
    const h = await c.query(
      `select t.id as "tabelaId", to_char(t.mes, 'YYYY-MM') as mes, t.uf, t.regime, p.preco::text as preco
         from preco_insumo p join tabela_preco t on t.id = p.tabela_id
        where p.insumo_id = $1 order by t.mes, t.uf, t.regime`,
      [id],
    );
    return { ...(r.rows[0] as InsumoComPreco & { grupo: string | null }), historico: h.rows as PontoHistorico[] };
  });
}

// ---------------------------------------------------------------------------
// Composições próprias
// ---------------------------------------------------------------------------
export type DadosComposicaoPropria = { codigo: string; descricao: string; unidade: string; justificativa: string; origemId?: string | null };

export async function criarComposicaoPropria(a: Ator, d: DadosComposicaoPropria): Promise<string> {
  exigir(a, "precos.composicao_propria");
  const codigo = d.codigo.trim().toUpperCase(), descricao = d.descricao.trim(), unidade = d.unidade.trim();
  if (!codigo || !descricao || !unidade) throw new ErroDeRegra("Informe código, descrição e unidade.");
  if (!d.justificativa.trim()) throw new ErroDeRegra("Informe a justificativa técnica.");
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `insert into composicao (orgao_id, fonte, codigo, descricao, unidade, justificativa, origem_id, aprovada)
       values ($1, 'propria', $2, $3, $4, $5, $6, false) returning id`,
      [a.orgaoId, codigo, descricao, unidade, d.justificativa.trim(), d.origemId || null],
    ).catch((e) => {
      if (e?.code === "23505") throw new ErroDeRegra("Já existe uma composição própria com este código.");
      throw e;
    });
    const id = r.rows[0].id as string;
    // Adaptação: começa com os mesmos itens da composição de origem, na estrutura mais recente.
    if (d.origemId) {
      await c.query(
        `insert into composicao_item (composicao_id, mes, insumo_id, subcomposicao_id, coeficiente)
         select $1, null, insumo_id, subcomposicao_id, coeficiente from composicao_item
          where composicao_id = $2 and mes is not distinct from mes_da_estrutura($2, 'infinity'::date)`,
        [id, d.origemId],
      );
    }
    return id;
  });
}

async function composicaoEditavel(a: Ator, id: string) {
  const r = await comContexto(ctx(a), (c) => c.query("select fonte, aprovada, orgao_id from composicao where id = $1", [id]));
  const k = r.rows[0];
  if (!k || k.fonte !== "propria" || k.orgao_id !== a.orgaoId) throw new ErroDeRegra("Composição própria não encontrada.");
  if (k.aprovada) throw new ErroDeRegra("Composição aprovada não pode ser alterada. Crie uma nova a partir dela.");
}

export async function adicionarItemComposicao(
  a: Ator, composicaoId: string, item: { insumoId?: string | null; subcomposicaoId?: string | null; coeficiente: string },
) {
  exigir(a, "precos.composicao_propria");
  if (!uuid(composicaoId)) throw new ErroDeRegra("Composição não encontrada.");
  await composicaoEditavel(a, composicaoId);
  const coef = dec(item.coeficiente);
  if (coef <= 0n) throw new ErroDeRegra("O coeficiente deve ser maior que zero.");
  if (!item.insumoId === !item.subcomposicaoId) throw new ErroDeRegra("Escolha um insumo ou uma composição.");
  if (item.subcomposicaoId === composicaoId) throw new ErroDeRegra("A composição não pode conter ela mesma.");
  await comContexto(ctx(a), (c) =>
    c.query("insert into composicao_item (composicao_id, mes, insumo_id, subcomposicao_id, coeficiente) values ($1, null, $2, $3, $4)",
      [composicaoId, item.insumoId || null, item.subcomposicaoId || null, texto(coef, 7)]));
}

export async function removerItemComposicao(a: Ator, composicaoId: string, itemId: string) {
  exigir(a, "precos.composicao_propria");
  await composicaoEditavel(a, composicaoId);
  await comContexto(ctx(a), (c) => c.query("delete from composicao_item where id = $1 and composicao_id = $2", [itemId, composicaoId]));
}

/** Aprovação por outra pessoa, diferente de quem criou. */
export async function aprovarComposicao(a: Ator, composicaoId: string) {
  exigir(a, "precos.aprovar_composicao");
  await composicaoEditavel(a, composicaoId);
  await comContexto(ctx(a), async (c) => {
    const k = (await c.query("select criado_por, (select count(*)::int from composicao_item where composicao_id = $1) as n from composicao where id = $1", [composicaoId])).rows[0];
    if (k.criado_por === a.id && !a.administrador) throw new ErroDeRegra("A aprovação precisa ser feita por outra pessoa.");
    if (k.n === 0) throw new ErroDeRegra("Inclua pelo menos um insumo antes de aprovar.");
    await c.query("update composicao set aprovada = true, aprovada_por = $2, aprovada_em = now() where id = $1", [composicaoId, a.id]);
  });
}

export async function listarComposicoesProprias(a: Ator) {
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select k.id, k.codigo, k.descricao, k.unidade, k.aprovada, k.criado_em as "criadoEm", u.nome as "criadoPor",
              (select count(*)::int from composicao_item ci where ci.composicao_id = k.id) as itens
         from composicao k left join usuario u on u.id = k.criado_por
        where k.fonte = 'propria' order by k.codigo`,
    );
    return r.rows as { id: string; codigo: string; descricao: string; unidade: string; aprovada: boolean; criadoEm: Date; criadoPor: string | null; itens: number }[];
  });
}

/**
 * Aviso sobre a base oficial: sem SINAPI carregado, com carga parada em conferência ou com a
 * referência atrasada. A Caixa publica o mês por volta do dia 10 do mês seguinte; a carga
 * automática tenta até o dia 28. `hoje` em AAAA-MM-DD.
 */
export function avisoDaBase(tabelas: Pick<TabelaPreco, "fonte" | "mes" | "situacao">[], hoje: string): string | null {
  const aviso = avisoSinapi(tabelas, hoje);
  if (aviso) return aviso;
  // SICRO é opcional: só avisa quando uma carga trimestral parou em conferência.
  const sicro = tabelas.filter((t) => t.fonte === "sicro");
  const ultimaSicro = sicro.filter((t) => t.situacao === "liberada").map((t) => t.mes).sort().pop() ?? "";
  const paradaSicro = sicro.filter((t) => t.situacao === "em_conferencia" && t.mes > ultimaSicro).map((t) => t.mes).sort().pop();
  if (paradaSicro) return `A carga do SICRO de ${paradaSicro.slice(5, 7)}/${paradaSicro.slice(0, 4)} ficou em conferência e não foi liberada.`;
  return null;
}

function avisoSinapi(tabelas: Pick<TabelaPreco, "fonte" | "mes" | "situacao">[], hoje: string): string | null {
  const sinapi = tabelas.filter((t) => t.fonte === "sinapi");
  const liberadas = sinapi.filter((t) => t.situacao === "liberada").map((t) => t.mes).sort();
  const ultima = liberadas[liberadas.length - 1];
  const rotulo = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
  if (!ultima) return "SINAPI oficial ainda não carregado. Os preços em uso são de demonstração.";
  const parada = sinapi.filter((t) => t.situacao === "em_conferencia" && t.mes > ultima).map((t) => t.mes).sort().pop();
  if (parada) return `A carga do SINAPI de ${rotulo(parada)} ficou em conferência e não foi liberada. Em uso: ${rotulo(ultima)}.`;
  const [a, m] = hoje.slice(0, 7).split("-").map(Number);
  const anterior = (n: number) => { const t = a * 12 + (m - 1) - n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
  const esperado = Number(hoje.slice(8, 10)) > 25 ? anterior(1) : anterior(2);
  return ultima < esperado ? `SINAPI desatualizado: a última referência carregada é ${rotulo(ultima)}.` : null;
}
