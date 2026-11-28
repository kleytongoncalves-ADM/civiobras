import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { armazenamento, armazenamentoObrigatorio, caminhoDoArquivo, extensaoDoMime } from "../lib/armazenamento";
import { comContexto, ErroDeRegra, type Contexto } from "../lib/db";
import { diaDeTrabalho, diasEntre, somarDias, type Calendario } from "./cpm";
import type { Ator } from "./obras";
import { exigir, pode, SemPermissao, type Acao } from "./permissoes";
import type { Situacao } from "./rotulos";

export const ctxCampo = (a: Ator): Contexto => ({ usuarioId: a.id, orgaoId: a.orgaoId });
export const uuid = (v: string | null | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);
export const dataValida = (v: string | null | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const limpo = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
export const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

export type ObraCampo = { id: string; codigo: string; nome: string; situacao: Situacao; inicio: string | null; latitude: number | null; longitude: number | null };
export const OBRA_EM_CAMPO: Situacao[] = ["em_execucao", "paralisada", "concluida"];

/** Início da obra: primeira ordem de serviço de contrato, a ordem de serviço da obra ou o primeiro diário. */
export const inicioDaObraSql = (o: string) =>
  `to_char(coalesce((select min(k.data_ordem_servico) from contrato k where k.obra_id = ${o}.id and k.situacao <> 'rascunho'),
                    ${o}.ordem_servico_data, (select min(d.data) from diario d where d.obra_id = ${o}.id)), 'YYYY-MM-DD')`;

/**
 * Dias sem acidente: desde o último acidente registrado na obra; sem nenhum, desde o início da obra.
 * Obra sem data de início (ou que ainda não começou) fica sem contagem.
 */
export function diasSemAcidente(ultimoAcidente: string | null, inicio: string | null, h = hoje()): number | null {
  const desde = ultimoAcidente ?? inicio;
  return desde && desde <= h ? diasEntre(desde, h) : null;
}

/** Obra no acesso do usuário. Direção vê todas; os demais, as obras a que estão vinculados. */
export async function obraNoAcesso(c: PoolClient, a: Ator, obraId: string): Promise<ObraCampo> {
  if (!uuid(obraId)) throw new ErroDeRegra("Obra não encontrada.");
  const todas = pode(a, "obra.ver_todas");
  const r = await c.query(
    `select o.id, o.codigo, o.nome, o.situacao, o.latitude::float8 as latitude, o.longitude::float8 as longitude,
            ${inicioDaObraSql("o")} as inicio
       from obra o
      where o.id = $1 and (${todas ? "true" : "exists (select 1 from vinculo_obra v where v.obra_id = o.id and v.usuario_id = $2 and (v.fim is null or v.fim >= hoje_local()))"})`,
    todas ? [obraId] : [obraId, a.id]);
  if (!r.rows[0]) throw new ErroDeRegra("Obra não encontrada ou fora do seu acesso.");
  return r.rows[0];
}

/** Filtro SQL de obras visíveis (alias da coluna obra_id). */
export function obrasVisiveis(a: Ator, coluna: string, n: number) {
  if (pode(a, "obra.ver_todas")) return { sql: "true", params: [] as unknown[] };
  return {
    sql: `exists (select 1 from vinculo_obra v where v.obra_id = ${coluna} and v.usuario_id = $${n} and (v.fim is null or v.fim >= hoje_local()))`,
    params: [a.id] as unknown[],
  };
}

export function exigirVer(a: Ator, acao: Acao) {
  if (!pode(a, acao)) throw new SemPermissao();
}

async function feriados(c: PoolClient): Promise<Calendario> {
  const r = await c.query("select to_char(data, 'YYYY-MM-DD') as d from feriado");
  return { tipo: "uteis", feriados: new Set(r.rows.map((l) => l.d as string)) };
}

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------
export type Clima = "bom" | "nublado" | "chuva_fraca" | "chuva_forte";
export type Condicao = "praticavel" | "parcial" | "impraticavel";
export type Motivo = "chuva" | "falta_frente" | "falta_material" | "falta_mao_de_obra" | "embargo" | "pagamento" | "seguranca" | "outro";
export type TipoOcorrenciaDiario = "ocorrencia" | "visita" | "paralisacao";

export const ROTULO_CLIMA: Record<Clima, string> = { bom: "Bom", nublado: "Nublado", chuva_fraca: "Chuva fraca", chuva_forte: "Chuva forte" };
export const ROTULO_CONDICAO: Record<Condicao, string> = { praticavel: "Praticável", parcial: "Parcialmente praticável", impraticavel: "Impraticável" };
export const ROTULO_MOTIVO: Record<Motivo, string> = {
  chuva: "Chuva", falta_frente: "Falta de frente", falta_material: "Falta de material", falta_mao_de_obra: "Falta de mão de obra",
  embargo: "Embargo", pagamento: "Atraso de pagamento", seguranca: "Segurança", outro: "Outro",
};
export const ROTULO_OCORRENCIA_DIARIO: Record<TipoOcorrenciaDiario, string> = { ocorrencia: "Ocorrência", visita: "Visita", paralisacao: "Paralisação" };
export const CLIMAS = Object.keys(ROTULO_CLIMA) as Clima[];
export const CONDICOES = Object.keys(ROTULO_CONDICAO) as Condicao[];
export const MOTIVOS = Object.keys(ROTULO_MOTIVO) as Motivo[];
export const FUNCOES_SUGERIDAS = ["Engenheiro", "Mestre de obras", "Encarregado", "Pedreiro", "Servente", "Carpinteiro", "Armador", "Eletricista", "Encanador", "Pintor", "Operador de máquina", "Motorista", "Técnico de segurança", "Topógrafo"];

// ---------------------------------------------------------------------------
// Calendário do diário
// ---------------------------------------------------------------------------
export type DiaDiario = { data: string; id: string; numero: number; situacao: "rascunho" | "assinado"; visto: boolean; efetivo: number; horasParadas: number; chuva: boolean };
export type ResumoDiarios = {
  obra: ObraCampo; mes: string; dias: DiaDiario[]; pendentes: string[]; totalPendentes: number;
  hoje: string; diarioDeHoje: { id: string; situacao: string } | null; semVisto: number;
  paradas: { motivo: Motivo; horas: number; dias: number }[]; diasChuva: number; podeLancar: boolean;
};

/** Dias úteis sem diário desde o início da obra até ontem (obra em execução). */
async function diasPendentes(c: PoolClient, obra: ObraCampo): Promise<string[]> {
  if (obra.situacao !== "em_execucao" || !obra.inicio) return [];
  const feitos = new Set((await c.query("select to_char(data, 'YYYY-MM-DD') as d from diario where obra_id = $1", [obra.id])).rows.map((r) => r.d as string));
  const cal = await feriados(c);
  const ontem = somarDias(hoje(), -1);
  const pend: string[] = [];
  for (let d = obra.inicio; d <= ontem; d = somarDias(d, 1)) {
    if (diaDeTrabalho(d, cal) && !feitos.has(d)) pend.push(d);
  }
  return pend;
}

export async function resumoDiarios(a: Ator, obraId: string, mes?: string): Promise<ResumoDiarios> {
  exigirVer(a, "diario.ver");
  return comContexto(ctxCampo(a), async (c) => {
    const obra = await obraNoAcesso(c, a, obraId);
    const m = mes && /^\d{4}-\d{2}$/.test(mes) ? mes : hoje().slice(0, 7);
    const dias = (await c.query(
      `select to_char(d.data, 'YYYY-MM-DD') as data, d.id, d.numero, d.situacao, d.visto_em is not null as visto,
              coalesce((select sum(quantidade) from diario_efetivo where diario_id = d.id), 0)::int as efetivo,
              coalesce((select sum(horas) from diario_ocorrencia where diario_id = d.id and tipo = 'paralisacao'), 0)::float8 as "horasParadas",
              (d.clima_manha in ('chuva_fraca', 'chuva_forte') or d.clima_tarde in ('chuva_fraca', 'chuva_forte')) as chuva
         from diario d where d.obra_id = $1 and to_char(d.data, 'YYYY-MM') = $2 order by d.data`, [obraId, m])).rows as DiaDiario[];
    const pendentes = await diasPendentes(c, obra);
    const hj = (await c.query("select id, situacao from diario where obra_id = $1 and data = $2", [obraId, hoje()])).rows[0] ?? null;
    const semVisto = (await c.query("select count(*)::int as n from diario where obra_id = $1 and situacao = 'assinado' and visto_em is null", [obraId])).rows[0].n;
    const paradas = (await c.query(
      `select o.motivo, sum(o.horas)::float8 as horas, count(distinct o.diario_id)::int as dias
         from diario_ocorrencia o join diario d on d.id = o.diario_id
        where d.obra_id = $1 and o.tipo = 'paralisacao' group by o.motivo order by 2 desc`, [obraId])).rows;
    const diasChuva = (await c.query(
      `select count(*)::int as n from diario where obra_id = $1 and (clima_manha in ('chuva_fraca', 'chuva_forte') or clima_tarde in ('chuva_fraca', 'chuva_forte'))`, [obraId])).rows[0].n;
    return {
      obra, mes: m, dias, pendentes: pendentes.filter((d) => d.startsWith(m)), totalPendentes: pendentes.length, hoje: hoje(), diarioDeHoje: hj,
      semVisto, paradas, diasChuva, podeLancar: pode(a, "diario.lancar") && OBRA_EM_CAMPO.includes(obra.situacao),
    };
  });
}

/** Painel do módulo: obras em campo com o diário de hoje e as pendências. */
export async function painelDiarios(a: Ator) {
  exigirVer(a, "diario.ver");
  return comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "o.id", 1);
    const obras = (await c.query(
      `select o.id from obra o where o.situacao in ('em_execucao', 'paralisada') and ${v.sql} order by o.codigo`, v.params)).rows;
    const linhas = [];
    for (const { id } of obras) {
      const obra = await obraNoAcesso(c, a, id);
      const ultimo = (await c.query(
        `select id, numero, to_char(data, 'YYYY-MM-DD') as data, situacao from diario where obra_id = $1 order by data desc limit 1`, [id])).rows[0] ?? null;
      const hj = (await c.query("select id, situacao from diario where obra_id = $1 and data = $2", [id, hoje()])).rows[0] ?? null;
      const semVisto = (await c.query("select count(*)::int as n from diario where obra_id = $1 and situacao = 'assinado' and visto_em is null", [id])).rows[0].n;
      const pend = await diasPendentes(c, obra);
      linhas.push({ obra, ultimo, hoje: hj, semVisto, pendentes: pend.length, ultimaPendente: pend.at(-1) ?? null });
    }
    return { linhas, hoje: hoje(), podeLancar: pode(a, "diario.lancar") };
  });
}

// ---------------------------------------------------------------------------
// Diário do dia
// ---------------------------------------------------------------------------
export type Efetivo = { id: string; funcao: string; empresa: string | null; quantidade: number };
export type Equipamento = { id: string; descricao: string; quantidade: number; horas: number | null };
export type ServicoDiario = { id: string; atividadeId: string | null; atividadeCodigo: string | null; atividadeNome: string | null; descricao: string; local: string | null; avancoPct: number | null };
export type OcorrenciaDiario = { id: string; tipo: TipoOcorrenciaDiario; motivo: Motivo | null; horas: number | null; descricao: string; ocorrenciaSegurancaId: string | null };
export type Complemento = { id: string; texto: string; por: string | null; em: Date };
export type FotoResumo = { id: string; legenda: string | null; tiradaEm: Date | null; latitude: number | null; longitude: number | null; largura: number; altura: number; momento: "antes" | "depois" | null; por: string | null; criadoEm: Date };

export type Diario = {
  id: string; obra: ObraCampo; numero: number; data: string; climaManha: Clima; climaTarde: Clima; condicao: Condicao; relato: string | null;
  situacao: "rascunho" | "assinado"; assinadoPor: string | null; assinadoEm: Date | null; vistoPor: string | null; vistoEm: Date | null; vistoObservacao: string | null;
  criadoPor: string | null; criadoEm: Date;
  efetivo: Efetivo[]; equipamentos: Equipamento[]; servicos: ServicoDiario[]; ocorrencias: OcorrenciaDiario[]; complementos: Complemento[]; fotos: FotoResumo[];
  totalEfetivo: number; horasParadas: number;
  atividades: { id: string; codigo: string; nome: string; avanco: number; previsto: string | null }[];
  anterior: string | null; proximo: string | null; alocados: number;
  podeEditar: boolean; podeAssinar: boolean; podeVisto: boolean; podeComplementar: boolean; assinadoPorMim: boolean;
};

export const COLUNAS_FOTO = `f.id, f.legenda, f.tirada_em as "tiradaEm", f.latitude::float8 as latitude, f.longitude::float8 as longitude, f.largura, f.altura,
  f.momento, u.nome as por, f.criado_em as "criadoEm"`;

export async function lerDiario(c: PoolClient, a: Ator, id: string): Promise<Diario> {
  if (!uuid(id)) throw new ErroDeRegra("Diário não encontrado.");
  const d = (await c.query(
    `select d.id, d.obra_id, d.numero, to_char(d.data, 'YYYY-MM-DD') as data, d.clima_manha as "climaManha", d.clima_tarde as "climaTarde", d.condicao, d.relato,
            d.situacao, ua.nome as "assinadoPor", d.assinado_por, d.assinado_em as "assinadoEm", uv.nome as "vistoPor", d.visto_em as "vistoEm",
            d.visto_observacao as "vistoObservacao", uc.nome as "criadoPor", d.criado_em as "criadoEm"
       from diario d left join usuario ua on ua.id = d.assinado_por left join usuario uv on uv.id = d.visto_por left join usuario uc on uc.id = d.criado_por
      where d.id = $1`, [id])).rows[0];
  if (!d) throw new ErroDeRegra("Diário não encontrado.");
  const obra = await obraNoAcesso(c, a, d.obra_id);
  const efetivo = (await c.query("select id, funcao, empresa, quantidade from diario_efetivo where diario_id = $1 order by empresa nulls first, funcao", [id])).rows;
  const equipamentos = (await c.query("select id, descricao, quantidade, horas::float8 as horas from diario_equipamento where diario_id = $1 order by descricao", [id])).rows;
  const servicos = (await c.query(
    `select s.id, s.atividade_id as "atividadeId", a.codigo as "atividadeCodigo", a.nome as "atividadeNome", s.descricao, s.local, s.avanco_pct::float8 as "avancoPct"
       from diario_servico s left join atividade a on a.id = s.atividade_id where s.diario_id = $1 order by a.ordem nulls last, s.descricao`, [id])).rows;
  const ocorrencias = (await c.query(
    `select id, tipo, motivo, horas::float8 as horas, descricao, ocorrencia_seguranca_id as "ocorrenciaSegurancaId"
       from diario_ocorrencia where diario_id = $1 order by case tipo when 'paralisacao' then 0 when 'ocorrencia' then 1 else 2 end, id`, [id])).rows;
  const complementos = (await c.query(
    "select x.id, x.texto, u.nome as por, x.criado_em as em from diario_complemento x left join usuario u on u.id = x.criado_por where x.diario_id = $1 order by x.criado_em", [id])).rows;
  const fotos = (await c.query(`select ${COLUNAS_FOTO} from foto f left join usuario u on u.id = f.criado_por where f.diario_id = $1 order by f.tirada_em nulls last, f.criado_em`, [id])).rows;
  const atividades = (await c.query(
    `select a.id, a.codigo, a.nome, to_char(a.inicio, 'YYYY-MM-DD') as previsto,
            coalesce((select percentual from avanco v where v.atividade_id = a.id and v.data <= $2 order by v.data desc, v.criado_em desc limit 1), 0)::float8 as avanco
       from atividade a join cronograma c on c.id = a.cronograma_id
      where c.obra_id = $1 and c.situacao = 'linha_base' and a.duracao > 0
        and not exists (select 1 from atividade f where f.cronograma_id = a.cronograma_id and f.codigo like a.codigo || '.%')
      order by a.ordem`, [d.obra_id, d.data])).rows;
  const viz = (await c.query(
    `select (select id from diario where obra_id = $1 and data < $2 order by data desc limit 1) as anterior,
            (select id from diario where obra_id = $1 and data > $2 order by data limit 1) as proximo,
            (select count(*)::int from alocacao_pessoa x where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2)
              + (select count(*)::int from alocacao_equipamento x where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2) as alocados`,
    [d.obra_id, d.data])).rows[0];
  const rascunho = d.situacao === "rascunho";
  return {
    id: d.id, obra, numero: d.numero, data: d.data, climaManha: d.climaManha, climaTarde: d.climaTarde, condicao: d.condicao, relato: d.relato,
    situacao: d.situacao, assinadoPor: d.assinadoPor, assinadoEm: d.assinadoEm, vistoPor: d.vistoPor, vistoEm: d.vistoEm, vistoObservacao: d.vistoObservacao,
    criadoPor: d.criadoPor, criadoEm: d.criadoEm, efetivo, equipamentos, servicos, ocorrencias, complementos, fotos,
    totalEfetivo: efetivo.reduce((s: number, e: Efetivo) => s + e.quantidade, 0),
    horasParadas: ocorrencias.filter((o: OcorrenciaDiario) => o.tipo === "paralisacao").reduce((s: number, o: OcorrenciaDiario) => s + (o.horas ?? 0), 0),
    atividades, anterior: viz.anterior, proximo: viz.proximo, alocados: viz.alocados,
    podeEditar: rascunho && pode(a, "diario.lancar"),
    podeAssinar: rascunho && pode(a, "diario.assinar"),
    podeVisto: !rascunho && !d.vistoEm && pode(a, "diario.visto") && d.assinado_por !== a.id,
    podeComplementar: !rascunho && (pode(a, "diario.lancar") || pode(a, "diario.visto")),
    assinadoPorMim: d.assinado_por === a.id,
  };
}

export async function obterDiario(a: Ator, id: string): Promise<Diario> {
  exigirVer(a, "diario.ver");
  return comContexto(ctxCampo(a), (c) => lerDiario(c, a, id));
}

/** Abre o diário da data (ou devolve o que já existe). */
export async function abrirDiario(a: Ator, obraId: string, data: string): Promise<string> {
  exigir(a, "diario.lancar");
  if (!dataValida(data)) throw new ErroDeRegra("Informe a data do diário.");
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    const ja = (await c.query("select id from diario where obra_id = $1 and data = $2", [obraId, data])).rows[0];
    if (ja) return ja.id as string;
    // Clima e condição do diário anterior como ponto de partida.
    return (await c.query(
      "insert into diario (orgao_id, obra_id, data) values ($1, $2, $3) returning id", [a.orgaoId, obraId, data])).rows[0].id as string;
  });
}

async function emRascunho(c: PoolClient, a: Ator, id: string) {
  exigir(a, "diario.lancar");
  const d = await lerDiario(c, a, id);
  if (d.situacao !== "rascunho") throw new ErroDeRegra("Diário assinado não se altera. Registre um complemento.");
  return d;
}

export async function salvarDiario(a: Ator, id: string, x: { climaManha: string; climaTarde: string; condicao: string; relato: string | null }) {
  if (!CLIMAS.includes(x.climaManha as Clima) || !CLIMAS.includes(x.climaTarde as Clima)) throw new ErroDeRegra("Informe o clima.");
  if (!CONDICOES.includes(x.condicao as Condicao)) throw new ErroDeRegra("Informe a condição de trabalho.");
  await comContexto(ctxCampo(a), async (c) => {
    await emRascunho(c, a, id);
    await c.query("update diario set clima_manha = $2, clima_tarde = $3, condicao = $4, relato = $5 where id = $1",
      [id, x.climaManha, x.climaTarde, x.condicao, limpo(x.relato)]);
  });
}

export type LinhaDiario =
  | { tipo: "efetivo"; funcao: string; empresa?: string | null; quantidade: number }
  | { tipo: "equipamento"; descricao: string; quantidade: number; horas?: number | null }
  | { tipo: "servico"; descricao: string; local?: string | null; atividadeId?: string | null; avancoPct?: number | null }
  | { tipo: "ocorrencia"; subtipo: TipoOcorrenciaDiario; descricao: string; motivo?: string | null; horas?: number | null };

const TABELA_LINHA = { efetivo: "diario_efetivo", equipamento: "diario_equipamento", servico: "diario_servico", ocorrencia: "diario_ocorrencia" } as const;

export async function adicionarLinha(a: Ator, id: string, l: LinhaDiario) {
  await comContexto(ctxCampo(a), async (c) => inserirLinha(c, a, await emRascunho(c, a, id), l));
}

/** Grava uma linha no diário em elaboração, dentro da transação já aberta. */
export async function inserirLinha(c: PoolClient, a: Ator, d: Diario, l: LinhaDiario) {
  const id = d.id;
  if (l.tipo === "efetivo") {
    if (!limpo(l.funcao)) throw new ErroDeRegra("Informe a função.");
    if (!Number.isInteger(l.quantidade) || l.quantidade < 1) throw new ErroDeRegra("Informe a quantidade de pessoas.");
    const ja = (await c.query("select id from diario_efetivo where diario_id = $1 and lower(funcao) = lower($2) and coalesce(empresa, '') = coalesce($3, '')",
      [id, limpo(l.funcao), limpo(l.empresa)])).rows[0];
    if (ja) await c.query("update diario_efetivo set quantidade = quantidade + $2 where id = $1", [ja.id, l.quantidade]);
    else await c.query("insert into diario_efetivo (orgao_id, diario_id, funcao, empresa, quantidade) values ($1,$2,$3,$4,$5)",
      [a.orgaoId, id, limpo(l.funcao), limpo(l.empresa), l.quantidade]);
  } else if (l.tipo === "equipamento") {
    if (!limpo(l.descricao)) throw new ErroDeRegra("Informe o equipamento.");
    if (!Number.isInteger(l.quantidade) || l.quantidade < 1) throw new ErroDeRegra("Informe a quantidade.");
    if (l.horas != null && (l.horas < 0 || l.horas > 24)) throw new ErroDeRegra("As horas trabalhadas vão de 0 a 24.");
    await c.query("insert into diario_equipamento (orgao_id, diario_id, descricao, quantidade, horas) values ($1,$2,$3,$4,$5)",
      [a.orgaoId, id, limpo(l.descricao), l.quantidade, l.horas ?? null]);
  } else if (l.tipo === "servico") {
    const atividade = l.atividadeId && uuid(l.atividadeId) ? d.atividades.find((x) => x.id === l.atividadeId) : null;
    if (l.atividadeId && !atividade) throw new ErroDeRegra("Atividade não encontrada no cronograma da obra.");
    const descricao = limpo(l.descricao) ?? (atividade ? `${atividade.codigo} ${atividade.nome}` : null);
    if (!descricao) throw new ErroDeRegra("Descreva o serviço executado.");
    if (l.avancoPct != null) {
      if (!atividade) throw new ErroDeRegra("O avanço é lançado sobre uma atividade do cronograma.");
      if (l.avancoPct < 0 || l.avancoPct > 100) throw new ErroDeRegra("O avanço vai de 0% a 100%.");
      if (l.avancoPct < atividade.avanco) throw new ErroDeRegra(`O avanço acumulado da atividade já é ${String(atividade.avanco).replace(".", ",")}%.`);
    }
    await c.query("insert into diario_servico (orgao_id, diario_id, atividade_id, descricao, local, avanco_pct) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, id, atividade?.id ?? null, descricao, limpo(l.local), l.avancoPct ?? null]);
  } else {
    if (!limpo(l.descricao)) throw new ErroDeRegra("Descreva a ocorrência.");
    if (!["ocorrencia", "visita", "paralisacao"].includes(l.subtipo)) throw new ErroDeRegra("Escolha o tipo.");
    const par = l.subtipo === "paralisacao";
    if (par && !MOTIVOS.includes(l.motivo as Motivo)) throw new ErroDeRegra("Informe o motivo da paralisação.");
    if (par && !(l.horas && l.horas > 0 && l.horas <= 24)) throw new ErroDeRegra("Informe as horas paradas (até 24).");
    await c.query("insert into diario_ocorrencia (orgao_id, diario_id, tipo, motivo, horas, descricao) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, id, l.subtipo, par ? l.motivo : null, par ? l.horas : null, limpo(l.descricao)]);
  }
}

export async function removerLinha(a: Ator, id: string, tipo: LinhaDiario["tipo"], linhaId: string) {
  if (!uuid(linhaId) || !(tipo in TABELA_LINHA)) throw new ErroDeRegra("Registro não encontrado.");
  await comContexto(ctxCampo(a), async (c) => {
    await emRascunho(c, a, id);
    const r = await c.query(`delete from ${TABELA_LINHA[tipo]} where id = $1 and diario_id = $2${tipo === "ocorrencia" ? " and ocorrencia_seguranca_id is null" : ""}`, [linhaId, id]);
    if (!r.rowCount) throw new ErroDeRegra(tipo === "ocorrencia" ? "Ocorrência de segurança só sai pelo módulo de segurança." : "Registro não encontrado.");
  });
}

/** Preenche o efetivo e os equipamentos com o que está alocado na obra no dia do diário. */
export async function trazerEquipeAlocada(a: Ator, id: string): Promise<number> {
  return comContexto(ctxCampo(a), async (c) => {
    const d = await emRascunho(c, a, id);
    let n = 0;
    if (!d.efetivo.length) {
      n += (await c.query(
        `insert into diario_efetivo (orgao_id, diario_id, funcao, empresa, quantidade)
         select $3, $4, coalesce(x.funcao, p.funcao), e.razao_social, count(*)
           from alocacao_pessoa x join pessoa p on p.id = x.pessoa_id left join empresa e on e.id = p.empresa_id
          where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2
          group by coalesce(x.funcao, p.funcao), e.razao_social`, [d.obra.id, d.data, a.orgaoId, id])).rowCount ?? 0;
    }
    if (!d.equipamentos.length) {
      n += (await c.query(
        `insert into diario_equipamento (orgao_id, diario_id, descricao, quantidade, horas)
         select $3, $4, q.descricao, count(*),
                nullif((select max(z.horas) from apontamento_equipamento z join equipamento w on w.id = z.equipamento_id
                         where z.obra_id = $1 and z.data = $2 and w.descricao = q.descricao), 0)
           from alocacao_equipamento x join equipamento q on q.id = x.equipamento_id
          where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2
          group by q.descricao`, [d.obra.id, d.data, a.orgaoId, id])).rowCount ?? 0;
    }
    if (!n) throw new ErroDeRegra("Não há equipe alocada na obra nesta data.");
    return n;
  });
}

/** Repete o efetivo e os equipamentos do último diário. */
export async function repetirAnterior(a: Ator, id: string): Promise<number> {
  return comContexto(ctxCampo(a), async (c) => {
    const d = await emRascunho(c, a, id);
    const ant = (await c.query("select id from diario where obra_id = $1 and data < $2 order by data desc limit 1", [d.obra.id, d.data])).rows[0];
    if (!ant) throw new ErroDeRegra("Não há diário anterior.");
    let n = 0;
    if (!d.efetivo.length) {
      n += (await c.query(`insert into diario_efetivo (orgao_id, diario_id, funcao, empresa, quantidade)
                            select orgao_id, $2, funcao, empresa, quantidade from diario_efetivo where diario_id = $1`, [ant.id, id])).rowCount ?? 0;
    }
    if (!d.equipamentos.length) {
      n += (await c.query(`insert into diario_equipamento (orgao_id, diario_id, descricao, quantidade, horas)
                            select orgao_id, $2, descricao, quantidade, horas from diario_equipamento where diario_id = $1`, [ant.id, id])).rowCount ?? 0;
    }
    if (!n) throw new ErroDeRegra("O diário já tem efetivo e equipamentos.");
    return n;
  });
}

export async function assinarDiario(a: Ator, id: string) {
  exigir(a, "diario.assinar");
  await comContexto(ctxCampo(a), async (c) => {
    const d = await lerDiario(c, a, id);
    if (d.situacao !== "rascunho") throw new ErroDeRegra("O diário já está assinado.");
    await c.query("update diario set situacao = 'assinado' where id = $1", [id]);
  });
}

export async function vistarDiario(a: Ator, id: string, observacao: string | null) {
  exigir(a, "diario.visto");
  await comContexto(ctxCampo(a), async (c) => {
    const d = await lerDiario(c, a, id);
    if (d.situacao !== "assinado") throw new ErroDeRegra("O visto é dado no diário assinado.");
    if (d.vistoEm) throw new ErroDeRegra("O visto do fiscal já foi dado.");
    if (d.assinadoPorMim) throw new ErroDeRegra("O visto é de outra pessoa, não de quem assinou o diário.");
    await c.query("update diario set visto_em = now(), visto_observacao = $2 where id = $1", [id, limpo(observacao)]);
  });
}

export async function complementarDiario(a: Ator, id: string, texto: string) {
  if (!pode(a, "diario.lancar") && !pode(a, "diario.visto")) throw new SemPermissao();
  if (!limpo(texto)) throw new ErroDeRegra("Escreva o complemento.");
  await comContexto(ctxCampo(a), async (c) => {
    const d = await lerDiario(c, a, id);
    if (d.situacao !== "assinado") throw new ErroDeRegra("Diário em elaboração: edite o relato.");
    await c.query("insert into diario_complemento (orgao_id, diario_id, texto) values ($1,$2,$3)", [a.orgaoId, id, limpo(texto)]);
  });
}

// ---------------------------------------------------------------------------
// Relatório do período
// ---------------------------------------------------------------------------
export type RelatorioDiario = {
  obra: ObraCampo; de: string; ate: string; diarios: Diario[];
  diasCorridos: number; diasComDiario: number; diasUteisSemDiario: string[]; assinados: number; vistados: number;
  efetivoMedio: number; efetivoMaximo: number; homensDia: number; diasChuva: number;
  efetivoPorFuncao: { funcao: string; homensDia: number }[];
  paradas: { motivo: Motivo; horas: number; dias: number }[];
  avancos: { codigo: string; nome: string; de: number; ate: number }[];
  fotos: number;
};

export async function relatorioDiario(a: Ator, obraId: string, de: string, ate: string): Promise<RelatorioDiario> {
  exigirVer(a, "diario.ver");
  if (!dataValida(de) || !dataValida(ate) || ate < de) throw new ErroDeRegra("Período inválido.");
  return comContexto(ctxCampo(a), async (c) => {
    const obra = await obraNoAcesso(c, a, obraId);
    const ids = (await c.query("select id from diario where obra_id = $1 and data between $2 and $3 order by data", [obraId, de, ate])).rows;
    const diarios: Diario[] = [];
    for (const { id } of ids) diarios.push(await lerDiario(c, a, id));
    const cal = await feriados(c);
    const feitos = new Set(diarios.map((d) => d.data));
    const semDiario: string[] = [];
    let corridos = 0;
    const limite = ate < hoje() ? ate : somarDias(hoje(), -1);
    for (let d = de; d <= ate; d = somarDias(d, 1)) {
      corridos++;
      if (obra.inicio && d >= obra.inicio && d <= limite && diaDeTrabalho(d, cal) && !feitos.has(d)) semDiario.push(d);
    }
    const efetivos = diarios.map((d) => d.totalEfetivo);
    const porFuncao = new Map<string, number>();
    for (const d of diarios) for (const e of d.efetivo) porFuncao.set(e.funcao, (porFuncao.get(e.funcao) ?? 0) + e.quantidade);
    const paradas = new Map<Motivo, { horas: number; dias: Set<string> }>();
    for (const d of diarios) for (const o of d.ocorrencias) if (o.tipo === "paralisacao" && o.motivo) {
      const p = paradas.get(o.motivo) ?? { horas: 0, dias: new Set() };
      p.horas += o.horas ?? 0; p.dias.add(d.data); paradas.set(o.motivo, p);
    }
    const avancos = (await c.query(
      `select a.codigo, a.nome,
              coalesce((select percentual from avanco v where v.atividade_id = a.id and v.data < $2 order by v.data desc, v.criado_em desc limit 1), 0)::float8 as de,
              coalesce((select percentual from avanco v where v.atividade_id = a.id and v.data <= $3 order by v.data desc, v.criado_em desc limit 1), 0)::float8 as ate
         from atividade a join cronograma c on c.id = a.cronograma_id
        where c.obra_id = $1 and c.situacao = 'linha_base'
          and not exists (select 1 from atividade f where f.cronograma_id = a.cronograma_id and f.codigo like a.codigo || '.%')
        order by a.ordem`, [obraId, de, ate])).rows.filter((r) => r.ate > r.de);
    return {
      obra, de, ate, diarios, diasCorridos: corridos, diasComDiario: diarios.length, diasUteisSemDiario: semDiario,
      assinados: diarios.filter((d) => d.situacao === "assinado").length, vistados: diarios.filter((d) => d.vistoEm).length,
      efetivoMedio: efetivos.length ? Math.round((efetivos.reduce((s, n) => s + n, 0) / efetivos.length) * 10) / 10 : 0,
      efetivoMaximo: efetivos.length ? Math.max(...efetivos) : 0, homensDia: efetivos.reduce((s, n) => s + n, 0),
      diasChuva: diarios.filter((d) => d.climaManha.startsWith("chuva") || d.climaTarde.startsWith("chuva")).length,
      efetivoPorFuncao: [...porFuncao].map(([funcao, homensDia]) => ({ funcao, homensDia })).sort((x, y) => y.homensDia - x.homensDia),
      paradas: [...paradas].map(([motivo, p]) => ({ motivo, horas: p.horas, dias: p.dias.size })).sort((x, y) => y.horas - x.horas),
      avancos, fotos: diarios.reduce((s, d) => s + d.fotos.length, 0),
    };
  });
}

/** Diários e fotos do período, como evidência da medição. */
export async function evidenciasDoPeriodo(a: Ator, obraId: string, de: string, ate: string) {
  if (!pode(a, "diario.ver")) return null;
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    const diarios = (await c.query(
      `select d.id, d.numero, to_char(d.data, 'YYYY-MM-DD') as data, d.situacao, d.visto_em is not null as visto,
              coalesce((select sum(quantidade) from diario_efetivo where diario_id = d.id), 0)::int as efetivo,
              (select count(*) from foto where diario_id = d.id)::int as fotos,
              coalesce((select sum(horas) from diario_ocorrencia where diario_id = d.id and tipo = 'paralisacao'), 0)::float8 as "horasParadas"
         from diario d where d.obra_id = $1 and d.data between $2 and $3 order by d.data`, [obraId, de, ate])).rows;
    const fotos = (await c.query(
      `select ${COLUNAS_FOTO} from foto f left join usuario u on u.id = f.criado_por join diario d on d.id = f.diario_id
        where d.obra_id = $1 and d.data between $2 and $3 order by d.data, f.criado_em limit 12`, [obraId, de, ate])).rows as FotoResumo[];
    return { diarios, fotos };
  });
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------
export type AlvoFoto = { diarioId?: string; naoConformidadeId?: string; ocorrenciaSegurancaId?: string; inspecaoId?: string };
export type NovaFoto = {
  obraId: string; alvo: AlvoFoto; momento?: "antes" | "depois" | null; legenda?: string | null; tiradaEm?: string | null;
  latitude?: number | null; longitude?: number | null; mime: string; largura: number; altura: number; conteudo: Buffer; miniatura: Buffer;
};
export const TAMANHO_MAXIMO_FOTO = 3_000_000;

export async function enviarFoto(a: Ator, f: NovaFoto): Promise<string> {
  const alvos = Object.entries(f.alvo).filter(([, v]) => v);
  if (alvos.length !== 1 || !uuid(alvos[0][1] as string)) throw new ErroDeRegra("Foto sem destino.");
  const [tipo, alvoId] = alvos[0] as [keyof AlvoFoto, string];
  const acao: Acao = tipo === "diarioId" ? "diario.lancar" : tipo === "ocorrenciaSegurancaId" ? "seguranca.registrar"
    : tipo === "naoConformidadeId" ? (f.momento === "depois" ? "qualidade.corrigir" : "qualidade.registrar") : "qualidade.registrar";
  if (!pode(a, acao) && !(tipo === "naoConformidadeId" && pode(a, "qualidade.verificar"))) throw new SemPermissao();
  if (!["image/jpeg", "image/png", "image/webp"].includes(f.mime)) throw new ErroDeRegra("Envie uma imagem JPEG, PNG ou WebP.");
  if (f.conteudo.length === 0 || f.conteudo.length > TAMANHO_MAXIMO_FOTO) throw new ErroDeRegra("A foto passa de 3 MB.");
  if (f.miniatura.length === 0 || f.miniatura.length > 200_000) throw new ErroDeRegra("Miniatura inválida.");
  if (!(f.largura > 0 && f.largura <= 4000 && f.altura > 0 && f.altura <= 4000)) throw new ErroDeRegra("Dimensões da foto inválidas.");
  const lat = f.latitude != null && Number.isFinite(f.latitude) && Math.abs(f.latitude) <= 90 ? f.latitude : null;
  const lng = f.longitude != null && Number.isFinite(f.longitude) && Math.abs(f.longitude) <= 180 ? f.longitude : null;
  const tirada = f.tiradaEm && !Number.isNaN(Date.parse(f.tiradaEm)) ? new Date(f.tiradaEm) : null;
  const arm = armazenamento();
  const id = randomUUID();
  const enviados: string[] = [];
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, f.obraId);
    const tabela = { diarioId: "diario", naoConformidadeId: "nao_conformidade", ocorrenciaSegurancaId: "ocorrencia_seguranca", inspecaoId: "inspecao" }[tipo];
    const alvo = (await c.query(`select obra_id from ${tabela} where id = $1`, [alvoId])).rows[0];
    if (!alvo || alvo.obra_id !== f.obraId) throw new ErroDeRegra("Destino da foto não encontrado.");
    if (tipo === "naoConformidadeId") {
      const nc = (await c.query("select situacao from nao_conformidade where id = $1", [alvoId])).rows[0];
      if (nc.situacao === "encerrada" || nc.situacao === "cancelada") throw new ErroDeRegra("Não conformidade encerrada não recebe fotos.");
    }
    const coluna = { diarioId: "diario_id", naoConformidadeId: "nao_conformidade_id", ocorrenciaSegurancaId: "ocorrencia_seguranca_id", inspecaoId: "inspecao_id" }[tipo];
    // Com armazenamento configurado, os bytes vão para lá e o banco guarda o caminho.
    let arquivo: string | null = null, arquivoMini: string | null = null;
    if (arm) {
      arquivo = caminhoDoArquivo(a.orgaoId, "fotos", f.obraId, `${id}.${extensaoDoMime(f.mime)}`);
      arquivoMini = caminhoDoArquivo(a.orgaoId, "fotos", f.obraId, `${id}-miniatura.jpg`);
      enviados.push(arquivo);
      await arm.guardar(arquivo, f.conteudo, f.mime);
      enviados.push(arquivoMini);
      await arm.guardar(arquivoMini, f.miniatura, "image/jpeg");
    }
    return (await c.query(
      `insert into foto (id, orgao_id, obra_id, ${coluna}, momento, legenda, tirada_em, latitude, longitude, mime, largura, altura, conteudo, miniatura, arquivo, arquivo_miniatura)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [id, a.orgaoId, f.obraId, alvoId, tipo === "naoConformidadeId" ? (f.momento ?? "antes") : null, limpo(f.legenda), tirada, lat, lng,
        f.mime, Math.round(f.largura), Math.round(f.altura), arm ? null : f.conteudo, arm ? null : f.miniatura, arquivo, arquivoMini])).rows[0].id as string;
  }).catch(async (e) => {
    // Nada fica solto no armazenamento se a gravação no banco não acontecer.
    if (arm && enviados.length) await arm.remover(enviados).catch(() => {});
    throw e;
  });
}

export async function lerFoto(a: Ator, id: string, miniatura: boolean): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!uuid(id)) return null;
  if (!pode(a, "diario.ver") && !pode(a, "qualidade.ver") && !pode(a, "seguranca.ver")) return null;
  const r = await comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "f.obra_id", 2);
    const r = (await c.query(
      `select ${miniatura ? "'image/jpeg' as mime, f.miniatura as bytes, f.arquivo_miniatura as arquivo" : "f.mime, f.conteudo as bytes, f.arquivo"} from foto f where f.id = $1 and ${v.sql}`,
      [id, ...v.params])).rows[0];
    return (r ?? null) as { mime: string; bytes: Buffer | null; arquivo: string | null } | null;
  });
  return lerGuardado(r);
}

/** Bytes de um arquivo que está no armazenamento ou, se ainda não mudou, no banco. */
export async function lerGuardado(r: { mime: string; bytes: Buffer | null; arquivo: string | null } | null) {
  if (!r) return null;
  // Durante a mudança, o arquivo pode estar nos dois lugares; o armazenamento vale.
  if (r.arquivo) {
    const bytes = await armazenamentoObrigatorio().ler(r.arquivo);
    if (bytes) return { mime: r.mime, bytes };
    if (!r.bytes) return null;
  }
  return r.bytes ? { mime: r.mime, bytes: r.bytes } : null;
}

export async function excluirFoto(a: Ator, id: string) {
  exigir(a, "diario.lancar");
  if (!uuid(id)) throw new ErroDeRegra("Foto não encontrada.");
  await comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "obra_id", 2);
    const r = await c.query(`delete from foto where id = $1 and diario_id is not null and ${v.sql} returning arquivo, arquivo_miniatura`, [id, ...v.params]);
    if (!r.rowCount) throw new ErroDeRegra("Foto de evidência não se exclui.");
    return [r.rows[0].arquivo, r.rows[0].arquivo_miniatura].filter(Boolean) as string[];
  }).then(async (caminhos) => {
    // Remove do armazenamento só depois de a exclusão valer no banco.
    if (caminhos.length) await armazenamentoObrigatorio().remover(caminhos).catch((e) => console.error("Foto excluída, arquivo não removido:", caminhos, e));
  });
}

// ---------------------------------------------------------------------------
// Pendências de campo para o início
// ---------------------------------------------------------------------------
export type PendenciaCampo = { texto: string; href: string; grave: boolean };

export async function pendenciasDeCampo(a: Ator): Promise<PendenciaCampo[]> {
  const verDiario = pode(a, "diario.ver"), verQual = pode(a, "qualidade.ver"), verSeg = pode(a, "seguranca.ver");
  if (!verDiario && !verQual && !verSeg) return [];
  return comContexto(ctxCampo(a), async (c) => {
    const p: PendenciaCampo[] = [];
    const v = obrasVisiveis(a, "o.id", 1);
    const obras = (await c.query(`select o.id from obra o where o.situacao = 'em_execucao' and ${v.sql}`, v.params)).rows as { id: string }[];
    if (verDiario && obras.length) {
      let dias = 0, semHoje = 0, semVisto = 0;
      for (const { id } of obras) {
        const obra = await obraNoAcesso(c, a, id);
        dias += (await diasPendentes(c, obra)).length;
        if (!(await c.query("select 1 from diario where obra_id = $1 and data = $2", [id, hoje()])).rowCount) semHoje++;
        semVisto += (await c.query("select count(*)::int as n from diario where obra_id = $1 and situacao = 'assinado' and visto_em is null", [id])).rows[0].n;
      }
      if (dias) p.push({ texto: `${dias} ${dias === 1 ? "dia útil" : "dias úteis"} sem diário de obra`, href: "/diario", grave: true });
      if (semHoje) p.push({ texto: `${semHoje} ${semHoje === 1 ? "obra" : "obras"} sem o diário de hoje`, href: "/diario", grave: false });
      if (semVisto && pode(a, "diario.visto")) p.push({ texto: `${semVisto} ${semVisto === 1 ? "diário aguarda" : "diários aguardam"} o seu visto`, href: "/diario", grave: false });
    }
    const vn = obrasVisiveis(a, "n.obra_id", 1);
    if (verQual || verSeg) {
      const r = (await c.query(
        `select n.area, count(*) filter (where n.prazo < hoje_local())::int as vencidas, count(*) filter (where n.situacao = 'corrigida')::int as verificar
           from nao_conformidade n where n.situacao in ('aberta', 'corrigida') and ${vn.sql} group by n.area`, vn.params)).rows;
      for (const l of r) {
        if (l.area === "qualidade" && !verQual) continue;
        if (l.area === "seguranca" && !verSeg) continue;
        const nome = l.area === "qualidade" ? "qualidade" : "segurança";
        if (l.vencidas) p.push({ texto: `${l.vencidas} ${l.vencidas === 1 ? "não conformidade" : "não conformidades"} de ${nome} com prazo vencido`, href: `/${l.area}`, grave: true });
        if (l.verificar && pode(a, "qualidade.verificar")) p.push({ texto: `${l.verificar} ${l.verificar === 1 ? "correção aguarda" : "correções aguardam"} verificação (${nome})`, href: `/${l.area}`, grave: false });
      }
    }
    if (verSeg) {
      const vs = obrasVisiveis(a, "s.obra_id", 1);
      const n = (await c.query(`select count(*)::int as n from ocorrencia_seguranca s where s.situacao = 'aberta' and s.prazo < hoje_local() and ${vs.sql}`, vs.params)).rows[0].n;
      if (n) p.push({ texto: `${n} ${n === 1 ? "ação corretiva de segurança vencida" : "ações corretivas de segurança vencidas"}`, href: "/seguranca", grave: true });
    }
    return p;
  });
}

/** Dias e horas parados por motivo registrados no diário, para justificar prazo. */
export async function paradasDaObra(a: Ator, obraId: string) {
  if (!pode(a, "diario.ver")) return [];
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    return (await c.query(
      `select o.motivo, count(distinct o.diario_id)::int as dias, sum(o.horas)::float8 as horas
         from diario_ocorrencia o join diario d on d.id = o.diario_id
        where d.obra_id = $1 and o.tipo = 'paralisacao' group by o.motivo order by 3 desc`, [obraId])).rows as { motivo: Motivo; dias: number; horas: number }[];
  });
}
