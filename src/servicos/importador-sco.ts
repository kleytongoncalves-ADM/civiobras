/**
 * Leitura do catálogo SCO-Rio (Prefeitura do Rio de Janeiro, https://www2.rio.rj.gov.br/sco/).
 *
 * O SCO-Rio não tem API nem arquivo para baixar: o acesso é a pesquisa pública. A hierarquia é
 * Categoria (AL) > Clã (04) > Família (05) > Item de serviço (0050), e cada item tem uma
 * composição mensal com itens elementares (MAT material, MOD mão de obra, EQ.. equipamento,
 * EVE percentual sobre a mão de obra, RSE outro item de serviço), quantidade, custo unitário e parcial.
 *
 * Aqui ficam só as funções que interpretam as páginas e montam a carga. O download fica no robô
 * (scripts/atualizar-sco.ts), para poder rodar no GitHub ou no computador do usuário.
 */
import type { TipoInsumo } from "./precos";
import type { CargaSinapi } from "./importador-sinapi";

export const SCO_BASE = "https://www2.rio.rj.gov.br/sco/";

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ordm: "º", ordf: "ª", copy: "©", deg: "°", sup2: "²", sup3: "³", frac12: "½", frac14: "¼", times: "×" };
const ACENTOS: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308", cedil: "\u0327" };
/** Entidade nomeada: as fixas acima e as letras acentuadas (&aacute; &Ccedil; &otilde; ...). */
function entidade(m: string, nome: string): string {
  if (ENTIDADES[nome] ?? ENTIDADES[nome.toLowerCase()]) return ENTIDADES[nome] ?? ENTIDADES[nome.toLowerCase()];
  const a = nome.match(/^([A-Za-z])(acute|grave|circ|tilde|uml|cedil)$/);
  return a ? (a[1] + ACENTOS[a[2]]).normalize("NFC") : m;
}

/** Texto de um trecho de HTML: sem marcações, entidades decodificadas e espaços reduzidos. */
export function textoDe(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z0-9]+);/gi, entidade)
    .replace(/\s+/g, " ")
    .trim();
}

/** Linhas de todas as tabelas da página, cada uma com o texto das células (td/th). */
export function linhasDaPagina(html: string): { celulas: string[]; html: string }[] {
  const linhas: { celulas: string[]; html: string }[] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi)) {
    const celulas = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi)].map((c) => textoDe(c[1]));
    if (celulas.some((c) => c)) linhas.push({ celulas, html: tr[1] });
  }
  return linhas;
}

/** Opções de um select da página de pesquisa (mês de referência, categoria, clã, família). */
export function opcoesDoSelect(html: string, nome: string): { valor: string; texto: string }[] {
  const m = html.match(new RegExp(`<select[^>]*name=["']?${nome}["']?[^>]*>([\\s\\S]*?)</select>`, "i"));
  if (!m) return [];
  return [...m[1].matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|$)/gi)]
    .map((o) => ({ valor: (o[1].match(/value=["']?([^"'\s>]*)/i)?.[1] ?? "").trim(), texto: textoDe(o[2]) }))
    .filter((o) => o.texto && !/selecione/i.test(o.texto));
}

/** "1.234,56" → "1234.56". */
export function numeroBr(v: string): string | null {
  const s = v.replace(/\s/g, "");
  if (!/^-?[\d.]*\d(,\d+)?$/.test(s)) return null;
  return s.replace(/\./g, "").replace(",", ".");
}

/** Código canônico do item de serviço: "AL 04.05.0050" ou, com letra, "AL 10.10.0050(A)". */
export function codigoSco(bruto: string): string | null {
  const m = bruto.replace(/\s+/g, " ").match(/([A-Z]{2})\s?(\d{2})\.(\d{2})\.(\d{4})\s?\(?\s?([A-Z/])?\s?\)?/);
  if (!m) return null;
  const base = `${m[1]} ${m[2]}.${m[3]}.${m[4]}`;
  return m[5] && m[5] !== "/" ? `${base}(${m[5]})` : base;
}

/** Categoria, clã e família de um código: "AL 04.05.0050" → AL, AL04, AL04.05. */
export function niveisDoCodigo(codigo: string) {
  const m = codigo.match(/^([A-Z]{2}) (\d{2})\.(\d{2})\./);
  if (!m) return null;
  return { categoria: m[1], cla: `${m[1]}${m[2]}`, familia: `${m[1]}${m[2]}.${m[3]}` };
}

export type ItemDaLista = { codigo: string; descricao: string; unidade: string; custo: string | null; endereco: string | null };

/** Página de resultado da pesquisa: itens, total e até qual item a página vai. */
export function lerLista(html: string): { itens: ItemDaLista[]; total: number | null; ate: number | null; mes: string | null } {
  const itens: ItemDaLista[] = [];
  for (const l of linhasDaPagina(html)) {
    const [cod, descricao, unidade, custo] = l.celulas;
    const codigo = cod ? codigoSco(cod) : null;
    if (!codigo || l.celulas.length < 4 || !descricao) continue;
    const href = l.html.match(/href=["']?([^"'>\s]*composicaosco\.cfm[^"'>\s]*)/i)?.[1] ?? null;
    itens.push({ codigo, descricao, unidade: unidade ?? "", custo: custo ? numeroBr(custo) : null, endereco: href ? href.replace(/&amp;/g, "&") : null });
  }
  const texto = textoDe(html);
  const total = texto.match(/total de\s*([\d.]+)/i)?.[1];
  const ate = texto.match(/ao item\s*([\d.]+)/i)?.[1];
  const mes = texto.match(/Refer[eê]ncia:?\s*(\d{1,2})\/(\d{4})/i);
  return {
    itens,
    total: total ? Number(total.replace(/\./g, "")) : itens.length ? itens.length : 0,
    ate: ate ? Number(ate.replace(/\./g, "")) : null,
    mes: mes && mes[2] !== "0" ? `${mes[2]}-${mes[1].padStart(2, "0")}-01` : null,
  };
}

export type LinhaSco = {
  elementar: string; antigo: string; reutilizado: string | null; descricao: string; unidade: string;
  quantidade: string; custoUnitario: string; custoParcial: string;
};
export type ComposicaoSco = { codigo: string; descricao: string; unidade: string; custo: string | null; mes: string | null; linhas: LinhaSco[] };

/** Página de composição de um item de serviço. */
export function lerComposicao(html: string): ComposicaoSco | null {
  const linhas = linhasDaPagina(html);
  const campo = (rotulo: RegExp) => {
    for (const l of linhas) {
      const i = l.celulas.findIndex((c) => rotulo.test(c));
      if (i >= 0 && l.celulas[i + 1] != null) return l.celulas[i + 1];
    }
    return null;
  };
  const codigo = codigoSco(campo(/^Item de Servi/i) ?? "");
  if (!codigo) return null;
  const mesTxt = campo(/^M[eê]s\/Ano/i)?.match(/(\d{1,2})\/(\d{4})/);
  const itens: LinhaSco[] = [];
  for (const l of linhas) {
    const c = l.celulas;
    if (c.length < 8 || !/^[A-Z]{3}\d{6}$/.test(c[0])) continue;
    const quantidade = numeroBr(c[5]), custoUnitario = numeroBr(c[6]), custoParcial = numeroBr(c[7]);
    if (quantidade == null || custoUnitario == null || custoParcial == null) continue;
    itens.push({
      elementar: c[0], antigo: c[1], reutilizado: c[2] ? codigoSco(c[2]) : null, descricao: c[3], unidade: c[4],
      quantidade, custoUnitario, custoParcial,
    });
  }
  const custo = campo(/^Custo$/i);
  return {
    codigo, descricao: campo(/^Descri/i) ?? "", unidade: campo(/^Und/i) ?? "",
    custo: custo ? numeroBr(custo) : null, mes: mesTxt ? `${mesTxt[2]}-${mesTxt[1].padStart(2, "0")}-01` : null, linhas: itens,
  };
}

/** Tipo do item elementar pelo prefixo do código. */
export function tipoDoElementar(codigo: string): TipoInsumo {
  const p = codigo.slice(0, 3);
  if (p === "MAT") return "material";
  if (p === "MOD") return "mao_de_obra";
  if (p.startsWith("EQ") || p === "IEQ") return "equipamento";
  if (p === "EVE") return "taxa";
  if (p === "RSE" || p === "SER") return "servico";
  return "material";
}

const arred4 = (v: number) => (Math.round(v * 10000) / 10000).toFixed(4);

export type Classificacao = { nivel: 1 | 2 | 3; codigo: string; nome: string; pai: string | null };

/**
 * Monta a carga no formato usado pelo gravador do SINAPI.
 * - MAT, MOD e equipamento entram como insumo, com o custo unitário publicado como preço do mês.
 * - EVE (percentual sobre a mão de obra) entra como insumo de taxa: o preço é o percentual e o
 *   coeficiente é a base em reais daquele mês, para coeficiente × preço = custo parcial publicado.
 * - RSE (outro item de serviço) entra como composição auxiliar quando o item está no catálogo do mês;
 *   se não estiver, como insumo de serviço com o custo publicado.
 */
export function montarCargaSco(composicoes: ComposicaoSco[], opcoes: { mes: string; regime: "desonerado" | "nao_desonerado"; origem?: string }): CargaSinapi {
  const carga: CargaSinapi = {
    uf: "RJ", mes: opcoes.mes, arquivos: [`SCO-Rio ${opcoes.mes.slice(5, 7)}/${opcoes.mes.slice(0, 4)}`],
    insumos: new Map(), composicoes: new Map(),
    precos: { desonerado: new Map(), nao_desonerado: new Map() }, custos: { desonerado: new Map(), nao_desonerado: new Map() },
    analitico: [], avisos: [], origem: opcoes.origem ?? SCO_BASE,
  };
  const servicos = new Set(composicoes.map((k) => k.codigo));
  const precosVistos = new Map<string, Map<string, number>>();
  const anotarPreco = (codigo: string, preco: string) => {
    const m = precosVistos.get(codigo) ?? new Map<string, number>();
    m.set(preco, (m.get(preco) ?? 0) + 1);
    precosVistos.set(codigo, m);
  };
  for (const k of composicoes) {
    carga.composicoes.set(k.codigo, { descricao: k.descricao, unidade: k.unidade || "UN", grupo: niveisDoCodigo(k.codigo)?.familia ?? null });
    if (k.custo != null) carga.custos[opcoes.regime].set(k.codigo, k.custo);
    for (const l of k.linhas) {
      if (Number(l.quantidade) <= 0) continue;
      if (l.reutilizado && servicos.has(l.reutilizado) && l.reutilizado !== k.codigo) {
        carga.analitico.push({ composicao: k.codigo, tipo: "composicao", item: l.reutilizado, coeficiente: l.quantidade });
        continue;
      }
      const tipo = tipoDoElementar(l.elementar);
      const descricao = l.reutilizado ? `${l.descricao} (item ${l.reutilizado})` : l.descricao;
      if (!carga.insumos.has(l.elementar)) carga.insumos.set(l.elementar, { descricao, unidade: l.unidade || "UN", tipo, grupo: l.elementar.slice(0, 3) });
      if (tipo === "taxa" && l.unidade.trim() === "%") {
        const base = Number(l.custoUnitario), parcial = Number(l.custoParcial);
        if (base <= 0) continue;
        anotarPreco(l.elementar, arred4(parcial / base / Number(l.quantidade)));
        carga.analitico.push({ composicao: k.codigo, tipo: "insumo", item: l.elementar, coeficiente: (base * Number(l.quantidade)).toFixed(7) });
      } else {
        anotarPreco(l.elementar, Number(l.custoUnitario).toFixed(4));
        carga.analitico.push({ composicao: k.codigo, tipo: "insumo", item: l.elementar, coeficiente: l.quantidade });
      }
    }
  }
  let divergentes = 0;
  for (const [codigo, m] of precosVistos) {
    const [preco] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (m.size > 1) divergentes++;
    carga.precos[opcoes.regime].set(codigo, { preco, origem: "SCO" });
  }
  if (divergentes) carga.avisos.push(`${divergentes} itens elementares aparecem com custos diferentes entre composições; foi usado o custo mais frequente.`);
  return carga;
}

/** Classificações de um conjunto de páginas de pesquisa (categoria > clã > família). */
export function classificacoesDe(categorias: { codigo: string; nome: string; clas: { codigo: string; nome: string; familias: { codigo: string; nome: string }[] }[] }[]): Classificacao[] {
  const r: Classificacao[] = [];
  for (const c of categorias) {
    r.push({ nivel: 1, codigo: c.codigo, nome: c.nome, pai: null });
    for (const k of c.clas) {
      const cla = `${c.codigo}${k.codigo.padStart(2, "0")}`;
      r.push({ nivel: 2, codigo: cla, nome: k.nome, pai: c.codigo });
      for (const f of k.familias) r.push({ nivel: 3, codigo: `${cla}.${f.codigo.padStart(2, "0")}`, nome: f.nome, pai: cla });
    }
  }
  return r;
}

/** "04 - Instalacoes Provisorias" → { codigo: "04", nome: "Instalacoes Provisorias" }. */
export function separarOpcao(texto: string): { codigo: string; nome: string } | null {
  const m = texto.match(/^([A-Z0-9]{1,3})\s*-\s*(.+)$/);
  return m ? { codigo: m[1], nome: m[2].trim() } : null;
}

type Consulta = { query: (sql: string, valores?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

/** Grava a hierarquia do SCO-Rio, liga cada serviço à sua família e classifica nos assuntos. */
export async function gravarClassificacoesSco(c: Consulta, lista: Classificacao[]) {
  await c.query("select set_config('app.carga_precos', 'sim', true)");
  for (const nivel of [1, 2, 3] as const) {
    const l = lista.filter((x) => x.nivel === nivel);
    if (!l.length) continue;
    await c.query(
      `insert into classificacao (fonte, nivel, codigo, nome, pai_id)
       select 'sco', $1, x.codigo, x.nome, (select id from classificacao p where p.fonte = 'sco' and p.codigo = x.pai)
         from unnest($2::text[], $3::text[], $4::text[]) as x(codigo, nome, pai)
       on conflict (fonte, codigo) do update set nome = excluded.nome, pai_id = excluded.pai_id`,
      [nivel, l.map((x) => x.codigo), l.map((x) => x.nome), l.map((x) => x.pai)],
    );
  }
  // Família pelo código do serviço (AL 04.05.0050 → AL04.05); sem família publicada, fica a categoria.
  await c.query(
    `update composicao k set classificacao_id = coalesce(
        (select id from classificacao f where f.fonte = 'sco' and f.codigo = substr(k.codigo, 1, 2) || substr(k.codigo, 4, 5)),
        (select id from classificacao f where f.fonte = 'sco' and f.codigo = substr(k.codigo, 1, 2) || substr(k.codigo, 4, 2)),
        (select id from classificacao f where f.fonte = 'sco' and f.codigo = substr(k.codigo, 1, 2)))
      where k.fonte = 'sco' and k.orgao_id is null`,
  );
  const r = await c.query("select classificar_assuntos('sco') as n");
  return Number(r.rows[0].n);
}
