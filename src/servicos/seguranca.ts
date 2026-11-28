import { comContexto, ErroDeRegra } from "../lib/db";
import { COLUNAS_FOTO, ctxCampo, dataValida, diasSemAcidente, exigirVer, hoje, inicioDaObraSql, limpo, obraNoAcesso, obrasVisiveis, uuid, type FotoResumo, type ObraCampo } from "./campo";
import type { Ator } from "./obras";
import { exigir, pode } from "./permissoes";
import { painelQualidade, type PainelQualidade } from "./qualidade";

export type TipoOcorrencia = "acidente_com_afastamento" | "acidente_sem_afastamento" | "quase_acidente" | "risco_grave";
export const ROTULO_OCORRENCIA: Record<TipoOcorrencia, string> = {
  acidente_com_afastamento: "Acidente com afastamento", acidente_sem_afastamento: "Acidente sem afastamento",
  quase_acidente: "Quase acidente", risco_grave: "Risco grave e iminente",
};
export const TIPOS_OCORRENCIA = Object.keys(ROTULO_OCORRENCIA) as TipoOcorrencia[];
export const EPIS = ["Capacete", "Calçado de segurança", "Luva de raspa", "Luva nitrílica", "Óculos de proteção", "Protetor auricular", "Cinto paraquedista", "Talabarte duplo", "Máscara PFF2", "Colete refletivo", "Uniforme", "Perneira"];

export type OcorrenciaSeguranca = {
  id: string; obraId: string; numero: number; tipo: TipoOcorrencia; data: string; hora: string | null; local: string | null; descricao: string;
  envolvido: string | null; empresa: string | null; diasAfastamento: number | null; cat: string | null; paralisacao: boolean; horasParalisadas: number | null;
  acaoCorretiva: string; responsavel: string; prazo: string; situacao: "aberta" | "encerrada"; encerramento: string | null;
  encerradaPor: string | null; encerradaEm: Date | null; criadoPor: string | null; criadoEm: Date; vencida: boolean; diarioId: string | null;
};
const COLUNAS = `s.id, s.obra_id as "obraId", s.numero, s.tipo, to_char(s.data, 'YYYY-MM-DD') as data, to_char(s.hora, 'HH24:MI') as hora, s.local, s.descricao,
  s.envolvido, s.empresa, s.dias_afastamento as "diasAfastamento", s.cat, s.paralisacao, s.horas_paralisadas::float8 as "horasParalisadas",
  s.acao_corretiva as "acaoCorretiva", s.responsavel, to_char(s.prazo, 'YYYY-MM-DD') as prazo, s.situacao, s.encerramento,
  ue.nome as "encerradaPor", s.encerrada_em as "encerradaEm", uc.nome as "criadoPor", s.criado_em as "criadoEm",
  (s.situacao = 'aberta' and s.prazo < hoje_local()) as vencida,
  (select id from diario d where d.obra_id = s.obra_id and d.data = s.data) as "diarioId"`;
const DE = "from ocorrencia_seguranca s left join usuario ue on ue.id = s.encerrada_por left join usuario uc on uc.id = s.criado_por";

export type EntregaEpi = { id: string; data: string; trabalhador: string; funcao: string | null; empresa: string | null; epi: string; ca: string | null; quantidade: number; por: string | null };

export type PainelSeguranca = {
  obra: ObraCampo; ocorrencias: OcorrenciaSeguranca[]; epis: EntregaEpi[]; qualidade: PainelQualidade;
  diasSemAcidente: number | null; ultimoAcidente: string | null; acidentes: number; afastamento: number; quaseAcidentes: number; riscos: number;
  abertas: number; vencidas: number; horasParalisadas: number;
  podeRegistrar: boolean; podeEncerrar: boolean;
};

/** completo: sem limite de linhas, para planilha e relatório. A tela mostra as 200 entregas de EPI mais recentes. */
export async function painelSeguranca(a: Ator, obraId: string, completo = false): Promise<PainelSeguranca> {
  exigirVer(a, "seguranca.ver");
  const qualidade = await painelQualidade(a, obraId, "seguranca");
  return comContexto(ctxCampo(a), async (c) => {
    const obra = await obraNoAcesso(c, a, obraId);
    const ocorrencias = (await c.query(`select ${COLUNAS} ${DE} where s.obra_id = $1 order by s.data desc, s.numero desc`, [obraId])).rows as OcorrenciaSeguranca[];
    const epis = (await c.query(
      `select e.id, to_char(e.data, 'YYYY-MM-DD') as data, e.trabalhador, e.funcao, e.empresa, e.epi, e.ca, e.quantidade, u.nome as por
         from entrega_epi e left join usuario u on u.id = e.criado_por where e.obra_id = $1 order by e.data desc, e.criado_em desc${completo ? "" : " limit 200"}`, [obraId])).rows;
    const acid = ocorrencias.filter((o) => o.tipo === "acidente_com_afastamento" || o.tipo === "acidente_sem_afastamento");
    const ultimo = acid[0]?.data ?? null;
    return {
      obra, ocorrencias, epis, qualidade,
      diasSemAcidente: diasSemAcidente(ultimo, obra.inicio), ultimoAcidente: ultimo,
      acidentes: acid.length, afastamento: acid.reduce((s, o) => s + (o.diasAfastamento ?? 0), 0),
      quaseAcidentes: ocorrencias.filter((o) => o.tipo === "quase_acidente").length, riscos: ocorrencias.filter((o) => o.tipo === "risco_grave").length,
      abertas: ocorrencias.filter((o) => o.situacao === "aberta").length, vencidas: ocorrencias.filter((o) => o.vencida).length,
      horasParalisadas: ocorrencias.reduce((s, o) => s + (o.paralisacao ? (o.horasParalisadas ?? 0) : 0), 0),
      podeRegistrar: pode(a, "seguranca.registrar"), podeEncerrar: pode(a, "seguranca.encerrar"),
    };
  });
}

/** Resumo por obra para o módulo de segurança. */
export async function resumoSeguranca(a: Ator) {
  exigirVer(a, "seguranca.ver");
  return comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "o.id", 1);
    return (await c.query(
      `select o.id, o.codigo, o.nome, o.situacao,
              (select to_char(max(data), 'YYYY-MM-DD') from ocorrencia_seguranca s where s.obra_id = o.id and s.tipo in ('acidente_com_afastamento', 'acidente_sem_afastamento')) as ultimo,
              ${inicioDaObraSql("o")} as inicio,
              (select count(*)::int from ocorrencia_seguranca s where s.obra_id = o.id and s.situacao = 'aberta') as abertas,
              (select count(*)::int from ocorrencia_seguranca s where s.obra_id = o.id and s.situacao = 'aberta' and s.prazo < hoje_local()) as vencidas,
              (select count(*)::int from nao_conformidade n where n.obra_id = o.id and n.area = 'seguranca' and n.situacao in ('aberta', 'corrigida')) as ncs,
              (select count(*)::int from ocorrencia_seguranca s where s.obra_id = o.id and s.tipo in ('acidente_com_afastamento', 'acidente_sem_afastamento')) as acidentes
         from obra o where o.situacao in ('em_execucao', 'paralisada') and ${v.sql} order by o.codigo`, v.params)).rows.map((r) => {
      return { ...r, diasSemAcidente: diasSemAcidente(r.ultimo, r.inicio) };
    }) as { id: string; codigo: string; nome: string; ultimo: string | null; diasSemAcidente: number | null; abertas: number; vencidas: number; ncs: number; acidentes: number }[];
  });
}

export type DadosOcorrencia = {
  tipo: string; data: string; hora?: string | null; local?: string | null; descricao: string; envolvido?: string | null; empresa?: string | null;
  diasAfastamento?: number | null; cat?: string | null; paralisacao?: boolean; horasParalisadas?: number | null;
  acaoCorretiva: string; responsavel: string; prazo: string;
};

export async function registrarOcorrencia(a: Ator, obraId: string, d: DadosOcorrencia): Promise<string> {
  exigir(a, "seguranca.registrar");
  if (!TIPOS_OCORRENCIA.includes(d.tipo as TipoOcorrencia)) throw new ErroDeRegra("Escolha o tipo de ocorrência.");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  if (d.hora && !/^\d{2}:\d{2}$/.test(d.hora)) throw new ErroDeRegra("Hora inválida.");
  if (!limpo(d.descricao)) throw new ErroDeRegra("Descreva o que aconteceu.");
  if (!limpo(d.acaoCorretiva)) throw new ErroDeRegra("Informe a ação corretiva.");
  if (!limpo(d.responsavel)) throw new ErroDeRegra("Informe o responsável pela ação.");
  if (!dataValida(d.prazo) || d.prazo < d.data) throw new ErroDeRegra("Informe o prazo da ação corretiva.");
  if (d.tipo === "acidente_com_afastamento" && !(d.diasAfastamento != null && Number.isInteger(d.diasAfastamento) && d.diasAfastamento >= 0)) throw new ErroDeRegra("Informe os dias de afastamento.");
  if (d.tipo.startsWith("acidente") && !limpo(d.envolvido)) throw new ErroDeRegra("Informe o trabalhador acidentado.");
  if (d.paralisacao && !(d.horasParalisadas && d.horasParalisadas > 0 && d.horasParalisadas <= 24)) throw new ErroDeRegra("Informe as horas de paralisação (até 24).");
  if (d.paralisacao && !pode(a, "seguranca.encerrar") && a.perfil !== "fiscal") throw new ErroDeRegra("A paralisação da frente é registrada pelo fiscal ou pelo engenheiro.");
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    return (await c.query(
      `insert into ocorrencia_seguranca (orgao_id, obra_id, tipo, data, hora, local, descricao, envolvido, empresa, dias_afastamento, cat,
                                         paralisacao, horas_paralisadas, acao_corretiva, responsavel, prazo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [a.orgaoId, obraId, d.tipo, d.data, d.hora || null, limpo(d.local), limpo(d.descricao), limpo(d.envolvido), limpo(d.empresa),
        d.tipo === "acidente_com_afastamento" ? d.diasAfastamento : null, limpo(d.cat), !!d.paralisacao, d.paralisacao ? d.horasParalisadas : null,
        limpo(d.acaoCorretiva), limpo(d.responsavel), d.prazo])).rows[0].id as string;
  });
}

export async function encerrarOcorrencia(a: Ator, id: string, encerramento: string) {
  exigir(a, "seguranca.encerrar");
  if (!uuid(id)) throw new ErroDeRegra("Ocorrência não encontrada.");
  if (!limpo(encerramento)) throw new ErroDeRegra("Registre como a ação corretiva foi concluída.");
  await comContexto(ctxCampo(a), async (c) => {
    const o = (await c.query("select obra_id, situacao from ocorrencia_seguranca where id = $1 for update", [id])).rows[0];
    if (!o) throw new ErroDeRegra("Ocorrência não encontrada.");
    await obraNoAcesso(c, a, o.obra_id);
    if (o.situacao !== "aberta") throw new ErroDeRegra("A ocorrência já está encerrada.");
    await c.query("update ocorrencia_seguranca set situacao = 'encerrada', encerramento = $2 where id = $1", [id, limpo(encerramento)]);
  });
}

export async function obterOcorrencia(a: Ator, id: string) {
  exigirVer(a, "seguranca.ver");
  if (!uuid(id)) throw new ErroDeRegra("Ocorrência não encontrada.");
  return comContexto(ctxCampo(a), async (c) => {
    const o = (await c.query(`select ${COLUNAS} ${DE} where s.id = $1`, [id])).rows[0] as OcorrenciaSeguranca | undefined;
    if (!o) throw new ErroDeRegra("Ocorrência não encontrada.");
    const obra = await obraNoAcesso(c, a, o.obraId);
    const fotos = (await c.query(`select ${COLUNAS_FOTO} from foto f left join usuario u on u.id = f.criado_por where f.ocorrencia_seguranca_id = $1 order by f.criado_em`, [id])).rows as FotoResumo[];
    return { ...o, obra, fotos, podeEncerrar: o.situacao === "aberta" && pode(a, "seguranca.encerrar"), podeFoto: o.situacao === "aberta" && pode(a, "seguranca.registrar") };
  });
}

export type DadosEpi = { data: string; trabalhador: string; funcao?: string | null; empresa?: string | null; epis: string[]; ca?: string | null; quantidade?: number };

export async function registrarEpi(a: Ator, obraId: string, d: DadosEpi): Promise<number> {
  exigir(a, "seguranca.registrar");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  if (!limpo(d.trabalhador)) throw new ErroDeRegra("Informe o trabalhador.");
  const epis = [...new Set(d.epis.map((e) => e.trim()).filter(Boolean))];
  if (!epis.length) throw new ErroDeRegra("Escolha ao menos um EPI.");
  const q = d.quantidade && d.quantidade > 0 ? Math.round(d.quantidade) : 1;
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    for (const epi of epis) {
      await c.query("insert into entrega_epi (orgao_id, obra_id, data, trabalhador, funcao, empresa, epi, ca, quantidade) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [a.orgaoId, obraId, d.data, limpo(d.trabalhador), limpo(d.funcao), limpo(d.empresa), epi, epis.length === 1 ? limpo(d.ca) : null, q]);
    }
    return epis.length;
  });
}
