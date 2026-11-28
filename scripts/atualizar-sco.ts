/**
 * Robô do SCO-Rio: lê a pesquisa pública da Prefeitura do Rio e carrega o catálogo do mês.
 *
 *   npm run atualizar-sco -- [--mes AAAA-MM] [--categorias AL,PT] [--cache pasta] [--sem-gravar]
 *
 * Variáveis: DATABASE_URL (conexão de administrador), SCO_MES, SCO_CATEGORIAS, SCO_CACHE,
 * SCO_PAUSA_MS (pausa entre acessos, padrão 400 ms) e SCO_SIMULTANEOS (padrão 3).
 *
 * O site não tem API: o robô percorre categoria > clã > família, as páginas de resultado
 * (50 itens por página) e a composição de cada item. Cada página fica guardada na pasta de cache,
 * então uma execução interrompida continua de onde parou. Antes de gravar, confere se a soma das
 * linhas de cada composição bate com o custo publicado.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { opcoesDeConexao } from "../src/lib/db";
import { gravarCargaSinapi } from "../src/servicos/importador-sinapi";
import {
  classificacoesDe, gravarClassificacoesSco, lerComposicao, lerLista, montarCargaSco, opcoesDoSelect, SCO_BASE, separarOpcao,
  type ComposicaoSco, type ItemDaLista,
} from "../src/servicos/importador-sco";
import { obterComEspera } from "./rede";

try { process.loadEnvFile(".env"); } catch {}

const args = process.argv.slice(2);
const opcao = (nome: string) => { const i = args.indexOf(nome); return i < 0 ? null : args[i + 1] ?? null; };
const PAUSA = Number(process.env.SCO_PAUSA_MS ?? 400);
const SIMULTANEOS = Math.max(1, Number(process.env.SCO_SIMULTANEOS ?? 3));
const CACHE = opcao("--cache") || process.env.SCO_CACHE || join(process.cwd(), ".cache-sco");
const SEM_GRAVAR = args.includes("--sem-gravar");
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CABECALHOS = { "User-Agent": "CiviObras/1.0 (catalogo de precos publicos)", Accept: "text/html" };

async function pagina(caminho: string, corpo?: URLSearchParams): Promise<string> {
  const chave = createHash("sha1").update(caminho + (corpo ? `|${corpo}` : "")).digest("hex");
  const arquivo = join(CACHE, `${chave}.html`);
  if (existsSync(arquivo)) return readFileSync(arquivo, "utf8");
  await dormir(PAUSA);
  const r = await obterComEspera(SCO_BASE + caminho, {
    method: corpo ? "POST" : "GET", body: corpo, tempo: 60_000,
    headers: { ...CABECALHOS, ...(corpo ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
  });
  if (!r.ok) throw new Error(`${caminho}: resposta ${r.status}`);
  const html = new TextDecoder("utf-8").decode(await r.arrayBuffer());
  writeFileSync(arquivo, html);
  return html;
}

async function emParalelo<T, R>(itens: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const r: R[] = new Array(itens.length);
  let proximo = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (proximo < itens.length) { const i = proximo++; r[i] = await f(itens[i], i); }
  }));
  return r;
}

async function principal() {
  mkdirSync(CACHE, { recursive: true });
  const inicial = await pagina("pesqservsco.cfm?atu=s");
  const meses = opcoesDoSelect(inicial, "fgv_ref").map((o) => o.texto).filter((t) => /^\d{2}\/\d{4}$/.test(t));
  const mesArg = opcao("--mes") || process.env.SCO_MES || null;
  const mesTxt = mesArg ? `${mesArg.slice(5, 7)}/${mesArg.slice(0, 4)}` : meses[0];
  if (!mesTxt || !meses.includes(mesTxt)) throw new Error(`Mês ${mesTxt ?? "?"} não está publicado no SCO-Rio. Publicados: ${meses.slice(0, 3).join(", ")}…`);
  const i0s = `${mesTxt.slice(3)}${mesTxt.slice(0, 2)}`;
  const mes = `${mesTxt.slice(3)}-${mesTxt.slice(0, 2)}-01`;

  const filtro = (opcao("--categorias") || process.env.SCO_CATEGORIAS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const categorias = opcoesDoSelect(inicial, "categoria").map((o) => separarOpcao(o.texto)).filter((x): x is { codigo: string; nome: string } => !!x)
    .filter((c) => !filtro.length || filtro.includes(c.codigo));
  console.log(`SCO-Rio ${mesTxt}: ${categorias.length} categorias.`);

  // Hierarquia: categoria > clã > família.
  const arvore = [];
  for (const cat of categorias) {
    const pc = await pagina(`pesqservsco.cfm?atu=s&cate=${cat.codigo}&i0s=${i0s}`);
    const clas = [];
    for (const o of opcoesDoSelect(pc, "cla")) {
      const cla = separarOpcao(o.texto);
      if (!cla) continue;
      const pf = await pagina(`pesqservsco.cfm?atu=s&cate=${cat.codigo}&cla=${o.valor || Number(cla.codigo)}&i0s=${i0s}`);
      const familias = opcoesDoSelect(pf, "familia").map((f) => separarOpcao(f.texto)).filter((x): x is { codigo: string; nome: string } => !!x);
      clas.push({ ...cla, familias });
    }
    arvore.push({ ...cat, clas });
  }
  const classificacoes = classificacoesDe(arvore);

  // Itens de serviço de cada categoria, página a página.
  const itens: ItemDaLista[] = [];
  for (const cat of categorias) {
    let n = 1, total = Infinity, lidos = 0;
    while (lidos < total) {
      const corpo = new URLSearchParams({
        pagina: String(n), fgv_ref: i0s, categoria: cat.codigo, cla: "", familia: "", coditem: "", fgvserv_descr: "",
        filtrodescr: "C", coditemsco: "", FGVParaSCO: "", RealizaPesqServ: "Pesquisar",
      });
      const l = lerLista(await pagina("resultservsco.cfm", corpo));
      if (!l.itens.length) break;
      itens.push(...l.itens);
      lidos += l.itens.length;
      total = l.total ?? lidos;
      n++;
    }
    console.log(`${cat.codigo} ${cat.nome}: ${lidos} itens.`);
  }
  const unicos = [...new Map(itens.map((i) => [i.codigo, i])).values()];

  // Composição de cada item.
  let feitos = 0, falhas = 0;
  const composicoes = (await emParalelo(unicos, SIMULTANEOS, async (it) => {
    const endereco = it.endereco ?? `composicaosco.cfm?item=1${it.codigo.replace(/[ .]/g, "").replace(/\((\w)\)$/, "$1").padEnd(11, "/")}${i0s}`;
    try {
      const k = lerComposicao(await pagina(endereco.replace(/^\/?sco\//, "")));
      if (++feitos % 250 === 0) console.log(`${feitos}/${unicos.length} composições lidas.`);
      if (!k) { falhas++; return null; }
      return { ...k, descricao: k.descricao || it.descricao, unidade: k.unidade || it.unidade, custo: k.custo ?? it.custo };
    } catch (e) {
      falhas++;
      console.log(`${it.codigo}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  })).filter((k): k is ComposicaoSco => !!k);
  console.log(`${composicoes.length} composições lidas, ${falhas} falhas.`);

  // Conferência: soma das linhas × custo publicado.
  const fora = composicoes.filter((k) => k.custo != null && k.linhas.length &&
    Math.abs(k.linhas.reduce((s, l) => s + Number(l.custoParcial), 0) - Number(k.custo)) > Math.max(0.05, Number(k.custo) * 0.01));
  console.log(`Conferência das páginas: ${composicoes.length - fora.length} somam o custo publicado, ${fora.length} não.`);
  for (const k of fora.slice(0, 10)) console.log(`  ${k.codigo}: publicado ${k.custo}, soma ${k.linhas.reduce((s, l) => s + Number(l.custoParcial), 0).toFixed(2)}`);

  // O SCO-Rio informa "(desonerado)" na descrição dos itens de mão de obra.
  const desonerado = composicoes.some((k) => k.linhas.some((l) => /desonerad/i.test(l.descricao)));
  const regime = desonerado ? "desonerado" : "nao_desonerado";
  const carga = montarCargaSco(composicoes, { mes, regime });
  console.log(`Carga: ${carga.insumos.size} itens elementares, ${carga.composicoes.size} serviços, ${carga.analitico.length} linhas, regime ${regime}.`);
  if (SEM_GRAVAR) { writeFileSync(join(CACHE, "carga.json"), JSON.stringify({ mes, regime, classificacoes, composicoes })); return; }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não configurada.");
  const c = new Client(opcoesDeConexao(url));
  await c.connect();
  try {
    await c.query("begin");
    const r = await gravarCargaSinapi(c as never, carga, "sco");
    const n = await gravarClassificacoesSco(c as never, classificacoes);
    await c.query("commit");
    for (const x of r) console.log(`Gravado: ${x.insumos} preços, ${x.composicoes} custos, ${x.conferidas} conferidas, ${x.divergentes} divergentes. Situação: ${x.situacao === "liberada" ? "liberada" : "em conferência"}.`);
    console.log(`${classificacoes.length} classificações; ${n} serviços classificados nos assuntos.`);
    for (const a of carga.avisos) console.log(`Aviso: ${a}`);
    if (r.some((x) => x.situacao !== "liberada")) process.exitCode = 1;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

principal().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
