/**
 * Planilhas sintética e analítica do orçamento, montadas a partir dos itens e dos insumos congelados
 * no lançamento. A mesma estrutura alimenta a tela, o PDF (impressão) e o Excel.
 *
 * Nada é estimado: cada linha vem da composição da base (fonte, código e data-base do item).
 * As composições auxiliares aparecem com o custo unitário calculado a partir dos próprios insumos.
 */
import type { InsumoDoItem, Item, OrcamentoCompleto } from "./orcamentos";
import type { Fonte, TipoInsumo } from "./precos";

export type LinhaAnalitica = {
  nivel: 0 | 1;
  tipo: "insumo" | "auxiliar";
  codigo: string;
  fonte: Fonte | null;
  descricao: string;
  tipoInsumo: TipoInsumo | null;
  unidade: string;
  /** Na linha de nível 0: coeficiente na composição do item. No nível 1: coeficiente dentro da auxiliar. */
  coeficiente: number;
  preco: number | null;
  parcial: number | null;
};

export type ItemAnalitico = { item: Item; linhas: LinhaAnalitica[]; soma: number | null };

const num = (v: string | null | undefined) => (v == null ? null : Number(v));

/** Separa os insumos do item em diretos e composições auxiliares (com os insumos de cada uma). */
export function analiticaDoItem(item: Item, insumos: InsumoDoItem[]): ItemAnalitico {
  const blocos: ({ tipo: "insumo"; l: InsumoDoItem } | { tipo: "auxiliar"; codigo: string; l: InsumoDoItem[] })[] = [];
  const porAux = new Map<string, InsumoDoItem[]>();
  for (const l of insumos) {
    if (!l.auxiliarCodigo) { blocos.push({ tipo: "insumo", l }); continue; }
    const chave = `${l.auxiliarCodigo}|${l.auxiliarDescricao ?? ""}`;
    let g = porAux.get(chave);
    if (!g) { g = []; porAux.set(chave, g); blocos.push({ tipo: "auxiliar", codigo: l.auxiliarCodigo, l: g }); }
    g.push(l);
  }
  const linhas: LinhaAnalitica[] = [];
  let soma: number | null = 0;
  for (const b of blocos) {
    if (b.tipo === "insumo") {
      const coef = Number(b.l.coeficiente), preco = num(b.l.preco);
      const parcial = preco == null ? null : coef * preco;
      linhas.push({ nivel: 0, tipo: "insumo", codigo: b.l.codigo, fonte: b.l.fonte, descricao: b.l.descricao, tipoInsumo: b.l.tipo, unidade: b.l.unidade, coeficiente: coef, preco, parcial });
      soma = soma == null || parcial == null ? null : soma + parcial;
      continue;
    }
    const p = b.l[0];
    const coefAux = Number(p.auxiliarCoeficiente ?? 0) || 1;
    const filhos: LinhaAnalitica[] = b.l.map((l) => {
      const coef = Number(l.coeficiente) / coefAux, preco = num(l.preco);
      return { nivel: 1, tipo: "insumo", codigo: l.codigo, fonte: l.fonte, descricao: l.descricao, tipoInsumo: l.tipo, unidade: l.unidade, coeficiente: coef, preco, parcial: preco == null ? null : coef * preco };
    });
    const custoAux = filhos.some((f) => f.parcial == null) ? null : filhos.reduce((s, f) => s + f.parcial!, 0);
    const parcial = custoAux == null ? null : custoAux * coefAux;
    linhas.push({ nivel: 0, tipo: "auxiliar", codigo: b.codigo, fonte: p.fonte, descricao: p.auxiliarDescricao ?? "", tipoInsumo: null, unidade: p.auxiliarUnidade ?? "", coeficiente: coefAux, preco: custoAux, parcial });
    linhas.push(...filhos);
    soma = soma == null || parcial == null ? null : soma + parcial;
  }
  return { item, linhas, soma };
}

export function analiticaDoOrcamento(o: OrcamentoCompleto, insumos: Map<string, InsumoDoItem[]>): ItemAnalitico[] {
  return o.etapas.flatMap((e) => e.itens).map((i) => analiticaDoItem(i, insumos.get(i.id) ?? []));
}

/** Peso de cada item no valor global, em %. */
export const peso = (o: OrcamentoCompleto, total: string) => (Number(o.totais.total) ? (Number(total) / Number(o.totais.total)) * 100 : 0);
