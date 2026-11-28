import { comContexto } from "../lib/db";
import { ctxCampo, exigirVer, hoje, obrasVisiveis } from "./campo";
import { listarContratos, type ResumoContrato } from "./contratos";
import { panoramaCronogramas } from "./cronogramas";
import { painelDocumentos } from "./documentos";
import type { Ator } from "./obras";
import { pode } from "./permissoes";
import type { FormaExecucao, Situacao, TipoObra } from "./rotulos";

/** Limites do semáforo. IDP = valor agregado ÷ valor planejado até hoje na linha de base. */
export const LIMITES = { idpAtencao: 0.95, idpCritico: 0.85, diasSemMedicao: 45, vigenciaAviso: 30, medidoAFrente: 10 } as const;

export type Nivel = "verde" | "amarelo" | "vermelho";
export type Motivo = { nivel: Exclude<Nivel, "verde">; texto: string; href: string };
export type ObraGerencial = {
  id: string; codigo: string; nome: string; tipo: TipoObra; forma: FormaExecucao; situacao: Situacao; unidade: string | null; unidadeId: string | null;
  latitude: number | null; longitude: number | null;
  /** Valor atual dos contratos (com aditivos e reajustes), o mesmo da página Contratos. */
  contratado: number; saldo: number; medido: number; pago: number; aPagar: number; executadoPct: number;
  previstoPct: number | null; realizadoPct: number | null; idp: number | null;
  ultimaMedicao: string | null; vigenciaFim: string | null; diasVigencia: number | null;
  ncsGraves: number; ncsVencidas: number; documentosVencidos: number; exigenciasFaltando: number; habilitacoesVencidas: number;
  nivel: Nivel; motivos: Motivo[];
};
export type Vencimento = { data: string; tipo: string; descricao: string; obraCodigo: string | null; href: string; vencido: boolean };
export type PainelGerencial = {
  obras: ObraGerencial[];
  totais: { contratado: number; medido: number; pago: number; aPagar: number; saldo: number };
  porNivel: Record<Nivel, number>; porSituacao: Partial<Record<Situacao, number>>;
  mensal: { mes: string; medido: number; pago: number }[];
  vencimentos: Vencimento[];
  unidades: { id: string; nome: string }[];
  filtros: FiltrosGerencial;
};
export type FiltrosGerencial = { tipo?: string; unidade?: string; situacao?: string };

const SITUACOES_PAINEL: Situacao[] = ["licitada", "contratada", "em_execucao", "paralisada", "concluida", "recebida_provisoriamente"];
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dias = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000);
const n = (v: string | number | null | undefined) => Number(v ?? 0);

/** Nível do semáforo e motivos, em ordem de gravidade. Função pura, testada à parte. */
export function avaliarObra(o: Omit<ObraGerencial, "nivel" | "motivos">, h: string): { nivel: Nivel; motivos: Motivo[] } {
  const m: Motivo[] = [];
  const base = `/obras/${o.id}`;
  const emCampo = o.situacao === "em_execucao" || o.situacao === "paralisada";
  if (o.idp != null && emCampo) {
    if (o.idp < LIMITES.idpCritico) m.push({ nivel: "vermelho", texto: `Atraso físico: IDP ${o.idp.toFixed(2).replace(".", ",")} (${o.realizadoPct!.toFixed(1).replace(".", ",")}% feito de ${o.previstoPct!.toFixed(1).replace(".", ",")}% previsto)`, href: `${base}/cronograma` });
    else if (o.idp < LIMITES.idpAtencao) m.push({ nivel: "amarelo", texto: `Ritmo abaixo do previsto: IDP ${o.idp.toFixed(2).replace(".", ",")}`, href: `${base}/cronograma` });
  }
  if (o.diasVigencia != null && o.situacao !== "concluida") {
    if (o.diasVigencia < 0) m.push({ nivel: "vermelho", texto: `Vigência do contrato encerrada há ${-o.diasVigencia} ${o.diasVigencia === -1 ? "dia" : "dias"}`, href: `${base}/contrato` });
    else if (o.diasVigencia <= LIMITES.vigenciaAviso) m.push({ nivel: "amarelo", texto: `Vigência do contrato termina em ${o.diasVigencia} ${o.diasVigencia === 1 ? "dia" : "dias"}`, href: `${base}/contrato` });
  }
  if (o.ncsGraves) m.push({ nivel: "vermelho", texto: `${o.ncsGraves} ${o.ncsGraves === 1 ? "não conformidade grave ou impeditiva aberta" : "não conformidades graves ou impeditivas abertas"}`, href: `${base}/qualidade` });
  else if (o.ncsVencidas) m.push({ nivel: "amarelo", texto: `${o.ncsVencidas} ${o.ncsVencidas === 1 ? "não conformidade com prazo vencido" : "não conformidades com prazo vencido"}`, href: `${base}/qualidade` });
  if (emCampo && o.contratado > 0 && o.situacao === "em_execucao") {
    const parada = o.ultimaMedicao ? dias(o.ultimaMedicao, h) : null;
    if (parada != null && parada > LIMITES.diasSemMedicao) m.push({ nivel: "amarelo", texto: `Sem medição aprovada há ${parada} dias`, href: `${base}/medicoes` });
  }
  if (o.realizadoPct != null && o.executadoPct - o.realizadoPct > LIMITES.medidoAFrente)
    m.push({ nivel: "amarelo", texto: `Medido à frente do avanço físico: ${o.executadoPct.toFixed(1).replace(".", ",")}% medido para ${o.realizadoPct.toFixed(1).replace(".", ",")}% executado`, href: `${base}/medicoes` });
  if (o.exigenciasFaltando) m.push({ nivel: "amarelo", texto: `${o.exigenciasFaltando} ${o.exigenciasFaltando === 1 ? "documento obrigatório faltando" : "documentos obrigatórios faltando"}`, href: `${base}/documentos` });
  if (o.documentosVencidos) m.push({ nivel: "amarelo", texto: `${o.documentosVencidos} ${o.documentosVencidos === 1 ? "documento vencido" : "documentos vencidos"}`, href: `${base}/documentos` });
  if (o.habilitacoesVencidas) m.push({ nivel: "amarelo", texto: `${o.habilitacoesVencidas} ${o.habilitacoesVencidas === 1 ? "pessoa alocada com ASO ou NR vencido" : "pessoas alocadas com ASO ou NR vencido"}`, href: `${base}/equipes` });
  if (o.situacao === "paralisada") m.push({ nivel: "amarelo", texto: "Obra paralisada", href: base });
  m.sort((x, y) => (x.nivel === y.nivel ? 0 : x.nivel === "vermelho" ? -1 : 1));
  return { nivel: m.some((x) => x.nivel === "vermelho") ? "vermelho" : m.length ? "amarelo" : "verde", motivos: m };
}

export async function painelGerencial(a: Ator, filtros: FiltrosGerencial = {}): Promise<PainelGerencial> {
  exigirVer(a, "gerencial.ver");
  const h = hoje();
  const [contratos, cronos, docs] = await Promise.all([
    pode(a, "contrato.ver") ? listarContratos(a) : Promise.resolve([] as ResumoContrato[]),
    pode(a, "cronograma.ver") ? panoramaCronogramas(a) : Promise.resolve([] as Awaited<ReturnType<typeof panoramaCronogramas>>),
    pode(a, "documentos.ver") ? painelDocumentos(a) : Promise.resolve(null),
  ]);
  const docsPorObra = new Map((docs?.obras ?? []).map((o) => [o.id, o]));

  return comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "o.id", 1);
    const params: unknown[] = [...v.params];
    const cond = [v.sql, `o.situacao = any($${params.push(SITUACOES_PAINEL)}::situacao_obra[])`];
    if (filtros.tipo) cond.push(`o.tipo::text = $${params.push(filtros.tipo)}`);
    if (filtros.unidade) cond.push(`o.unidade_id::text = $${params.push(filtros.unidade)}`);
    if (filtros.situacao) cond.push(`o.situacao::text = $${params.push(filtros.situacao)}`);
    const linhas = (await c.query(
      `select o.id, o.codigo, o.nome, o.tipo, o.forma_execucao as forma, o.situacao, u.sigla as unidade, o.unidade_id as "unidadeId",
              o.latitude::float8 as latitude, o.longitude::float8 as longitude,
              (select to_char(max(m.aprovada_em at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD') from medicao m join contrato k on k.id = m.contrato_id
                where k.obra_id = o.id and m.situacao = 'aprovada') as "ultimaMedicao",
              (select to_char(min(k.data_ordem_servico), 'YYYY-MM-DD') from contrato k where k.obra_id = o.id and k.situacao = 'vigente') as "inicioContrato",
              (select count(*)::int from nao_conformidade x where x.obra_id = o.id and x.situacao in ('aberta', 'corrigida') and (x.gravidade = 'grave' or x.impeditiva)) as "ncsGraves",
              (select count(*)::int from nao_conformidade x where x.obra_id = o.id and x.situacao in ('aberta', 'corrigida') and x.prazo < hoje_local()) as "ncsVencidas",
              (select count(*)::int from alocacao_pessoa x where x.obra_id = o.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local()
                  and pendencia_habilitacao(x.pessoa_id, hoje_local()) is not null) as "habilitacoesVencidas"
         from obra o left join unidade u on u.id = o.unidade_id where ${cond.join(" and ")} order by o.codigo`, params)).rows;

    const obras: ObraGerencial[] = linhas.map((l) => {
      const ks = contratos.filter((k) => k.obraId === l.id && k.situacao !== "rascunho");
      const contratado = ks.reduce((s, k) => s + n(k.valorAtual), 0);
      const comAditivos = ks.reduce((s, k) => s + n(k.valorContratual), 0);
      const saldo = ks.reduce((s, k) => s + n(k.saldo), 0);
      const medido = ks.reduce((s, k) => s + n(k.medido), 0);
      const pago = ks.reduce((s, k) => s + n(k.pago), 0);
      const vigentes = ks.filter((k) => k.situacao === "vigente" && k.vigenciaFim);
      const vigenciaFim = vigentes.map((k) => k.vigenciaFim!).sort()[0] ?? null;
      const cs = cronos.filter((x) => x.obraId === l.id && x.situacao === "linha_base");
      const tot = cs.reduce((s, x) => s + x.indicadores.total, 0);
      const vp = cs.reduce((s, x) => s + x.indicadores.vp, 0);
      const va = cs.reduce((s, x) => s + x.indicadores.va, 0);
      const d = docsPorObra.get(l.id);
      // Medição parada só conta depois de 45 dias da ordem de serviço.
      const ultima = l.ultimaMedicao ?? (l.inicioContrato && l.inicioContrato <= h ? l.inicioContrato : null);
      const base = {
        ...l, ultimaMedicao: ultima, contratado, saldo, medido, pago, aPagar: 0, executadoPct: comAditivos ? (medido / comAditivos) * 100 : 0,
        previstoPct: tot ? (vp / tot) * 100 : null, realizadoPct: tot ? (va / tot) * 100 : null, idp: vp > 0 ? va / vp : null,
        vigenciaFim, diasVigencia: vigenciaFim ? dias(h, vigenciaFim) : null,
        documentosVencidos: d?.vencidos ?? 0, exigenciasFaltando: d?.pendentes ?? 0,
      };
      return { ...base, ...avaliarObra(base, h), ultimaMedicao: l.ultimaMedicao };
    });

    // A pagar: líquido aprovado ainda não pago.
    if (pode(a, "medicao.ver") && obras.length) {
      const r = (await c.query(
        `select k.obra_id as id, coalesce(sum(m.valor_liquido - coalesce((select sum(p.valor) from pagamento p where p.medicao_id = m.id), 0)), 0)::float8 as "aPagar"
           from medicao m join contrato k on k.id = m.contrato_id where m.situacao = 'aprovada' and k.regime <> 'direta' and k.obra_id = any($1::uuid[]) group by k.obra_id`,
        [obras.map((o) => o.id)])).rows;
      for (const x of r) { const o = obras.find((y) => y.id === x.id); if (o) o.aPagar = Math.max(0, x.aPagar); }
    }

    const ids = obras.map((o) => o.id);
    const inicioSerie = new Date(Date.UTC(Number(h.slice(0, 4)), Number(h.slice(5, 7)) - 12, 1)).toISOString().slice(0, 10);
    const mensal = pode(a, "medicao.ver") && ids.length ? (await c.query(
      `with meses as (select to_char(g, 'YYYY-MM') as mes from generate_series($2::date, $3::date, interval '1 month') g)
       select mes,
              coalesce((select sum(m.valor_bruto) from medicao m join contrato k on k.id = m.contrato_id
                         where k.obra_id = any($1::uuid[]) and m.situacao = 'aprovada' and to_char(m.aprovada_em at time zone 'America/Sao_Paulo', 'YYYY-MM') = mes), 0)::float8 as medido,
              coalesce((select sum(p.valor) from pagamento p join medicao m on m.id = p.medicao_id join contrato k on k.id = m.contrato_id
                         where k.obra_id = any($1::uuid[]) and to_char(p.data, 'YYYY-MM') = mes), 0)::float8 as pago
         from meses order by mes`, [ids, inicioSerie, `${h.slice(0, 7)}-01`])).rows : [];

    // Agenda de vencimentos: vencidos e os próximos 60 dias.
    const ate = somarDias(h, 60);
    const vencimentos: Vencimento[] = [];
    if (pode(a, "contrato.ver")) {
      for (const k of contratos.filter((k) => k.situacao === "vigente" && k.vigenciaFim && k.vigenciaFim <= ate && ids.includes(k.obraId)))
        vencimentos.push({ data: k.vigenciaFim!, tipo: "Vigência do contrato", descricao: `Contrato ${k.numero} · ${k.empresaNome ?? "execução direta"}`, obraCodigo: k.obraCodigo, href: `/contratos/${k.id}`, vencido: k.vigenciaFim! < h });
      for (const g of (await c.query(
        `select g.id, to_char(g.vencimento, 'YYYY-MM-DD') as data, g.modalidade, k.id as contrato, k.numero, o.codigo
           from garantia g join contrato k on k.id = g.contrato_id join obra o on o.id = k.obra_id
          where k.situacao = 'vigente' and g.vencimento <= $1 and g.vencimento >= $2::date - 30 and o.id = any($3::uuid[])`, [ate, h, ids])).rows)
        vencimentos.push({ data: g.data, tipo: "Garantia contratual", descricao: `Contrato ${g.numero} · ${g.modalidade.replace(/_/g, " ")}`, obraCodigo: g.codigo, href: `/contratos/${g.contrato}`, vencido: g.data < h });
    }
    for (const d of docs?.vencimentos ?? []) {
      if (d.validade && d.validade <= ate && ids.includes(d.obraId))
        vencimentos.push({ data: d.validade, tipo: d.categoria === "art_rrt" ? "ART ou RRT" : "Documento", descricao: d.titulo, obraCodigo: d.obraCodigo, href: `/documentos/${d.id}`, vencido: d.validade < h });
    }
    if (pode(a, "equipes.ver")) {
      for (const p of (await c.query(
        `select p.id, p.nome, t.descricao, to_char(t.validade, 'YYYY-MM-DD') as data,
                (select o.codigo from alocacao_pessoa x join obra o on o.id = x.obra_id where x.pessoa_id = p.id and x.inicio <= hoje_local()
                   and coalesce(x.fim, 'infinity'::date) >= hoje_local() limit 1) as codigo
           from pessoa p join lateral (select distinct on (h.tipo, h.descricao) h.descricao, h.validade from habilitacao h
                                        where h.pessoa_id = p.id and (h.tipo = 'aso' or h.obrigatorio) order by h.tipo, h.descricao, h.validade desc) t on true
          where p.ativa and t.validade <= $1 and t.validade >= $2::date - 60`, [ate, h])).rows)
        vencimentos.push({ data: p.data, tipo: "ASO ou treinamento", descricao: `${p.nome} · ${p.descricao}`, obraCodigo: p.codigo, href: `/equipes/pessoas/${p.id}`, vencido: p.data < h });
      for (const d of (await c.query(
        `select e.razao_social as empresa, d.tipo, to_char(d.validade, 'YYYY-MM-DD') as data
           from (select distinct on (x.empresa_id, x.tipo) x.* from documento_empresa x order by x.empresa_id, x.tipo, x.validade desc) d
           join empresa e on e.id = d.empresa_id where e.ativa and d.validade <= $1 and d.validade >= $2::date - 60`, [ate, h])).rows)
        vencimentos.push({ data: d.data, tipo: "Certidão de empresa", descricao: `${d.empresa} · ${d.tipo === "cnd_federal" ? "CND federal" : d.tipo === "fgts" ? "FGTS" : d.tipo === "trabalhista" ? "certidão trabalhista" : d.tipo}`, obraCodigo: null, href: "/equipes", vencido: d.data < h });
      for (const q of (await c.query(
        `select q.id, q.descricao, t.proxima from equipamento q
           join lateral (select to_char(m.proxima_revisao, 'YYYY-MM-DD') as proxima from manutencao m where m.equipamento_id = q.id order by m.data desc, m.criado_em desc limit 1) t on true
          where q.ativo and t.proxima <= $1`, [ate])).rows)
        vencimentos.push({ data: q.proxima, tipo: "Revisão de equipamento", descricao: q.descricao, obraCodigo: null, href: `/equipes/equipamentos/${q.id}`, vencido: q.proxima < h });
    }
    vencimentos.sort((x, y) => x.data.localeCompare(y.data));

    const porNivel: Record<Nivel, number> = { verde: 0, amarelo: 0, vermelho: 0 };
    const porSituacao: Partial<Record<Situacao, number>> = {};
    for (const o of obras) { porNivel[o.nivel]++; porSituacao[o.situacao] = (porSituacao[o.situacao] ?? 0) + 1; }
    const totais = obras.reduce((t, o) => ({ contratado: t.contratado + o.contratado, medido: t.medido + o.medido, pago: t.pago + o.pago, aPagar: t.aPagar + o.aPagar, saldo: 0 }),
      { contratado: 0, medido: 0, pago: 0, aPagar: 0, saldo: 0 });
    totais.saldo = obras.reduce((t, o) => t + o.saldo, 0);
    const ordem: Record<Nivel, number> = { vermelho: 0, amarelo: 1, verde: 2 };
    obras.sort((x, y) => ordem[x.nivel] - ordem[y.nivel] || y.motivos.length - x.motivos.length || x.codigo.localeCompare(y.codigo));
    return {
      obras, totais, porNivel, porSituacao, mensal, vencimentos,
      unidades: (await c.query("select id, sigla || ' · ' || nome as nome from unidade order by sigla")).rows,
      filtros,
    };
  });
}
