/**
 * Consultas do assistente de orçamento: assuntos, grupos de cada base, serviços com custo e ficha do serviço.
 *
 * Os assuntos são uma organização do CiviObras sobre a classificação de cada base (grupos do SINAPI,
 * grupos do SICRO, categoria > clã > família do SCO-Rio). A classificação original fica sempre visível.
 */
import { comContexto, type Contexto } from "../lib/db";
import type { Regra } from "../lib/decimal";
import type { Ator } from "./obras";
import { custoAjustado, filtroBusca, obterComposicao, type DetalheComposicao, type Fonte, type Regime, type TipoInsumo } from "./precos";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const soUuids = (l: string[]) => [...new Set(l.filter(uuid))];
/** O filtro de busca compara também o código; aqui a coluna precisa do apelido da tabela. */
const busca = (termo: string | undefined, coluna: string, params: unknown[], apelido: string) =>
  filtroBusca(termo, coluna, params).replaceAll(" codigo ilike", ` ${apelido}.codigo ilike`);

export type Assunto = { id: string; nome: string; resumo: string; icone: string; ordem: number; servicos: number; porFonte: Partial<Record<Fonte, number>> };

/** Assuntos com a quantidade de serviços disponíveis nas bases escolhidas. */
export async function listarAssuntos(a: Ator, tabelaIds: string[]): Promise<Assunto[]> {
  const ids = soUuids(tabelaIds);
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select s.id, s.nome, s.resumo, s.icone, s.ordem, k.fonte, count(k.id)::int as n
         from assunto s
         left join (select k.id, k.fonte, k.assunto_id from composicao k
                     where k.aprovada and k.fonte in (select fonte from tabela_preco where id = any($1::uuid[]))) k on k.assunto_id = s.id
        group by s.id, k.fonte order by s.ordem`, [ids]);
    const m = new Map<string, Assunto>();
    for (const l of r.rows) {
      let s = m.get(l.id);
      if (!s) { s = { id: l.id, nome: l.nome, resumo: l.resumo, icone: l.icone, ordem: l.ordem, servicos: 0, porFonte: {} }; m.set(l.id, s); }
      if (l.fonte) { s.servicos += l.n; s.porFonte[l.fonte as Fonte] = l.n; }
    }
    return [...m.values()];
  });
}

export type GrupoDoAssunto = { chave: string; fonte: Fonte; nome: string; caminho: string; servicos: number };

/** Grupos da classificação original de cada base dentro de um assunto (família do SCO-Rio, grupo do SINAPI e do SICRO). */
export async function gruposDoAssunto(a: Ator, assuntoId: string, tabelaIds: string[]): Promise<GrupoDoAssunto[]> {
  const ids = soUuids(tabelaIds);
  return comContexto(ctx(a), async (c) => {
    const r = await c.query(
      `select coalesce(cl.id::text, 'g:' || k.fonte || ':' || coalesce(k.grupo, '')) as chave, k.fonte,
              coalesce(cl.nome, k.grupo, 'Sem grupo') as nome,
              coalesce(concat_ws(' > ', c1.nome, c2.nome), '') as caminho,
              count(*)::int as servicos
         from composicao k
         left join classificacao cl on cl.id = k.classificacao_id
         left join classificacao c2 on c2.id = cl.pai_id
         left join classificacao c1 on c1.id = c2.pai_id
        where k.aprovada and k.assunto_id = $1 and k.fonte in (select fonte from tabela_preco where id = any($2::uuid[]))
        group by 1, 2, 3, 4 order by 2, 4, 3`, [assuntoId, ids]);
    return r.rows;
  });
}

export type ServicoComCusto = {
  id: string; fonte: Fonte; tabelaId: string; mes: string; regime: Regime; codigo: string; descricao: string; unidade: string;
  classificacao: string | null; assuntoId: string | null; custo: string | null; material: string; maoDeObra: string; equipamento: string; semPreco: number;
};

/**
 * Serviços (composições) das bases escolhidas, com o custo na data-base de cada uma.
 * Filtra por assunto, por grupo e por palavras da descrição ou do código.
 */
export async function buscarServicos(
  a: Ator, f: { tabelaIds: string[]; assuntoId?: string | null; grupo?: string | null; busca?: string; codigos?: string[]; unidade?: string; limite?: number; regra?: Regra },
): Promise<ServicoComCusto[]> {
  const ids = soUuids(f.tabelaIds);
  if (!ids.length) return [];
  return comContexto(ctx(a), async (c) => {
    const params: unknown[] = [ids];
    const cond = ["k.aprovada", busca(f.busca, "k.descricao", params, "k")];
    if (f.assuntoId) { params.push(f.assuntoId); cond.push(`k.assunto_id = $${params.length}`); }
    if (f.codigos?.length) { params.push(f.codigos); cond.push(`k.codigo = any($${params.length}::text[])`); }
    if (f.unidade) { params.push(f.unidade); cond.push(`upper(k.unidade) = upper($${params.length})`); }
    if (f.grupo) {
      if (uuid(f.grupo)) { params.push(f.grupo); cond.push(`k.classificacao_id = $${params.length}`); }
      else if (f.grupo.startsWith("g:")) {
        const [, fonte, ...g] = f.grupo.split(":");
        params.push(fonte, g.join(":"));
        cond.push(`k.classificacao_id is null and k.fonte::text = $${params.length - 1} and coalesce(k.grupo, '') = $${params.length}`);
      }
    }
    const r = await c.query(
      // Primeiro escolhe as linhas da página; o custo (recursivo) é calculado só para elas.
      `select k.id, k.fonte, k.tabela as "tabelaId", to_char(k.mes, 'YYYY-MM') as mes, k.regime, k.codigo, k.descricao, k.unidade,
              k.classificacao, k.assunto_id as "assuntoId", x.*
         from (select k.*, t.id as tabela, t.mes, t.regime, nullif(case when cl.codigo = cl.nome then cl.nome else concat_ws(' ', cl.codigo, cl.nome) end, '') as classificacao
                 from composicao k
                 join tabela_preco t on t.id = any($1::uuid[]) and t.fonte = k.fonte
                 left join classificacao cl on cl.id = k.classificacao_id
                where ${cond.join(" and ")}
                order by k.descricao, k.fonte limit ${Math.min(f.limite ?? 40, 100)}) k
         cross join lateral custo_composicao(k.id, k.tabela) x
        order by k.descricao, k.fonte`,
      params,
    );
    return r.rows.map((l) => ({
      id: l.id, fonte: l.fonte, tabelaId: l.tabelaId, mes: l.mes, regime: l.regime, codigo: l.codigo, descricao: l.descricao, unidade: l.unidade,
      classificacao: l.classificacao, assuntoId: l.assuntoId, ...custoAjustado(l, f.regra ?? "arredondar"),
    }));
  });
}

export type MaterialComPreco = {
  id: string; fonte: Fonte; tabelaId: string; mes: string; codigo: string; descricao: string; unidade: string; tipo: TipoInsumo; preco: string | null;
};

/** Materiais e demais insumos avulsos das bases escolhidas (orçamento livre). */
export async function buscarMateriais(
  a: Ator, f: { tabelaIds: string[]; busca?: string; tipo?: TipoInsumo | ""; limite?: number },
): Promise<MaterialComPreco[]> {
  const ids = soUuids(f.tabelaIds);
  if (!ids.length || !f.busca?.trim()) return [];
  return comContexto(ctx(a), async (c) => {
    const params: unknown[] = [ids];
    const cond = [busca(f.busca, "i.descricao", params, "i")];
    if (f.tipo) { params.push(f.tipo); cond.push(`i.tipo = $${params.length}`); }
    const r = await c.query(
      `select i.id, i.fonte, t.id as "tabelaId", to_char(t.mes, 'YYYY-MM') as mes, i.codigo, i.descricao, i.unidade, i.tipo, p.preco::text as preco
         from insumo i
         join tabela_preco t on t.id = any($1::uuid[]) and t.fonte = i.fonte
         left join preco_insumo p on p.insumo_id = i.id and p.tabela_id = t.id
        where ${cond.join(" and ")}
        order by (p.preco is null), i.descricao limit ${Math.min(f.limite ?? 40, 100)}`, params);
    return r.rows;
  });
}

export type FichaDoServico = DetalheComposicao & { caminho: string[]; assunto: { id: string; nome: string } | null };

/** Ficha do serviço: dados da base, classificação original, assunto e composição de primeiro nível com custos. */
export async function fichaDoServico(a: Ator, composicaoId: string, tabelaId: string): Promise<FichaDoServico> {
  const d = await obterComposicao(a, composicaoId, tabelaId);
  const extra = await comContexto(ctx(a), async (c) => (await c.query(
    `select s.id as assunto_id, s.nome as assunto_nome,
            array_remove(array[nullif(concat_ws(' ', nullif(c1.codigo, c1.nome), c1.nome), ''), nullif(concat_ws(' ', nullif(c2.codigo, c2.nome), c2.nome), ''), nullif(concat_ws(' ', nullif(cl.codigo, cl.nome), cl.nome), '')], null) as caminho
       from composicao k
       left join assunto s on s.id = k.assunto_id
       left join classificacao cl on cl.id = k.classificacao_id
       left join classificacao c2 on c2.id = cl.pai_id
       left join classificacao c1 on c1.id = c2.pai_id
      where k.id = $1`, [composicaoId])).rows[0]);
  const caminho = [...new Set<string>((extra?.caminho ?? []) as string[])];
  return {
    ...d, caminho: caminho.length ? caminho : d.grupo ? [d.grupo] : [],
    assunto: extra?.assunto_id ? { id: extra.assunto_id, nome: extra.assunto_nome } : null,
  };
}
