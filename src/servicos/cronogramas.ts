import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { dec, div, lerNumeroBr, paraNumero, texto, ZERO } from "../lib/decimal";
import {
  calcularCpm, CicloNoCronograma, curvaS, datasDasAtividades, escreverPredecessoras, indicadoresPrazo, lerPredecessoras, periodos,
  type AtividadeCurva, type Calendario, type PredecessoraTexto, type TipoDependencia,
} from "./cpm";
import { rotuloContrato, type Regime } from "./contratos";
import type { Ator } from "./obras";
import { exigir, pode, SemPermissao } from "./permissoes";

const ctx = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
const uuid = (v: string | null | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

export type SituacaoCronograma = "rascunho" | "linha_base" | "substituido";
export const ROTULO_SITUACAO_CRONO: Record<SituacaoCronograma, string> = { rascunho: "Em elaboração", linha_base: "Linha de base", substituido: "Substituído" };

export type CabecalhoCronograma = {
  id: string; obraId: string; contratoId: string; contratoNumero: string; contratoRegime: Regime; contratoSituacao: string;
  versao: number; situacao: SituacaoCronograma; inicio: string; calendario: "corridos" | "uteis"; unidadePeriodo: "semana" | "mes";
  motivo: string | null; linhaBasePor: string | null; linhaBaseEm: Date | null; criadoEm: Date;
};

export type Atividade = {
  id: string; ordem: number; codigo: string; nome: string; duracao: number; itemServicoId: string | null; parcela: string;
  inicio: string | null; fim: string | null; folga: number | null; critica: boolean; origemId: string | null;
  itemNumero: string | null; itemDescricao: string | null; itemTotal: string | null;
  valor: string; peso: number; predecessoras: PredecessoraTexto[]; predecessorasTexto: string;
  avancos: { data: string; percentual: number; origem: string; justificativa: string | null; por: string | null }[];
  avancoAtual: number; previstoHoje: number; atrasada: boolean;
};

const COLUNAS = `c.id, c.obra_id as "obraId", c.contrato_id as "contratoId", k.numero as "contratoNumero", k.regime as "contratoRegime",
  k.situacao as "contratoSituacao", c.versao, c.situacao, to_char(c.inicio, 'YYYY-MM-DD') as inicio, c.calendario,
  c.unidade_periodo as "unidadePeriodo", c.motivo, u.nome as "linhaBasePor", c.linha_base_em as "linhaBaseEm", c.criado_em as "criadoEm"`;
const DE = `from cronograma c join contrato k on k.id = c.contrato_id left join usuario u on u.id = c.linha_base_por`;

function visivel(a: Ator, n: number) {
  if (pode(a, "obra.ver_todas")) return { sql: "true", params: [] as unknown[] };
  return {
    sql: `exists (select 1 from vinculo_obra v where v.obra_id = c.obra_id and v.usuario_id = $${n} and (v.fim is null or v.fim >= hoje_local()))`,
    params: [a.id],
  };
}

function exigirVer(a: Ator) {
  if (!pode(a, "cronograma.ver")) throw new SemPermissao();
}

async function cabecalho(c: PoolClient, a: Ator, id: string): Promise<CabecalhoCronograma> {
  if (!uuid(id)) throw new ErroDeRegra("Cronograma não encontrado.");
  const v = visivel(a, 2);
  const r = await c.query(`select ${COLUNAS} ${DE} where c.id = $1 and ${v.sql}`, [id, ...v.params]);
  if (!r.rows[0]) throw new ErroDeRegra("Cronograma não encontrado ou fora do seu acesso.");
  return r.rows[0];
}

async function emRascunho(c: PoolClient, a: Ator, id: string) {
  exigir(a, "cronograma.editar");
  const k = await cabecalho(c, a, id);
  if (k.situacao !== "rascunho") throw new ErroDeRegra("A linha de base não pode ser alterada. Crie uma nova versão do cronograma.");
  return k;
}

async function calendario(c: PoolClient, tipo: "corridos" | "uteis"): Promise<Calendario> {
  const r = await c.query("select to_char(data, 'YYYY-MM-DD') as d from feriado");
  return { tipo, feriados: new Set(r.rows.map((l) => l.d as string)) };
}

/** Recalcula datas, folgas e caminho crítico e grava em cada atividade. */
async function recalcular(c: PoolClient, cronogramaId: string) {
  const k = (await c.query("select to_char(inicio, 'YYYY-MM-DD') as inicio, calendario from cronograma where id = $1", [cronogramaId])).rows[0];
  const ats = (await c.query("select id, duracao from atividade where cronograma_id = $1", [cronogramaId])).rows;
  const deps = (await c.query(
    `select d.atividade_id as "atividadeId", d.predecessora_id as "predecessoraId", d.tipo, d.defasagem
       from dependencia d join atividade a on a.id = d.atividade_id where a.cronograma_id = $1`, [cronogramaId])).rows;
  let r;
  try {
    r = calcularCpm(ats, deps);
  } catch (e) {
    if (e instanceof CicloNoCronograma) throw new ErroDeRegra(e.message);
    throw e;
  }
  const datas = datasDasAtividades(r, k.inicio, await calendario(c, k.calendario));
  for (const [id, d] of datas.atividades) {
    await c.query("update atividade set inicio = $2, fim = $3, folga = $4, critica = $5 where id = $1", [id, d.inicio, d.fim, d.folga, d.critica]);
  }
}

// ---------------------------------------------------------------------------
// Criação a partir do contrato
// ---------------------------------------------------------------------------
export async function criarCronograma(a: Ator, contratoId: string, d: { inicio?: string | null; calendario?: "corridos" | "uteis"; unidadePeriodo?: "semana" | "mes" }): Promise<string> {
  exigir(a, "cronograma.editar");
  if (!uuid(contratoId)) throw new ErroDeRegra("Escolha o contrato.");
  return comContexto(ctx(a), async (c) => {
    const vis = pode(a, "obra.ver_todas") ? "true"
      : "exists (select 1 from vinculo_obra v where v.obra_id = k.obra_id and v.usuario_id = $2 and (v.fim is null or v.fim >= hoje_local()))";
    const k = (await c.query(
      `select k.id, k.obra_id, k.situacao, prazo_vigente(k.id) as prazo_execucao_dias, to_char(k.data_ordem_servico, 'YYYY-MM-DD') as os, k.valor_inicial::text
         from contrato k where k.id = $1 and ${vis}`, pode(a, "obra.ver_todas") ? [contratoId] : [contratoId, a.id])).rows[0];
    if (!k) throw new ErroDeRegra("Contrato não encontrado ou fora do seu acesso.");
    if (k.situacao === "encerrado" || k.situacao === "rescindido") throw new ErroDeRegra("Contrato encerrado.");
    if ((await c.query("select 1 from cronograma where contrato_id = $1", [contratoId])).rowCount) throw new ErroDeRegra("Este contrato já tem cronograma.");
    const inicio = d.inicio || k.os || hoje();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) throw new ErroDeRegra("Data de início inválida.");
    const cal = d.calendario === "corridos" ? "corridos" : "uteis";
    const id = (await c.query(
      "insert into cronograma (orgao_id, obra_id, contrato_id, versao, inicio, calendario, unidade_periodo) values ($1,$2,$3,1,$4,$5,$6) returning id",
      [a.orgaoId, k.obra_id, contratoId, inicio, cal, d.unidadePeriodo === "mes" ? "mes" : "semana"])).rows[0].id as string;

    // Uma atividade por item da planilha, em sequência, com duração proporcional ao valor dentro do prazo.
    const itens = (await c.query("select id, numero, descricao, total_vigente(id)::text as total from item_servico where contrato_id = $1 and item_vigente(id) order by ordem", [contratoId])).rows;
    const total = itens.reduce((s, i) => s + Number(i.total), 0);
    const prazoCorrido = k.prazo_execucao_dias ?? 30;
    const prazo = Math.max(itens.length, cal === "uteis" ? Math.round((prazoCorrido * 5) / 7) : prazoCorrido);
    const ids: string[] = [];
    let ordem = 0;
    const inserir = async (codigo: string, nome: string, duracao: number, itemId: string | null) => {
      ordem += 1;
      const r = await c.query(
        "insert into atividade (orgao_id, cronograma_id, ordem, codigo, nome, duracao, item_servico_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
        [a.orgaoId, id, ordem, codigo, nome, duracao, itemId]);
      return r.rows[0].id as string;
    };
    const inicioId = await inserir("M1", "Ordem de serviço", 0, null);
    let anterior = inicioId;
    for (const i of itens) {
      const dur = Math.max(1, Math.round(total ? (prazo * Number(i.total)) / total : prazo / itens.length));
      const novo = await inserir(i.numero, i.descricao, dur, i.id);
      await c.query("insert into dependencia (orgao_id, atividade_id, predecessora_id, tipo) values ($1,$2,$3,'TI')", [a.orgaoId, novo, anterior]);
      ids.push(novo);
      anterior = novo;
    }
    const fimId = await inserir("M2", "Conclusão da obra", 0, null);
    await c.query("insert into dependencia (orgao_id, atividade_id, predecessora_id, tipo) values ($1,$2,$3,'TI')", [a.orgaoId, fimId, anterior]);
    await recalcular(c, id);
    return id;
  });
}

// ---------------------------------------------------------------------------
// Edição (só em elaboração)
// ---------------------------------------------------------------------------
export async function salvarConfiguracao(a: Ator, id: string, d: { inicio: string; calendario: "corridos" | "uteis"; unidadePeriodo: "semana" | "mes" }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.inicio)) throw new ErroDeRegra("Data de início inválida.");
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, id);
    await c.query("update cronograma set inicio = $2, calendario = $3, unidade_periodo = $4 where id = $1",
      [id, d.inicio, d.calendario === "corridos" ? "corridos" : "uteis", d.unidadePeriodo === "mes" ? "mes" : "semana"]);
    await recalcular(c, id);
  });
}

export type DadosAtividade = { codigo: string; nome: string; duracao: string | number; predecessoras?: string; itemServicoId?: string | null; parcela?: string | null };

async function gravarPredecessoras(c: PoolClient, a: Ator, cronogramaId: string, atividadeId: string, codigo: string, t: string) {
  const lidas = lerPredecessoras(t ?? "");
  if (!lidas.ok) throw new ErroDeRegra(lidas.erro);
  await c.query("delete from dependencia where atividade_id = $1", [atividadeId]);
  for (const p of lidas.lista) {
    if (p.codigo === codigo) throw new ErroDeRegra("A atividade não pode depender dela mesma.");
    const pred = (await c.query("select id from atividade where cronograma_id = $1 and codigo = $2", [cronogramaId, p.codigo])).rows[0];
    if (!pred) throw new ErroDeRegra(`Predecessora ${p.codigo} não existe neste cronograma.`);
    await c.query(
      `insert into dependencia (orgao_id, atividade_id, predecessora_id, tipo, defasagem) values ($1,$2,$3,$4,$5)
       on conflict (atividade_id, predecessora_id) do update set tipo = excluded.tipo, defasagem = excluded.defasagem`,
      [a.orgaoId, atividadeId, pred.id, p.tipo, p.defasagem]);
  }
}

function validarAtividade(d: DadosAtividade) {
  const codigo = d.codigo.trim();
  if (!codigo || /\s|;|,/.test(codigo)) throw new ErroDeRegra("Código inválido. Use, por exemplo, 1.3 ou M3, sem espaços.");
  if (/(TI|II|TT|IT)$/i.test(codigo)) throw new ErroDeRegra("O código não pode terminar em TI, II, TT ou IT.");
  if (!d.nome.trim()) throw new ErroDeRegra("Informe o nome da atividade.");
  const duracao = Number(String(d.duracao).replace(",", "."));
  if (!Number.isInteger(duracao) || duracao < 0 || duracao > 3650) throw new ErroDeRegra("Duração inválida. Informe dias inteiros (0 para marco).");
  let parcela = "100";
  if (d.itemServicoId) {
    const p = lerNumeroBr(d.parcela || "100");
    if (p == null || p <= ZERO || p > dec(100)) throw new ErroDeRegra("A parcela do item deve ficar entre 0 e 100%.");
    parcela = texto(p, 4);
  }
  return { codigo, nome: d.nome.trim(), duracao, parcela };
}

export async function adicionarAtividade(a: Ator, cronogramaId: string, d: DadosAtividade): Promise<string> {
  const v = validarAtividade(d);
  return comContexto(ctx(a), async (c) => {
    const k = await emRascunho(c, a, cronogramaId);
    await validarItem(c, k.contratoId, d.itemServicoId);
    if ((await c.query("select 1 from atividade where cronograma_id = $1 and codigo = $2", [cronogramaId, v.codigo])).rowCount) {
      throw new ErroDeRegra(`Já existe a atividade ${v.codigo}.`);
    }
    const ordem = (await c.query("select coalesce(max(ordem), 0) + 1 as n from atividade where cronograma_id = $1", [cronogramaId])).rows[0].n;
    const id = (await c.query(
      "insert into atividade (orgao_id, cronograma_id, ordem, codigo, nome, duracao, item_servico_id, parcela) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
      [a.orgaoId, cronogramaId, ordem, v.codigo, v.nome, v.duracao, d.itemServicoId || null, v.parcela])).rows[0].id as string;
    await gravarPredecessoras(c, a, cronogramaId, id, v.codigo, d.predecessoras ?? "");
    await recalcular(c, cronogramaId);
    return id;
  });
}

async function validarItem(c: PoolClient, contratoId: string, itemId?: string | null) {
  if (!itemId) return;
  if (!uuid(itemId) || !(await c.query("select 1 from item_servico where id = $1 and contrato_id = $2 and item_vigente(id)", [itemId, contratoId])).rowCount) {
    throw new ErroDeRegra("Item de serviço não pertence a este contrato.");
  }
}

export async function editarAtividade(a: Ator, cronogramaId: string, atividadeId: string, d: DadosAtividade) {
  const v = validarAtividade(d);
  await comContexto(ctx(a), async (c) => {
    const k = await emRascunho(c, a, cronogramaId);
    await validarItem(c, k.contratoId, d.itemServicoId);
    const atual = (await c.query("select codigo from atividade where id = $1 and cronograma_id = $2", [atividadeId, cronogramaId])).rows[0];
    if (!atual) throw new ErroDeRegra("Atividade não encontrada.");
    if (atual.codigo !== v.codigo && (await c.query("select 1 from atividade where cronograma_id = $1 and codigo = $2", [cronogramaId, v.codigo])).rowCount) {
      throw new ErroDeRegra(`Já existe a atividade ${v.codigo}.`);
    }
    await c.query("update atividade set codigo = $2, nome = $3, duracao = $4, item_servico_id = $5, parcela = $6 where id = $1",
      [atividadeId, v.codigo, v.nome, v.duracao, d.itemServicoId || null, v.parcela]);
    await gravarPredecessoras(c, a, cronogramaId, atividadeId, v.codigo, d.predecessoras ?? "");
    await recalcular(c, cronogramaId);
  });
}

export async function removerAtividade(a: Ator, cronogramaId: string, atividadeId: string) {
  await comContexto(ctx(a), async (c) => {
    await emRascunho(c, a, cronogramaId);
    const r = await c.query("delete from atividade where id = $1 and cronograma_id = $2", [atividadeId, cronogramaId]);
    if (!r.rowCount) throw new ErroDeRegra("Atividade não encontrada.");
    await recalcular(c, cronogramaId);
  });
}

// ---------------------------------------------------------------------------
// Linha de base, versões e avanço
// ---------------------------------------------------------------------------
/** Pendências para gravar a linha de base: cada item da planilha precisa estar 100% distribuído nas atividades. */
async function pendencias(c: PoolClient, k: CabecalhoCronograma) {
  const p: string[] = [];
  if (k.contratoSituacao !== "vigente") p.push("O contrato ainda não foi assinado.");
  const r = await c.query(
    `select i.numero, coalesce(sum(a.parcela), 0)::numeric as soma
       from item_servico i left join atividade a on a.item_servico_id = i.id and a.cronograma_id = $2
      where i.contrato_id = $1 and item_vigente(i.id) group by i.numero, i.ordem order by i.ordem`, [k.contratoId, k.id]);
  const fora = r.rows.filter((l) => Number(l.soma) !== 100).map((l) => l.numero);
  if (fora.length) p.push(`Itens sem 100% distribuído nas atividades: ${fora.slice(0, 8).join(", ")}${fora.length > 8 ? "…" : ""}.`);
  if (!(await c.query("select 1 from atividade where cronograma_id = $1", [k.id])).rowCount) p.push("Nenhuma atividade.");
  return p;
}

export async function gravarLinhaBase(a: Ator, id: string) {
  exigir(a, "cronograma.linha_base");
  await comContexto(ctx(a), (c) => fixarLinhaBase(c, a, id));
}

/**
 * Ao assinar o contrato, o cronograma em elaboração vira a linha de base, se não tiver pendências.
 * Roda na transação da assinatura; com pendências, o cronograma continua em elaboração.
 */
export async function linhaBaseNaAssinatura(c: PoolClient, a: Ator, contratoId: string): Promise<"gravada" | "pendente" | "sem_cronograma"> {
  const r = (await c.query("select id from cronograma where contrato_id = $1 and situacao = 'rascunho' order by versao desc limit 1", [contratoId])).rows[0];
  if (!r) return "sem_cronograma";
  await c.query("savepoint linha_base");
  try {
    await fixarLinhaBase(c, a, r.id);
    return "gravada";
  } catch (e) {
    await c.query("rollback to savepoint linha_base");
    if (e instanceof ErroDeRegra) return "pendente";
    throw e;
  }
}

/** Aditivo assinado: abre uma nova versão do cronograma, em elaboração, para virar a nova linha de base. */
export async function versaoParaAditivo(c: PoolClient, contratoId: string, motivo: string): Promise<string | null> {
  const lb = (await c.query("select id from cronograma where contrato_id = $1 and situacao = 'linha_base'", [contratoId])).rows[0];
  if (!lb) return null;
  if ((await c.query("select 1 from cronograma where contrato_id = $1 and situacao = 'rascunho'", [contratoId])).rowCount) return null;
  return copiarVersao(c, lb.id, contratoId, motivo);
}

async function fixarLinhaBase(c: PoolClient, a: Ator, id: string) {
  {
    await c.query("select 1 from cronograma where id = $1 for update", [id]);
    const k = await cabecalho(c, a, id);
    if (k.situacao !== "rascunho") throw new ErroDeRegra("Este cronograma já é linha de base.");
    const p = await pendencias(c, k);
    if (p.length) throw new ErroDeRegra(`Resolva antes de gravar a linha de base: ${p.join(" ")}`);
    if (k.versao > 1 && !k.motivo) throw new ErroDeRegra("Informe o motivo da nova linha de base.");
    await recalcular(c, id);
    const anterior = (await c.query("select id from cronograma where contrato_id = $1 and situacao = 'linha_base'", [k.contratoId])).rows[0];
    if (anterior) await c.query("update cronograma set situacao = 'substituido' where id = $1", [anterior.id]);
    await c.query("update cronograma set situacao = 'linha_base', linha_base_por = $2, linha_base_em = now() where id = $1", [id, a.id]);
    // O avanço já registrado acompanha a atividade de origem na nova linha de base.
    if (anterior) {
      await c.query("select set_config('app.copiando_avanco', 'sim', true)");
      await c.query(
        `insert into avanco (orgao_id, atividade_id, data, percentual, origem, justificativa, criado_por, criado_em)
         select v.orgao_id, n.id, v.data, v.percentual, v.origem, v.justificativa, v.criado_por, v.criado_em
           from avanco v join atividade n on n.origem_id = v.atividade_id
          where n.cronograma_id = $1 order by v.data, v.criado_em`, [id]);
      await c.query("select set_config('app.copiando_avanco', '', true)");
    }
  }
}

export async function novaVersaoCronograma(a: Ator, id: string, motivo: string): Promise<string> {
  exigir(a, "cronograma.linha_base");
  if (!motivo.trim()) throw new ErroDeRegra("Informe o motivo da nova versão.");
  return comContexto(ctx(a), async (c) => {
    const k = await cabecalho(c, a, id);
    if (k.situacao !== "linha_base") throw new ErroDeRegra("Só a linha de base em vigor gera nova versão.");
    if ((await c.query("select 1 from cronograma where contrato_id = $1 and situacao = 'rascunho'", [k.contratoId])).rowCount) {
      throw new ErroDeRegra("Já existe uma versão em elaboração.");
    }
    return copiarVersao(c, id, k.contratoId, motivo.trim());
  });
}

async function copiarVersao(c: PoolClient, id: string, contratoId: string, motivo: string): Promise<string> {
  {
    const versao = (await c.query("select max(versao) + 1 as v from cronograma where contrato_id = $1", [contratoId])).rows[0].v;
    const novo = (await c.query(
      `insert into cronograma (orgao_id, obra_id, contrato_id, versao, versao_anterior_id, inicio, calendario, unidade_periodo, motivo)
       select orgao_id, obra_id, contrato_id, $2, id, inicio, calendario, unidade_periodo, $3 from cronograma where id = $1 returning id`,
      [id, versao, motivo])).rows[0].id as string;
    await c.query(
      `insert into atividade (orgao_id, cronograma_id, origem_id, ordem, codigo, nome, duracao, item_servico_id, parcela, inicio, fim, folga, critica)
       select orgao_id, $2, id, ordem, codigo, nome, duracao, item_servico_id, parcela, inicio, fim, folga, critica from atividade where cronograma_id = $1`,
      [id, novo]);
    await c.query(
      `insert into dependencia (orgao_id, atividade_id, predecessora_id, tipo, defasagem)
       select d.orgao_id, na.id, np.id, d.tipo, d.defasagem
         from dependencia d join atividade a on a.id = d.atividade_id
         join atividade na on na.origem_id = d.atividade_id and na.cronograma_id = $2
         join atividade np on np.origem_id = d.predecessora_id and np.cronograma_id = $2
        where a.cronograma_id = $1`, [id, novo]);
    return novo;
  }
}

export async function registrarAvanco(a: Ator, cronogramaId: string, atividadeId: string, d: { data: string; percentual: string; justificativa: string }) {
  exigir(a, "cronograma.avanco");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.data)) throw new ErroDeRegra("Data inválida.");
  const p = lerNumeroBr(d.percentual);
  if (p == null || p < ZERO || p > dec(100)) throw new ErroDeRegra("O avanço acumulado deve ficar entre 0 e 100%.");
  if (!d.justificativa.trim()) throw new ErroDeRegra("Informe a justificativa do avanço manual.");
  await comContexto(ctx(a), async (c) => {
    const k = await cabecalho(c, a, cronogramaId);
    if (k.situacao !== "linha_base") throw new ErroDeRegra("O avanço é registrado na linha de base em vigor.");
    if (!(await c.query("select 1 from atividade where id = $1 and cronograma_id = $2", [atividadeId, cronogramaId])).rowCount) {
      throw new ErroDeRegra("Atividade não encontrada.");
    }
    await c.query("insert into avanco (orgao_id, atividade_id, data, percentual, origem, justificativa) values ($1,$2,$3,$4,'manual',$5)",
      [a.orgaoId, atividadeId, d.data, texto(p, 4), d.justificativa.trim()]);
  });
}

// ---------------------------------------------------------------------------
// Leitura completa
// ---------------------------------------------------------------------------
export type CronogramaCompleto = CabecalhoCronograma & {
  atividades: Atividade[];
  termino: string; prazoDias: number; diasCorridos: number;
  curva: ReturnType<typeof curvaS>; indicadores: ReturnType<typeof indicadoresPrazo>;
  criticas: number; atrasadas: number; pendencias: string[];
  itensContrato: { id: string; numero: string; descricao: string; total: string; distribuido: number }[];
  hoje: string; fimContrato: string | null;
};

async function montar(c: PoolClient, k: CabecalhoCronograma): Promise<CronogramaCompleto> {
  const ats = (await c.query(
    `select a.id, a.ordem, a.codigo, a.nome, a.duracao, a.item_servico_id as "itemServicoId", a.parcela::text,
            to_char(a.inicio, 'YYYY-MM-DD') as inicio, to_char(a.fim, 'YYYY-MM-DD') as fim, a.folga, a.critica, a.origem_id as "origemId",
            i.numero as "itemNumero", i.descricao as "itemDescricao", total_vigente(i.id)::text as "itemTotal"
       from atividade a left join item_servico i on i.id = a.item_servico_id
      where a.cronograma_id = $1 order by a.inicio nulls last, a.ordem`, [k.id])).rows;
  const deps = (await c.query(
    `select d.atividade_id as "atividadeId", p.codigo, d.tipo, d.defasagem
       from dependencia d join atividade p on p.id = d.predecessora_id join atividade a on a.id = d.atividade_id
      where a.cronograma_id = $1 order by p.ordem`, [k.id])).rows as { atividadeId: string; codigo: string; tipo: TipoDependencia; defasagem: number }[];
  const avs = (await c.query(
    `select v.atividade_id as "atividadeId", to_char(v.data, 'YYYY-MM-DD') as data, v.percentual::float8 as percentual, v.origem, v.justificativa, u.nome as por
       from avanco v join atividade a on a.id = v.atividade_id left join usuario u on u.id = v.criado_por
      where a.cronograma_id = $1 order by v.data, v.criado_em`, [k.id])).rows;
  const itens = (await c.query(
    `select i.id, i.numero, i.descricao, total_vigente(i.id)::text as total,
            coalesce((select sum(a.parcela) from atividade a where a.item_servico_id = i.id and a.cronograma_id = $2), 0)::float8 as distribuido
       from item_servico i where i.contrato_id = $1 and item_vigente(i.id) order by i.ordem`, [k.contratoId, k.id])).rows;
  const fimContrato = (await c.query(
    "select to_char(data_ordem_servico + prazo_vigente(id) - 1, 'YYYY-MM-DD') as f from contrato where id = $1", [k.contratoId])).rows[0]?.f ?? null;
  const cal = await calendario(c, k.calendario);
  const hj = hoje();

  const valorDe = (a: { itemTotal: string | null; parcela: string }) => (a.itemTotal ? (dec(a.itemTotal) * dec(a.parcela)) / dec(100) : ZERO);
  const total = ats.reduce((s, a) => s + valorDe(a), ZERO);
  const curvaAts: AtividadeCurva[] = [];
  const atividades: Atividade[] = ats.map((a) => {
    const valor = valorDe(a);
    const minhas = avs.filter((v) => v.atividadeId === a.id);
    const ca: AtividadeCurva = { id: a.id, inicio: a.inicio ?? k.inicio, fim: a.fim ?? k.inicio, duracao: a.duracao, valor: Number(texto(valor, 6)), avancos: minhas };
    curvaAts.push(ca);
    const atual = minhas.reduce((m, v) => Math.max(m, v.percentual), 0);
    const ind = indicadoresPrazo([{ ...ca, valor: 100 }], cal, hj);
    const preds = deps.filter((d) => d.atividadeId === a.id).map((d) => ({ codigo: d.codigo, tipo: d.tipo, defasagem: d.defasagem }));
    return {
      ...a, valor: texto(valor), peso: total > ZERO ? paraNumero(div(valor * 100n, total)) : 0,
      predecessoras: preds, predecessorasTexto: escreverPredecessoras(preds),
      avancos: minhas.map(({ data, percentual, origem, justificativa, por }) => ({ data, percentual, origem, justificativa, por })),
      avancoAtual: atual, previstoHoje: ind.previstoPct,
      atrasada: k.situacao === "linha_base" && a.duracao > 0 && atual + 0.0001 < ind.previstoPct,
    };
  });
  const termino = atividades.reduce((m, a) => (a.fim && a.fim > m ? a.fim : m), k.inicio);
  const lista = periodos(k.inicio, termino, k.unidadePeriodo);
  const relogio = datasDasAtividades({ prazo: 0, atividades: new Map() }, k.inicio, cal).relogio;
  const prazoDias = atividades.length ? relogio.indice(termino) + 1 : 0;
  return {
    ...k, atividades, termino, prazoDias,
    diasCorridos: Math.round((Date.parse(`${termino}T00:00:00Z`) - Date.parse(`${k.inicio}T00:00:00Z`)) / 86_400_000) + 1,
    curva: curvaS(curvaAts, lista, cal, k.situacao === "linha_base" ? hj : "0000-00-00"),
    indicadores: indicadoresPrazo(curvaAts, cal, hj),
    criticas: atividades.filter((a) => a.critica).length,
    atrasadas: atividades.filter((a) => a.atrasada).length,
    pendencias: k.situacao === "rascunho" ? await pendencias(c, k) : [],
    itensContrato: itens, hoje: hj, fimContrato,
  };
}

export async function obterCronograma(a: Ator, id: string): Promise<CronogramaCompleto> {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => montar(c, await cabecalho(c, a, id)));
}

/** Cronogramas da obra (todas as versões) e contratos que ainda não têm cronograma. */
export async function cronogramasDaObra(a: Ator, obraId: string) {
  exigirVer(a);
  return comContexto(ctx(a), async (c) => {
    const v = visivel(a, 2);
    const lista = (await c.query(`select ${COLUNAS} ${DE} where c.obra_id = $1 and ${v.sql} order by c.versao desc`, [obraId, ...v.params])).rows as CabecalhoCronograma[];
    const sem = pode(a, "contrato.ver") || pode(a, "cronograma.editar")
      ? (await c.query(
          `select k.id, k.numero, k.regime, k.situacao from contrato k
            where k.obra_id = $1 and k.situacao in ('rascunho', 'vigente') and not exists (select 1 from cronograma c where c.contrato_id = k.id)
            order by k.numero`, [obraId])).rows.map((k) => ({ ...k, rotulo: rotuloContrato(k) }))
      : [];
    return { lista, semCronograma: sem as { id: string; numero: string; regime: Regime; situacao: string; rotulo: string }[] };
  });
}

/** Painel geral: cronograma em vigor de cada obra visível, com avanço e IDP. */
export async function panoramaCronogramas(a: Ator) {
  exigirVer(a);
  const ids = await comContexto(ctx(a), async (c) => {
    const v = visivel(a, 1);
    return (await c.query(
      `select distinct on (c.contrato_id) c.id from cronograma c where ${v.sql}
        order by c.contrato_id, (c.situacao = 'linha_base') desc, (c.situacao = 'rascunho') desc, c.versao desc`, v.params)).rows.map((l) => l.id as string);
  });
  const lista: CronogramaCompleto[] = [];
  for (const id of ids) lista.push(await obterCronograma(a, id));
  const obras = await comContexto(ctx(a), async (c) => (await c.query(
    "select id, codigo, nome, situacao from obra where id = any($1::uuid[])", [lista.map((l) => l.obraId)])).rows);
  const porId = new Map(obras.map((o) => [o.id, o]));
  return lista.map((l) => ({ ...l, obra: porId.get(l.obraId) as { id: string; codigo: string; nome: string; situacao: string } }));
}
