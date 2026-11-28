import { comContexto, ErroDeRegra } from "../lib/db";
import { ctxCampo, diasSemAcidente, hoje, inicioDaObraSql, obraNoAcesso, obrasVisiveis, ROTULO_CLIMA, ROTULO_CONDICAO, uuid, type Clima, type Condicao } from "./campo";
import { listarContratos } from "./contratos";
import { painelGerencial, type Motivo, type Nivel } from "./gerencial";
import type { Ator } from "./obras";
import { exigir, pode } from "./permissoes";
import { ROTULO_FORMA, ROTULO_PAPEL, ROTULO_SITUACAO, ROTULO_TIPO, type FormaExecucao, type Papel, type Situacao, type TipoObra } from "./rotulos";

export type ObraNoMapa = {
  id: string; codigo: string; nome: string; tipo: TipoObra; situacao: Situacao;
  municipio: string | null; uf: string | null; endereco: string | null;
  latitude: number | null; longitude: number | null;
  ultimoDiario: string | null;
  nivel: Nivel | null; motivos: Motivo[]; executadoPct: number | null; contratado: number | null;
  areaM2: number | null; previstoPct: number | null; realizadoPct: number | null;
};
export type MapaObras = { obras: ObraNoMapa[]; comSemaforo: boolean; podeEditar: boolean };

/** Todas as obras no acesso do usuário, com o local e a situação. O semáforo vem do painel gerencial, para quem o vê. */
export async function mapaObras(a: Ator): Promise<MapaObras> {
  const comSemaforo = pode(a, "gerencial.ver");
  const painel = comSemaforo ? await painelGerencial(a) : null;
  const porId = new Map((painel?.obras ?? []).map((o) => [o.id, o]));
  const linhas = await comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "o.id", 1);
    return (await c.query(
      `select o.id, o.codigo, o.nome, o.tipo, o.situacao, o.municipio, o.uf, o.endereco, o.area_m2::float8 as "areaM2",
              o.latitude::float8 as latitude, o.longitude::float8 as longitude,
              ${pode(a, "diario.ver") ? "(select to_char(max(d.data), 'YYYY-MM-DD') from diario d where d.obra_id = o.id)" : "null::text"} as "ultimoDiario"
         from obra o where o.situacao <> 'cancelada' and ${v.sql} order by o.codigo`, v.params)).rows;
  });
  return {
    comSemaforo,
    podeEditar: pode(a, "obra.editar"),
    obras: linhas.map((l) => {
      const g = porId.get(l.id);
      return {
        ...l,
        nivel: g?.nivel ?? null, motivos: g?.motivos.slice(0, 3) ?? [],
        executadoPct: g && g.contratado > 0 ? g.executadoPct : null, contratado: g && g.contratado > 0 ? g.contratado : null,
        previstoPct: g?.previstoPct ?? null, realizadoPct: g?.realizadoPct ?? null,
      };
    }),
  };
}

/** Coordenadas aceitas: dentro do Brasil, com folga. */
export function localValido(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -34.5 && lat <= 6 && lon >= -74.5 && lon <= -28.5;
}

/** Marca a obra no mapa. */
export async function definirLocal(a: Ator, obraId: string, lat: number, lon: number) {
  exigir(a, "obra.editar");
  if (!uuid(obraId)) throw new ErroDeRegra("Obra não encontrada.");
  if (!localValido(lat, lon)) throw new ErroDeRegra("O ponto marcado fica fora do Brasil.");
  await comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    await c.query("update obra set latitude = $2, longitude = $3 where id = $1", [obraId, Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6]);
  });
}

// ---------------------------------------------------------------------------
// Ficha da obra (aberta ao clicar no mapa)
// ---------------------------------------------------------------------------
export type FichaObra = {
  id: string; codigo: string; nome: string; tipo: string; forma: string; situacao: string;
  endereco: string | null; municipio: string | null; uf: string | null; latitude: number | null; longitude: number | null;
  areaM2: number | null; extensaoM: number | null; fonteRecurso: string | null; convenio: string | null; processo: string | null; licitacao: string | null;
  art: string | null; ordemServico: string | null; ordemServicoData: string | null; inicioPrevisto: string | null; fimPrevisto: string | null;
  responsaveis: { nome: string; papel: string }[];
  contratos: {
    id: string; numero: string; empresa: string | null; cnpj: string | null; objeto: string; situacao: string;
    valor: number; medido: number; pago: number; saldo: number; executadoPct: number;
    terminoPrevisto: string | null; vigenciaFim: string | null; diasParaVencer: number | null; aditivos: number; gestor: string | null; fiscal: string | null;
  }[] | null;
  diario: {
    ultimo: { id: string; numero: number; data: string; situacao: string; visto: boolean; clima: string; condicao: string; efetivo: number; relato: string | null } | null;
    noMes: number; semVisto: number; horasParadas: number; diasChuva: number;
  } | null;
  equipeHoje: { pessoas: number; equipamentos: number } | null;
  qualidade: { abertas: number; graves: number; vencidas: number } | null;
  seguranca: { diasSemAcidente: number | null; ultimoAcidente: string | null; abertas: number } | null;
  fotos: { id: string; legenda: string | null; em: string; latitude: number | null; longitude: number | null }[];
};

const somarDiasIso = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Tudo o que se sabe da obra, para a ficha do mapa. Cada parte só aparece para quem tem acesso ao módulo. */
export async function fichaDaObra(a: Ator, obraId: string): Promise<FichaObra> {
  if (!uuid(obraId)) throw new ErroDeRegra("Obra não encontrada.");
  const contratos = pode(a, "contrato.ver") ? await listarContratos(a, { obraId }) : null;
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    const h = hoje();
    const o = (await c.query(
      `select id, codigo, nome, tipo, forma_execucao, situacao, endereco, municipio, uf, latitude::float8 as latitude, longitude::float8 as longitude,
              area_m2::float8 as "areaM2", extensao_m::float8 as "extensaoM", fonte_recurso as "fonteRecurso", convenio, processo_administrativo as processo,
              licitacao, art_numero as art, ordem_servico_numero as "ordemServico", to_char(ordem_servico_data, 'YYYY-MM-DD') as "ordemServicoData",
              to_char(data_inicio_prevista, 'YYYY-MM-DD') as "inicioPrevisto", to_char(data_fim_prevista, 'YYYY-MM-DD') as "fimPrevisto"
         from obra where id = $1`, [obraId])).rows[0];
    const responsaveis = (await c.query(
      `select u.nome, v.papel from vinculo_obra v join usuario u on u.id = v.usuario_id
        where v.obra_id = $1 and (v.fim is null or v.fim >= hoje_local()) order by v.papel, u.nome`, [obraId])).rows
      .map((r) => ({ nome: r.nome as string, papel: ROTULO_PAPEL[r.papel as Papel] ?? r.papel }));

    let diario: FichaObra["diario"] = null;
    if (pode(a, "diario.ver")) {
      const u = (await c.query(
        `select d.id, d.numero, to_char(d.data, 'YYYY-MM-DD') as data, d.situacao, d.visto_em is not null as visto, d.clima_manha, d.clima_tarde, d.condicao, d.relato,
                coalesce((select sum(quantidade) from diario_efetivo where diario_id = d.id), 0)::int as efetivo
           from diario d where d.obra_id = $1 order by d.data desc limit 1`, [obraId])).rows[0];
      const t = (await c.query(
        `select count(*) filter (where to_char(d.data, 'YYYY-MM') = $2)::int as "noMes",
                count(*) filter (where d.situacao = 'assinado' and d.visto_em is null)::int as "semVisto",
                count(*) filter (where d.clima_manha in ('chuva_fraca', 'chuva_forte') or d.clima_tarde in ('chuva_fraca', 'chuva_forte'))::int as "diasChuva",
                coalesce((select sum(x.horas) from diario_ocorrencia x join diario y on y.id = x.diario_id where y.obra_id = $1 and x.tipo = 'paralisacao'), 0)::float8 as "horasParadas"
           from diario d where d.obra_id = $1`, [obraId, h.slice(0, 7)])).rows[0];
      diario = {
        ultimo: u ? {
          id: u.id, numero: u.numero, data: u.data, situacao: u.situacao === "assinado" ? "Assinado" : "Em elaboração", visto: u.visto,
          clima: u.clima_manha === u.clima_tarde ? ROTULO_CLIMA[u.clima_manha as Clima] : `${ROTULO_CLIMA[u.clima_manha as Clima]} de manhã, ${ROTULO_CLIMA[u.clima_tarde as Clima].toLowerCase()} à tarde`,
          condicao: ROTULO_CONDICAO[u.condicao as Condicao], efetivo: u.efetivo, relato: u.relato ? String(u.relato).slice(0, 400) : null,
        } : null,
        ...t,
      };
    }
    const equipeHoje = pode(a, "equipes.ver") ? (await c.query(
      `select (select count(*)::int from alocacao_pessoa x where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2) as pessoas,
              (select count(*)::int from alocacao_equipamento x where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2) as equipamentos`,
      [obraId, h])).rows[0] : null;
    const qualidade = pode(a, "qualidade.ver") ? (await c.query(
      `select count(*) filter (where situacao in ('aberta', 'corrigida'))::int as abertas,
              count(*) filter (where situacao in ('aberta', 'corrigida') and (gravidade = 'grave' or impeditiva))::int as graves,
              count(*) filter (where situacao in ('aberta', 'corrigida') and prazo < $2::date)::int as vencidas
         from nao_conformidade where obra_id = $1`, [obraId, h])).rows[0] : null;
    let seguranca: FichaObra["seguranca"] = null;
    if (pode(a, "seguranca.ver")) {
      const s = (await c.query(
        `select to_char(max(data) filter (where tipo in ('acidente_com_afastamento', 'acidente_sem_afastamento')), 'YYYY-MM-DD') as ultimo,
                count(*) filter (where situacao <> 'encerrada')::int as abertas,
                (select ${inicioDaObraSql("o")} from obra o where o.id = $1) as inicio
           from ocorrencia_seguranca where obra_id = $1`, [obraId])).rows[0];
      seguranca = { diasSemAcidente: diasSemAcidente(s.ultimo, s.inicio, h), ultimoAcidente: s.ultimo, abertas: s.abertas };
    }
    const fotos = pode(a, "diario.ver") || pode(a, "qualidade.ver") || pode(a, "seguranca.ver") ? (await c.query(
      `select id, legenda, coalesce(tirada_em, criado_em) as em, latitude::float8 as latitude, longitude::float8 as longitude
         from foto where obra_id = $1 order by coalesce(tirada_em, criado_em) desc limit 8`, [obraId])).rows : [];

    return {
      ...o, tipo: ROTULO_TIPO[o.tipo as TipoObra] ?? o.tipo, forma: ROTULO_FORMA[o.forma_execucao as FormaExecucao] ?? o.forma_execucao,
      situacao: ROTULO_SITUACAO[o.situacao as Situacao] ?? o.situacao,
      responsaveis,
      contratos: contratos ? contratos.filter((k) => k.situacao !== "rascunho").map((k) => ({
        id: k.id, numero: k.numero, empresa: k.empresaNome, cnpj: k.empresaCnpj, objeto: k.objeto, situacao: k.situacao,
        valor: Number(k.valorAtual), medido: Number(k.medido), pago: Number(k.pago), saldo: Number(k.saldo), executadoPct: k.executadoPct,
        terminoPrevisto: k.dataOrdemServico && k.prazoExecucaoDias ? somarDiasIso(k.dataOrdemServico, k.prazoExecucaoDias) : null,
        vigenciaFim: k.vigenciaFim, diasParaVencer: k.diasParaVencer, aditivos: k.aditivosAssinados, gestor: k.gestorNome, fiscal: k.fiscalNome,
      })) : null,
      diario, equipeHoje, qualidade, seguranca,
      fotos: fotos.map((f) => ({ ...f, em: new Date(f.em).toISOString() })),
    };
  });
}
