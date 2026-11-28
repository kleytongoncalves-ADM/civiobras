/**
 * Carga mensal do SINAPI. Lê as planilhas oficiais da Caixa e grava insumos, preços,
 * composições e a estrutura analítica de uma UF, nos regimes desonerado e não desonerado.
 *
 * Formatos aceitos:
 *  - a partir de 2025: arquivo único "SINAPI_Referência_AAAA_MM.xlsx", com as abas ISD, ICD,
 *    CSD, CCD e Analítico, e uma coluna de preço por UF;
 *  - até 2024: arquivos por UF e por regime (Preco_Ref_Insumos, Custo_Ref_Composicoes_Sintetico
 *    e _Analitico), com "Desonerado" ou "NaoDesonerado" no nome.
 * A leitura é pelo nome das colunas, não pela posição, para resistir a pequenas mudanças de layout.
 */
import type { PoolClient } from "pg";
import { lerNumeroBr, texto, dec } from "../lib/decimal";
import type { Regime, TipoInsumo } from "./precos";

export type Celula = string | number | null | undefined;
export type Planilha = { arquivo: string; aba: string; linhas: Celula[][] };

export type CargaSinapi = {
  uf: string;
  mes: string; // AAAA-MM-01
  arquivos: string[];
  insumos: Map<string, { descricao: string; unidade: string; tipo: TipoInsumo; grupo: string | null }>;
  composicoes: Map<string, { descricao: string; unidade: string; grupo: string | null }>;
  precos: Record<Regime, Map<string, { preco: string; origem: string | null }>>;
  custos: Record<Regime, Map<string, string>>;
  analitico: { composicao: string; tipo: "insumo" | "composicao"; item: string; coeficiente: string }[];
  avisos: string[];
  /** Endereço de onde o arquivo foi baixado, quando veio pela carga automática. */
  origem?: string | null;
};

export const normalizar = (v: Celula) =>
  String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const codigoLimpo = (v: Celula) => {
  const t = String(v ?? "").trim().replace(/\.0+$/, "");
  return /^\d+$/.test(t) ? String(Number(t)) : t.toUpperCase();
};
const ehCodigo = (v: Celula) => /^\d{1,8}(\.0+)?$/.test(String(v ?? "").trim());

function numero(v: Celula): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? texto(dec(v), 7) : null;
  const t = String(v).replace(/R\$/g, "").trim();
  if (/^[-–]$/.test(t)) return null;
  const d = lerNumeroBr(t);
  return d == null ? null : texto(d, 7);
}

const MAO_DE_OBRA = /\b(pedreiro|servente|ajudante|carpinteiro|armador|eletricista|encanador|bombeiro hidraulico|pintor|operador|motorista|engenheiro|arquiteto|mestre de obras|encarregado|topografo|soldador|serralheiro|azulejista|ladrilhista|gesseiro|vidraceiro|marceneiro|montador|apontador|almoxarife|vigia|tecnico|calceteiro|impermeabilizador|jardineiro|desenhista|auxiliar|oficial|sondador|poceiro|cadista|laboratorista)\b/;
const EQUIPAMENTO = /\b(escavadeira|retroescavadeira|betoneira|caminhao|trator|rolo compactador|guindaste|guincho|compressor|vibrador|gerador|martelete|motoniveladora|pa carregadeira|bomba|serra circular|grupo gerador|usina|vibroacabadora|carro de mao|andaime|plataforma)\b/;

/** Tipo do insumo: pela classificação oficial, quando o arquivo traz, ou pela descrição e unidade. */
export function tipoDoInsumo(classificacao: Celula, descricao: string, unidade: string): TipoInsumo {
  const c = normalizar(classificacao);
  if (c) {
    if (c.includes("mao de obra")) return "mao_de_obra";
    if (c.includes("equipamento")) return "equipamento";
    if (c.includes("servico")) return "servico";
    if (c.includes("taxa") || c.includes("encargo")) return "taxa";
    return "material";
  }
  const d = normalizar(descricao), u = normalizar(unidade);
  if ((u === "h" || u === "mes") && MAO_DE_OBRA.test(d) && !d.includes("encargos complementares")) return "mao_de_obra";
  if ((u === "h" || u === "mes" || u === "chp" || u === "chi") && EQUIPAMENTO.test(d)) return "equipamento";
  return "material";
}

function regimeDe(arquivo: string, aba: string): Regime | "ignorar" | null {
  const a = normalizar(aba).replace(/\s/g, "");
  if (/^(isd|csd)$/.test(a)) return "nao_desonerado";
  if (/^(icd|ccd)$/.test(a)) return "desonerado";
  if (/^(ise|cse)$/.test(a)) return "ignorar"; // sem encargos sociais: não usado em orçamento
  const n = normalizar(arquivo).replace(/[\s_-]/g, "");
  if (/naodesonerad|semdesonera/.test(n)) return "nao_desonerado";
  if (/desonerad/.test(n)) return "desonerado";
  return null;
}

type Cabecalho = { linha: number; col: Record<string, number>; nomes: string[] };

/** Acha a linha de títulos: a primeira que tem "código" e "descrição". */
function acharCabecalho(linhas: Celula[][]): Cabecalho | null {
  for (let i = 0; i < Math.min(linhas.length, 40); i++) {
    const nomes = (linhas[i] ?? []).map(normalizar);
    if (nomes.some((n) => n.startsWith("codigo")) && nomes.some((n) => n.startsWith("descricao"))) {
      const col: Record<string, number> = {};
      nomes.forEach((n, j) => { if (n && col[n] == null) col[n] = j; });
      return { linha: i, col, nomes };
    }
  }
  return null;
}

const coluna = (c: Cabecalho, ...padroes: RegExp[]) => {
  for (const p of padroes) {
    const j = c.nomes.findIndex((n) => p.test(n));
    if (j >= 0) return j;
  }
  return -1;
};

/** Coluna de preço da UF: um título igual à sigla, na linha dos títulos ou nas vizinhas. */
function colunaDaUf(linhas: Celula[][], c: Cabecalho, uf: string): number {
  for (const d of [0, -1, -2, 1]) {
    const l = linhas[c.linha + d];
    if (!l) continue;
    const j = l.findIndex((v) => String(v ?? "").trim().toUpperCase() === uf);
    if (j >= 0) return j;
  }
  return -1;
}

export function mesDoArquivo(nome: string, linhas: Celula[][] = []): string | null {
  const n = /(20\d{2})[ _.-]?(0[1-9]|1[0-2])(?!\d)/.exec(nome);
  if (n) return `${n[1]}-${n[2]}-01`;
  for (const l of linhas.slice(0, 12)) {
    for (const v of l) {
      const m = /\b(0[1-9]|1[0-2])\/(20\d{2})\b/.exec(String(v ?? ""));
      if (m) return `${m[2]}-${m[1]}-01`;
    }
  }
  return null;
}

export function interpretarSinapi(planilhas: Planilha[], opcoes: { uf: string; mes?: string | null }): CargaSinapi {
  const uf = opcoes.uf.toUpperCase();
  const carga: CargaSinapi = {
    uf, mes: opcoes.mes ?? "", arquivos: [...new Set(planilhas.map((p) => p.arquivo))],
    insumos: new Map(), composicoes: new Map(),
    precos: { desonerado: new Map(), nao_desonerado: new Map() },
    custos: { desonerado: new Map(), nao_desonerado: new Map() },
    analitico: [], avisos: [],
  };
  const vistosAnalitico = new Set<string>();

  for (const p of planilhas) {
    if (!carga.mes) carga.mes = mesDoArquivo(p.arquivo, p.linhas) ?? "";
    const regime = regimeDe(p.arquivo, p.aba);
    if (regime === "ignorar") continue;
    const cab = acharCabecalho(p.linhas);
    if (!cab) continue;

    const cCoef = coluna(cab, /^coeficiente/);
    const cTipoItem = coluna(cab, /^tipo( de)? item/, /^tipo$/);
    const cCodItem = coluna(cab, /^codigo (do )?item/);
    const cCodComp = coluna(cab, /^codigo (da )?composicao/);
    const cCodInsumo = coluna(cab, /^codigo (do )?insumo/);
    const cCodigo = cCodComp >= 0 ? cCodComp : cCodInsumo >= 0 ? cCodInsumo : coluna(cab, /^codigo/);
    const cDesc = coluna(cab, /^descricao (da composicao|do insumo)/, /^descricao$/, /^descricao/);
    const cUn = coluna(cab, /^unidade( de medida)?$/, /^unidade/, /^und?$/);
    const cDescItem = coluna(cab, /^descricao (do )?item/);
    const cUnItem = coluna(cab, /^unidade (do )?item/);
    const cGrupo = coluna(cab, /^grupo/, /^descricao da classe/, /^classe/);
    const cClass = coluna(cab, /^classificacao/);
    const cOrigem = coluna(cab, /^origem de preco$/, /^origem/);
    let cPreco = colunaDaUf(p.linhas, cab, uf);
    const temUf = cPreco >= 0;
    if (cPreco < 0) cPreco = coluna(cab, /preco mediano/, /^custo total$/, /^custo/, /^preco/);
    // Sem preço coletado na UF, a Caixa calcula o custo da composição com o preço de São Paulo.
    const cPrecoSp = temUf && uf !== "SP" ? colunaDaUf(p.linhas, cab, "SP") : -1;

    const analitico = cCoef >= 0 && cCodItem >= 0;
    const ehComposicao = analitico || cCodComp >= 0 || /^c(sd|cd)$/i.test(p.aba.trim());

    for (let i = cab.linha + 1; i < p.linhas.length; i++) {
      const l = p.linhas[i] ?? [];
      if (!ehCodigo(l[cCodigo])) continue;
      const codigo = codigoLimpo(l[cCodigo]);
      const descricao = String(l[cDesc] ?? "").trim();
      const unidade = String(l[cUn] ?? "").trim();
      const grupo = cGrupo >= 0 ? String(l[cGrupo] ?? "").trim() || null : null;

      if (analitico) {
        const tipoItem = normalizar(cTipoItem >= 0 ? l[cTipoItem] : "");
        if (!ehCodigo(l[cCodItem]) || !tipoItem) {
          // Linha da própria composição (o formato novo abre cada composição com uma linha sem item).
          if (descricao && !carga.composicoes.has(codigo)) carga.composicoes.set(codigo, { descricao, unidade, grupo });
          continue;
        }
        if (descricao && !carga.composicoes.has(codigo)) carga.composicoes.set(codigo, { descricao, unidade, grupo });
        const item = codigoLimpo(l[cCodItem]);
        const coef = numero(l[cCoef]);
        if (!coef || dec(coef) <= 0n) continue;
        const tipo = tipoItem.startsWith("composi") ? "composicao" : "insumo";
        const descItem = cDescItem >= 0 ? String(l[cDescItem] ?? "").trim() : "";
        const unItem = cUnItem >= 0 ? String(l[cUnItem] ?? "").trim() : "";
        if (tipo === "insumo" && descItem && !carga.insumos.has(item))
          carga.insumos.set(item, { descricao: descItem, unidade: unItem, tipo: tipoDoInsumo(null, descItem, unItem), grupo: null });
        if (tipo === "composicao" && descItem && !carga.composicoes.has(item))
          carga.composicoes.set(item, { descricao: descItem, unidade: unItem, grupo: null });
        const chave = `${codigo}|${tipo}|${item}`;
        if (!vistosAnalitico.has(chave)) {
          vistosAnalitico.add(chave);
          carga.analitico.push({ composicao: codigo, tipo, item, coeficiente: coef });
        }
        // O analítico antigo traz o custo da composição em cada linha.
        if (regime && cPreco >= 0) {
          const custo = numero(l[cPreco]);
          if (custo != null && !carga.custos[regime].has(codigo)) carga.custos[regime].set(codigo, texto(dec(custo)));
        }
        continue;
      }

      if (!descricao) continue;
      if (ehComposicao) {
        carga.composicoes.set(codigo, { descricao, unidade, grupo });
        if (regime && cPreco >= 0) {
          const custo = numero(l[cPreco]);
          if (custo != null && dec(custo) > 0n) carga.custos[regime].set(codigo, texto(dec(custo)));
        }
      } else {
        carga.insumos.set(codigo, { descricao, unidade, tipo: tipoDoInsumo(cClass >= 0 ? l[cClass] : null, descricao, unidade), grupo });
        if (regime && cPreco >= 0) {
          const preco = numero(l[cPreco]);
          const origem = cOrigem >= 0 ? String(l[cOrigem] ?? "").trim() || null : null;
          if (preco != null && dec(preco) >= 0n) carga.precos[regime].set(codigo, { preco: texto(dec(preco)), origem });
          else if (cPrecoSp >= 0) {
            const sp = numero(l[cPrecoSp]);
            if (sp != null && dec(sp) >= 0n) carga.precos[regime].set(codigo, { preco: texto(dec(sp)), origem: "AS" });
          }
        }
      }
    }
  }

  if (!/^\d{4}-\d{2}-01$/.test(carga.mes)) throw new Error("Não foi possível identificar o mês de referência. Informe com --mes AAAA-MM.");
  if (carga.precos.desonerado.size + carga.precos.nao_desonerado.size === 0)
    throw new Error(`Nenhum preço de insumo encontrado para ${uf}. Confira se o arquivo é do SINAPI e se a UF está nele.`);
  for (const r of ["desonerado", "nao_desonerado"] as Regime[]) {
    if (carga.precos[r].size === 0) carga.avisos.push(`Sem preços no regime ${r === "desonerado" ? "desonerado" : "não desonerado"}.`);
  }
  return carga;
}

export type ResultadoCarga = {
  regime: Regime; tabelaId: string; situacao: "liberada" | "em_conferencia";
  insumos: number; composicoes: number; itens: number; conferidas: number; divergentes: number;
};

async function emLotes<T>(lista: T[], tamanho: number, fn: (lote: T[]) => Promise<unknown>) {
  for (let i = 0; i < lista.length; i += tamanho) await fn(lista.slice(i, i + tamanho));
}

/**
 * Grava a carga. Roda numa transação: ou entra tudo, ou nada.
 * Depois confere o custo de cada composição calculado pelo sistema contra o publicado.
 * Até 2% de composições divergentes (mais de 1% ou R$ 0,05 de diferença), a tabela é liberada.
 */
export async function gravarCargaSinapi(c: PoolClient, carga: CargaSinapi, fonte: "sinapi" | "sicro" | "sco" | "demonstracao" = "sinapi"): Promise<ResultadoCarga[]> {
  await c.query("select set_config('app.carga_precos', 'sim', true)");

  // No SICRO o coeficiente já leva o FIC, que muda de UF para UF. A estrutura é guardada por mês,
  // então só uma UF do SICRO por mês de referência.
  if (fonte === "sicro") {
    const outra = await c.query(
      "select uf from tabela_preco where orgao_id is null and fonte = 'sicro' and mes = $1 and uf <> $2 limit 1", [carga.mes, carga.uf]);
    if (outra.rowCount) throw new Error(`O SICRO de ${carga.mes.slice(5, 7)}/${carga.mes.slice(0, 4)} já está carregado para ${outra.rows[0].uf}. Só uma UF do SICRO por mês de referência.`);
  }

  const insumos = [...carga.insumos.entries()];
  await emLotes(insumos, 4000, (lote) => c.query(
    `insert into insumo (orgao_id, fonte, codigo, descricao, unidade, tipo, grupo)
     select null, $1, * from unnest($2::text[], $3::text[], $4::text[], $5::tipo_insumo[], $6::text[])
     on conflict (orgao_id, fonte, codigo) do update
       set descricao = excluded.descricao, unidade = excluded.unidade, tipo = excluded.tipo, grupo = coalesce(excluded.grupo, insumo.grupo)`,
    [fonte, lote.map(([k]) => k), lote.map(([, v]) => v.descricao), lote.map(([, v]) => v.unidade || "UN"), lote.map(([, v]) => v.tipo), lote.map(([, v]) => v.grupo)],
  ));
  const composicoes = [...carga.composicoes.entries()];
  await emLotes(composicoes, 4000, (lote) => c.query(
    `insert into composicao (orgao_id, fonte, codigo, descricao, unidade, grupo)
     select null, $1, * from unnest($2::text[], $3::text[], $4::text[], $5::text[])
     on conflict (orgao_id, fonte, codigo) do update
       set descricao = excluded.descricao, unidade = excluded.unidade, grupo = coalesce(excluded.grupo, composicao.grupo)`,
    [fonte, lote.map(([k]) => k), lote.map(([, v]) => v.descricao), lote.map(([, v]) => v.unidade || "UN"), lote.map(([, v]) => v.grupo)],
  ));

  const ids = async (tabela: "insumo" | "composicao") => {
    const r = await c.query(`select codigo, id from ${tabela} where orgao_id is null and fonte = $1`, [fonte]);
    return new Map<string, string>(r.rows.map((l) => [l.codigo, l.id]));
  };
  const idInsumo = await ids("insumo");
  const idComp = await ids("composicao");

  // Estrutura do mês: substitui a anterior do mesmo mês.
  let itens = 0;
  if (carga.analitico.length) {
    const comps = [...new Set(carga.analitico.map((a) => idComp.get(a.composicao)).filter(Boolean))] as string[];
    await emLotes(comps, 5000, (lote) => c.query("delete from composicao_item where mes = $1 and composicao_id = any($2::uuid[])", [carga.mes, lote]));
    const linhas = carga.analitico
      .map((a) => ({ comp: idComp.get(a.composicao), ins: a.tipo === "insumo" ? idInsumo.get(a.item) : null, sub: a.tipo === "composicao" ? idComp.get(a.item) : null, coef: a.coeficiente }))
      .filter((a) => a.comp && (a.ins || a.sub) && a.sub !== a.comp);
    const faltando = carga.analitico.length - linhas.length;
    if (faltando > 0) carga.avisos.push(`${faltando} linhas do analítico apontam para códigos que não estão no arquivo e foram ignoradas.`);
    await emLotes(linhas, 5000, (lote) => c.query(
      `insert into composicao_item (composicao_id, mes, insumo_id, subcomposicao_id, coeficiente)
       select comp, $1::date, ins, sub, coef from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::numeric[]) as x(comp, ins, sub, coef)`,
      [carga.mes, lote.map((l) => l.comp), lote.map((l) => l.ins), lote.map((l) => l.sub), lote.map((l) => l.coef)],
    ));
    itens = linhas.length;
  }

  const resultados: ResultadoCarga[] = [];
  for (const regime of ["nao_desonerado", "desonerado"] as Regime[]) {
    const precos = [...carga.precos[regime].entries()].filter(([k]) => idInsumo.has(k));
    if (!precos.length) continue;
    const t = await c.query(
      `insert into tabela_preco (orgao_id, fonte, uf, mes, regime, situacao, arquivo)
       values (null, $1, $2, $3, $4, 'em_conferencia', $5)
       on conflict (orgao_id, fonte, uf, mes, regime) do update set situacao = 'em_conferencia', arquivo = excluded.arquivo, carregada_em = now(), liberada_em = null
       returning id`,
      [fonte, carga.uf, carga.mes, regime, carga.arquivos.join(", ")],
    );
    const tabelaId = t.rows[0].id as string;
    await c.query("delete from preco_insumo where tabela_id = $1", [tabelaId]);
    await c.query("delete from custo_publicado where tabela_id = $1", [tabelaId]);
    await emLotes(precos, 5000, (lote) => c.query(
      `insert into preco_insumo (tabela_id, insumo_id, preco, origem)
       select $1, * from unnest($2::uuid[], $3::numeric[], $4::text[])`,
      [tabelaId, lote.map(([k]) => idInsumo.get(k)), lote.map(([, v]) => v.preco), lote.map(([, v]) => v.origem)],
    ));
    const custos = [...carga.custos[regime].entries()].filter(([k]) => idComp.has(k));
    await emLotes(custos, 5000, (lote) => c.query(
      `insert into custo_publicado (tabela_id, composicao_id, custo) select $1, * from unnest($2::uuid[], $3::numeric[])`,
      [tabelaId, lote.map(([k]) => idComp.get(k)), lote.map(([, v]) => v)],
    ));

    const conf = await c.query(
      `select count(*)::int as conferidas,
              (count(*) filter (where abs(x.total - p.custo) > greatest(0.05, 0.01 * p.custo)))::int as divergentes,
              coalesce(json_agg(json_build_object('codigo', k.codigo, 'publicado', p.custo, 'calculado', round(x.total, 2)))
                filter (where abs(x.total - p.custo) > greatest(0.05, 0.01 * p.custo)), '[]') as exemplos
         from custo_publicado p
         join composicao k on k.id = p.composicao_id
         cross join lateral (select material + mao_de_obra + equipamento as total, sem_preco, insumos from custo_composicao(p.composicao_id, p.tabela_id)) x
        where p.tabela_id = $1 and x.insumos > 0`,
      [tabelaId],
    );
    const { conferidas, divergentes } = conf.rows[0];
    const exemplos = (conf.rows[0].exemplos as unknown[]).slice(0, 20);
    // O SICRO publica o custo só sem desoneração. O regime desonerado usa a mesma estrutura e
    // segue o resultado da conferência do outro regime.
    const referencia = conferidas === 0 ? resultados.find((x) => x.conferidas > 0) : undefined;
    const libera = referencia ? referencia.situacao === "liberada" : conferidas === 0 || divergentes <= Math.floor(conferidas * 0.02);
    await c.query(
      `update tabela_preco set situacao = $2::situacao_carga, liberada_em = case when $2::text = 'liberada' then now() end, conferencia = $3 where id = $1`,
      [tabelaId, libera ? "liberada" : "em_conferencia", JSON.stringify({
        insumos: precos.length, composicoes: custos.length, itensAnalitico: itens, conferidas, divergentes, exemplos, avisos: carga.avisos,
        ...(referencia ? { conferidaPelo: referencia.regime } : {}), ...(carga.origem ? { origem: carga.origem } : {}),
      })],
    );
    resultados.push({ regime, tabelaId, situacao: libera ? "liberada" : "em_conferencia", insumos: precos.length, composicoes: custos.length, itens, conferidas, divergentes });
  }
  return resultados;
}
