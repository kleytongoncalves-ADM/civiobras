import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra } from "../lib/db";
import { lerNumeroBr, lerValorBr, texto } from "../lib/decimal";
import { ctxCampo, dataValida, exigirVer, hoje, limpo, obraNoAcesso, obrasVisiveis, uuid, type ObraCampo } from "./campo";
import type { Ator } from "./obras";
import { exigir, pode } from "./permissoes";
import { itensDaObra, type ItemObra } from "./qualidade";

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------
export type SituacaoRequisicao = "rascunho" | "enviada" | "aprovada" | "recusada" | "cancelada";
export type SituacaoPedido = "emitido" | "parcial" | "recebido" | "cancelado";
export type TipoMovimento = "entrada" | "saida" | "perda" | "ajuste_entrada" | "ajuste_saida" | "transferencia_saida" | "transferencia_entrada";

export const ROTULO_REQUISICAO: Record<SituacaoRequisicao, string> = {
  rascunho: "Em elaboração", enviada: "Aguardando aprovação", aprovada: "Aprovada", recusada: "Recusada", cancelada: "Cancelada",
};
export const ROTULO_PEDIDO: Record<SituacaoPedido, string> = { emitido: "Emitido", parcial: "Parcial", recebido: "Recebido", cancelado: "Cancelado" };
export const ROTULO_MOVIMENTO: Record<TipoMovimento, string> = {
  entrada: "Entrada", saida: "Saída para serviço", perda: "Perda", ajuste_entrada: "Ajuste de inventário (+)", ajuste_saida: "Ajuste de inventário (−)",
  transferencia_saida: "Transferência enviada", transferencia_entrada: "Transferência recebida",
};
export const MOVIMENTOS_MANUAIS: TipoMovimento[] = ["saida", "perda", "ajuste_entrada", "ajuste_saida", "transferencia_saida"];
const SAI = new Set<TipoMovimento>(["saida", "perda", "ajuste_saida", "transferencia_saida"]);

/** Quantidade positiva vinda do formulário (aceita 1.234,5 ou 1234.5), como texto para o banco. */
export function quantidade(v: string | number | null | undefined, rotulo = "Quantidade", zeroOk = false): string {
  const d = lerNumeroBr(String(v ?? ""));
  if (d == null || d < 0n || (!zeroOk && d === 0n)) throw new ErroDeRegra(`${rotulo} inválida.`);
  return texto(d, 4);
}
const preco = (v: string | number | null | undefined, rotulo = "Preço") => {
  const d = lerValorBr(String(v ?? ""));
  if (d == null || d <= 0n) throw new ErroDeRegra(`${rotulo} inválido.`);
  return texto(d, 4);
};

// ---------------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------------
export type Material = { id: string; codigo: string | null; descricao: string; unidade: string; grupo: string | null; perdaPrevista: number; ativo: boolean; obras: number };

export async function listarMateriais(a: Ator, busca?: string): Promise<Material[]> {
  exigirVer(a, "suprimentos.ver");
  const b = limpo(busca);
  return comContexto(ctxCampo(a), async (c) => (await c.query(
    `select m.id, m.codigo, m.descricao, m.unidade, m.grupo, m.perda_prevista::float8 as "perdaPrevista", m.ativo,
            (select count(distinct obra_id)::int from movimento_estoque x where x.material_id = m.id) as obras
       from material m
      where ($1::text is null or m.descricao ilike '%' || $1 || '%' or m.codigo ilike $1 || '%')
      order by m.ativo desc, m.grupo nulls last, m.descricao limit 500`, [b])).rows);
}

export type DadosMaterial = { codigo?: string | null; descricao: string; unidade: string; grupo?: string | null; perdaPrevista?: string | number | null; ativo?: boolean };

export async function salvarMaterial(a: Ator, id: string | null, d: DadosMaterial): Promise<string> {
  exigir(a, "suprimentos.comprar");
  if (!limpo(d.descricao)) throw new ErroDeRegra("Informe a descrição.");
  if (!limpo(d.unidade)) throw new ErroDeRegra("Informe a unidade.");
  const perda = d.perdaPrevista == null || d.perdaPrevista === "" ? "5" : quantidade(d.perdaPrevista, "Perda prevista", true);
  if (Number(perda) > 100) throw new ErroDeRegra("Perda prevista acima de 100%.");
  return comContexto(ctxCampo(a), async (c) => {
    try {
      if (id) {
        if (!uuid(id)) throw new ErroDeRegra("Material não encontrado.");
        const r = await c.query("update material set codigo = $2, descricao = $3, unidade = $4, grupo = $5, perda_prevista = $6, ativo = $7 where id = $1 returning id",
          [id, limpo(d.codigo), limpo(d.descricao), limpo(d.unidade), limpo(d.grupo), perda, d.ativo ?? true]);
        if (!r.rows[0]) throw new ErroDeRegra("Material não encontrado.");
        return id;
      }
      return (await c.query("insert into material (orgao_id, codigo, descricao, unidade, grupo, perda_prevista) values ($1,$2,$3,$4,$5,$6) returning id",
        [a.orgaoId, limpo(d.codigo), limpo(d.descricao), limpo(d.unidade), limpo(d.grupo), perda])).rows[0].id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ErroDeRegra("Já existe um material com este código ou descrição.");
      throw e;
    }
  });
}

/** Traz para o catálogo os materiais do orçamento aprovado da obra. */
export async function importarDoOrcamento(a: Ator, obraId: string): Promise<number> {
  exigir(a, "suprimentos.requisitar");
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    const r = await c.query(
      `insert into material (orgao_id, codigo, descricao, unidade)
       select distinct on (x.codigo) $1::uuid, x.codigo, x.descricao, x.unidade
         from orcamento o join orcamento_item oi on oi.orcamento_id = o.id
         join orcamento_item_insumo x on x.item_id = oi.id and x.tipo = 'material'
        where o.obra_id = $2 and o.situacao = 'aprovado'
          and not exists (select 1 from material m where m.codigo = x.codigo)
        order by x.codigo
       on conflict do nothing`, [a.orgaoId, obraId]);
    return r.rowCount ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Painel da obra
// ---------------------------------------------------------------------------
export type LinhaEstoque = {
  materialId: string; codigo: string | null; descricao: string; unidade: string; perdaPrevista: number;
  previsto: number; requisitado: number; recebido: number; consumido: number; perdas: number;
  saldo: number; custoMedio: number; valor: number; minimo: number | null; abaixoMinimo: boolean;
};
export type ResumoRequisicao = {
  id: string; numero: number; data: string; necessidade: string; situacao: SituacaoRequisicao; itens: number; criadoPor: string | null;
  pedidos: number; atrasada: boolean;
};
export type ResumoPedido = {
  id: string; numero: number; data: string; prazoEntrega: string; situacao: SituacaoPedido; fornecedor: string; total: number; atrasado: boolean; requisicaoNumero: number;
};
export type Movimento = {
  id: string; data: string; tipo: TipoMovimento; material: string; unidade: string; quantidade: number; custoUnitario: number; valor: number;
  item: string | null; destino: string | null; observacao: string | null; por: string | null;
};
export type LinhaPerda = { itemNumero: string; itemDescricao: string; material: string; unidade: string; real: number; teorico: number; perda: number | null; prevista: number; acima: boolean };

export type PainelSuprimentos = {
  obra: ObraCampo; temOrcamento: boolean; estoque: LinhaEstoque[]; requisicoes: ResumoRequisicao[]; pedidos: ResumoPedido[];
  movimentos: Movimento[]; perdas: LinhaPerda[]; itens: ItemObra[]; materiais: { id: string; descricao: string; unidade: string; codigo: string | null }[];
  destinos: { id: string; codigo: string; nome: string }[];
  valorEstoque: number; consumoMateriais: number; abaixoMinimo: number; aguardando: number; atrasados: number; semCatalogo: number;
  podeRequisitar: boolean; podeEstoque: boolean; podeComprar: boolean;
};

const ESTOQUE_SQL = `
  with prev as (
    select m.id as material_id, sum(oi.quantidade * x.coeficiente) as previsto
      from orcamento o join orcamento_item oi on oi.orcamento_id = o.id
      join orcamento_item_insumo x on x.item_id = oi.id and x.tipo = 'material'
      join material m on m.codigo = x.codigo
     where o.obra_id = $1 and o.situacao = 'aprovado' group by m.id),
  mov as (
    select material_id, sum(sinal_movimento(tipo) * quantidade) as saldo, sum(sinal_movimento(tipo) * quantidade * custo_unitario) as valor,
           coalesce(sum(quantidade) filter (where tipo in ('entrada', 'transferencia_entrada')), 0) as recebido,
           coalesce(sum(quantidade) filter (where tipo = 'saida'), 0) as consumido,
           coalesce(sum(quantidade) filter (where tipo = 'perda'), 0) as perdas
      from movimento_estoque where obra_id = $1 group by material_id),
  req as (
    select i.material_id, sum(i.quantidade) as requisitado from requisicao_item i join requisicao r on r.id = i.requisicao_id
     where r.obra_id = $1 and r.situacao not in ('recusada', 'cancelada', 'rascunho') group by i.material_id)
  select m.id as "materialId", m.codigo, m.descricao, m.unidade, m.perda_prevista::float8 as "perdaPrevista",
         coalesce(prev.previsto, 0)::float8 as previsto, coalesce(req.requisitado, 0)::float8 as requisitado,
         coalesce(mov.recebido, 0)::float8 as recebido, coalesce(mov.consumido, 0)::float8 as consumido, coalesce(mov.perdas, 0)::float8 as perdas,
         coalesce(mov.saldo, 0)::float8 as saldo, coalesce(mov.valor, 0)::float8 as valor,
         case when coalesce(mov.saldo, 0) > 0 then (mov.valor / mov.saldo)::float8 else 0 end as "custoMedio",
         em.quantidade::float8 as minimo
    from material m
    left join prev on prev.material_id = m.id left join mov on mov.material_id = m.id left join req on req.material_id = m.id
    left join estoque_minimo em on em.material_id = m.id and em.obra_id = $1
   where prev.material_id is not null or mov.material_id is not null or em.id is not null or req.material_id is not null
   order by m.descricao`;

async function estoqueDaObra(c: PoolClient, obraId: string): Promise<LinhaEstoque[]> {
  return (await c.query(ESTOQUE_SQL, [obraId])).rows.map((r) => ({ ...r, abaixoMinimo: r.minimo != null && r.saldo < r.minimo }));
}

/** completo: sem limite de linhas, para planilha e relatório. A tela mostra os 80 movimentos mais recentes. */
export async function painelSuprimentos(a: Ator, obraId: string, completo = false): Promise<PainelSuprimentos> {
  exigirVer(a, "suprimentos.ver");
  return comContexto(ctxCampo(a), async (c) => {
    const obra = await obraNoAcesso(c, a, obraId);
    const estoque = await estoqueDaObra(c, obraId);
    const temOrcamento = !!(await c.query("select 1 from orcamento where obra_id = $1 and situacao = 'aprovado' limit 1", [obraId])).rows[0];
    const semCatalogo = Number((await c.query(
      `select count(distinct x.codigo)::int as n from orcamento o join orcamento_item oi on oi.orcamento_id = o.id
         join orcamento_item_insumo x on x.item_id = oi.id and x.tipo = 'material'
        where o.obra_id = $1 and o.situacao = 'aprovado' and not exists (select 1 from material m where m.codigo = x.codigo)`, [obraId])).rows[0].n);
    const requisicoes = (await c.query(
      `select r.id, r.numero, to_char(r.data, 'YYYY-MM-DD') as data, to_char(r.necessidade, 'YYYY-MM-DD') as necessidade, r.situacao,
              (select count(*)::int from requisicao_item i where i.requisicao_id = r.id) as itens, u.nome as "criadoPor",
              (select count(*)::int from pedido p where p.requisicao_id = r.id and p.situacao <> 'cancelado') as pedidos,
              (r.situacao in ('enviada', 'aprovada') and r.necessidade < hoje_local()
                and not exists (select 1 from pedido p where p.requisicao_id = r.id and p.situacao = 'recebido')) as atrasada
         from requisicao r left join usuario u on u.id = r.criado_por where r.obra_id = $1 order by r.numero desc`, [obraId])).rows;
    const pedidos = await pedidosDe(c, "p.obra_id = $1", [obraId]);
    const movimentos = (await c.query(
      `select x.id, to_char(x.data, 'YYYY-MM-DD') as data, x.tipo, m.descricao as material, m.unidade, x.quantidade::float8 as quantidade,
              x.custo_unitario::float8 as "custoUnitario", (x.quantidade * x.custo_unitario)::float8 as valor,
              case when i.id is not null then i.numero || ' ' || left(i.descricao, 60) end as item,
              coalesce(od.codigo, oo.codigo) as destino, x.observacao, u.nome as por
         from movimento_estoque x join material m on m.id = x.material_id
         left join item_servico i on i.id = x.item_servico_id left join obra od on od.id = x.obra_destino_id
         left join movimento_estoque px on px.id = x.par_id left join obra oo on oo.id = px.obra_id
         left join usuario u on u.id = x.criado_por
        where x.obra_id = $1 order by x.data desc, x.criado_em desc${completo ? "" : " limit 80"}`, [obraId])).rows;
    const perdas = await perdasDaObra(c, obraId);
    const itens = await itensDaObra(c, obraId);
    const materiais = (await c.query("select id, descricao, unidade, codigo from material where ativo order by descricao")).rows;
    const v = obrasVisiveis(a, "o.id", 2);
    const destinos = (await c.query(
      `select o.id, o.codigo, o.nome from obra o where o.id <> $1 and o.situacao in ('em_execucao', 'paralisada') and ${v.sql} order by o.codigo`,
      [obraId, ...v.params])).rows;
    return {
      obra, temOrcamento, estoque, requisicoes, pedidos, movimentos, perdas, itens, materiais, destinos, semCatalogo,
      valorEstoque: estoque.reduce((s, l) => s + l.valor, 0),
      consumoMateriais: Number((await c.query(
        "select coalesce(sum(quantidade * custo_unitario), 0)::float8 as v from movimento_estoque where obra_id = $1 and tipo in ('saida', 'perda')", [obraId])).rows[0].v),
      abaixoMinimo: estoque.filter((l) => l.abaixoMinimo).length,
      aguardando: requisicoes.filter((r) => r.situacao === "enviada").length,
      atrasados: pedidos.filter((p) => p.atrasado).length,
      podeRequisitar: pode(a, "suprimentos.requisitar"), podeEstoque: pode(a, "suprimentos.estoque"), podeComprar: pode(a, "suprimentos.comprar"),
    };
  });
}

async function pedidosDe(c: PoolClient, filtro: string, params: unknown[]): Promise<(ResumoPedido & { obraId: string; obraCodigo: string })[]> {
  return (await c.query(
    `select p.id, p.numero, to_char(p.data, 'YYYY-MM-DD') as data, to_char(p.prazo_entrega, 'YYYY-MM-DD') as "prazoEntrega", p.situacao,
            e.razao_social as fornecedor, r.numero as "requisicaoNumero", p.obra_id as "obraId", o.codigo as "obraCodigo",
            (coalesce((select sum(i.quantidade * i.preco_unitario) from pedido_item i where i.pedido_id = p.id), 0) + p.frete)::float8 as total,
            (p.situacao in ('emitido', 'parcial') and p.prazo_entrega < hoje_local()) as atrasado
       from pedido p join empresa e on e.id = p.empresa_id join requisicao r on r.id = p.requisicao_id join obra o on o.id = p.obra_id
      where ${filtro} order by p.numero desc`, params)).rows;
}

/** Perda por item e material: saídas contra o consumo teórico da composição sobre a quantidade medida. */
async function perdasDaObra(c: PoolClient, obraId: string): Promise<LinhaPerda[]> {
  return (await c.query(
    `with real as (
       select x.item_servico_id, x.material_id, sum(x.quantidade) as real from movimento_estoque x
        where x.obra_id = $1 and x.tipo = 'saida' group by 1, 2),
     medido as (
       select im.item_servico_id, sum(im.quantidade) as q from item_medido im join medicao md on md.id = im.medicao_id
        where md.situacao <> 'cancelada' group by 1)
     select i.numero as "itemNumero", i.descricao as "itemDescricao", m.descricao as material, m.unidade,
            r.real::float8 as real, m.perda_prevista::float8 as prevista,
            (coalesce(md.q, 0) * coalesce((select sum(y.coeficiente) from orcamento_item_insumo y where y.item_id = i.orcamento_item_id and y.codigo = m.codigo), 0))::float8 as teorico
       from real r join item_servico i on i.id = r.item_servico_id join material m on m.id = r.material_id
       left join medido md on md.item_servico_id = i.id
      order by i.ordem, m.descricao`, [obraId])).rows.map((l) => {
    const perda = l.teorico > 0 ? ((l.real - l.teorico) / l.teorico) * 100 : null;
    return { ...l, perda, acima: perda != null && perda > l.prevista };
  });
}

// ---------------------------------------------------------------------------
// Requisição
// ---------------------------------------------------------------------------
export async function criarRequisicao(a: Ator, obraId: string, d: { necessidade: string; observacao?: string | null }): Promise<string> {
  exigir(a, "suprimentos.requisitar");
  if (!dataValida(d.necessidade) || d.necessidade < hoje()) throw new ErroDeRegra("Informe a data em que o material é necessário.");
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    return (await c.query("insert into requisicao (orgao_id, obra_id, necessidade, observacao) values ($1,$2,$3,$4) returning id",
      [a.orgaoId, obraId, d.necessidade, limpo(d.observacao)])).rows[0].id;
  });
}

async function requisicaoNoAcesso(c: PoolClient, a: Ator, id: string) {
  if (!uuid(id)) throw new ErroDeRegra("Requisição não encontrada.");
  const r = (await c.query("select id, obra_id, situacao, criado_por from requisicao where id = $1 for update", [id])).rows[0];
  if (!r) throw new ErroDeRegra("Requisição não encontrada.");
  await obraNoAcesso(c, a, r.obra_id);
  return r as { id: string; obra_id: string; situacao: SituacaoRequisicao; criado_por: string };
}

export async function adicionarItemRequisicao(a: Ator, requisicaoId: string, d: { materialId: string; quantidade: string; itemServicoId?: string | null; justificativa?: string | null }) {
  exigir(a, "suprimentos.requisitar");
  if (!uuid(d.materialId)) throw new ErroDeRegra("Escolha o material.");
  const q = quantidade(d.quantidade);
  await comContexto(ctxCampo(a), async (c) => {
    await requisicaoNoAcesso(c, a, requisicaoId);
    try {
      await c.query(
        `insert into requisicao_item (orgao_id, requisicao_id, material_id, quantidade, item_servico_id, justificativa) values ($1,$2,$3,$4,$5,$6)
         on conflict (requisicao_id, material_id) do update set quantidade = requisicao_item.quantidade + excluded.quantidade,
           item_servico_id = coalesce(excluded.item_servico_id, requisicao_item.item_servico_id),
           justificativa = coalesce(excluded.justificativa, requisicao_item.justificativa)`,
        [a.orgaoId, requisicaoId, d.materialId, q, uuid(d.itemServicoId) ? d.itemServicoId : null, limpo(d.justificativa)]);
    } catch (e) {
      if ((e as { code?: string }).code === "23503") throw new ErroDeRegra("Material não encontrado.");
      throw e;
    }
  });
}

export async function removerItemRequisicao(a: Ator, itemId: string) {
  exigir(a, "suprimentos.requisitar");
  if (!uuid(itemId)) throw new ErroDeRegra("Item não encontrado.");
  await comContexto(ctxCampo(a), async (c) => {
    const i = (await c.query("select requisicao_id from requisicao_item where id = $1", [itemId])).rows[0];
    if (!i) throw new ErroDeRegra("Item não encontrado.");
    await requisicaoNoAcesso(c, a, i.requisicao_id);
    await c.query("delete from requisicao_item where id = $1", [itemId]);
  });
}

export async function enviarRequisicao(a: Ator, id: string) {
  exigir(a, "suprimentos.requisitar");
  await comContexto(ctxCampo(a), async (c) => {
    const r = await requisicaoNoAcesso(c, a, id);
    if (r.situacao !== "rascunho") throw new ErroDeRegra("A requisição já foi enviada.");
    await c.query("update requisicao set situacao = 'enviada' where id = $1", [id]);
  });
}

export async function decidirRequisicao(a: Ator, id: string, aprovar: boolean, motivo?: string | null) {
  exigir(a, "suprimentos.aprovar");
  if (!aprovar && !limpo(motivo)) throw new ErroDeRegra("Informe o motivo da recusa.");
  await comContexto(ctxCampo(a), async (c) => {
    const r = await requisicaoNoAcesso(c, a, id);
    if (r.situacao !== "enviada") throw new ErroDeRegra("A requisição não está aguardando aprovação.");
    await c.query("update requisicao set situacao = $2, motivo = $3 where id = $1", [id, aprovar ? "aprovada" : "recusada", aprovar ? null : limpo(motivo)]);
  });
}

export async function cancelarRequisicao(a: Ator, id: string, motivo: string) {
  if (!pode(a, "suprimentos.requisitar") && !pode(a, "suprimentos.aprovar")) exigir(a, "suprimentos.requisitar");
  if (!limpo(motivo)) throw new ErroDeRegra("Informe o motivo do cancelamento.");
  await comContexto(ctxCampo(a), async (c) => {
    const r = await requisicaoNoAcesso(c, a, id);
    if (!["rascunho", "enviada", "aprovada"].includes(r.situacao)) throw new ErroDeRegra("A requisição não pode ser cancelada.");
    await c.query("update requisicao set situacao = 'cancelada', motivo = $2 where id = $1", [id, limpo(motivo)]);
  });
}

export type ItemRequisicao = {
  id: string; materialId: string; codigo: string | null; descricao: string; unidade: string; quantidade: number; previsto: number; requisitadoTotal: number;
  itemServico: string | null; justificativa: string | null; referencia: number | null; pedidoNumero: number | null; pedidoId: string | null;
};
export type CotacaoResumo = {
  id: string; empresaId: string; fornecedor: string; cnpj: string; data: string; validade: string | null; prazoEntrega: number | null;
  condicaoPagamento: string | null; frete: number; observacao: string | null; precos: Record<string, number>; total: number; itensCotados: number;
  vencida: boolean; pedidoId: string | null;
};
export type RequisicaoCompleta = {
  id: string; obraId: string; numero: number; data: string; necessidade: string; observacao: string | null; situacao: SituacaoRequisicao;
  motivo: string | null; criadoPor: string | null; criadoPorId: string | null; criadoEm: Date; enviadaEm: Date | null; decididaPor: string | null; decididaEm: Date | null;
  obra: ObraCampo; itens: ItemRequisicao[]; cotacoes: CotacaoResumo[]; menor: Record<string, number>; pedidos: ResumoPedido[];
  fornecedores: { id: string; razaoSocial: string }[]; materiais: { id: string; descricao: string; unidade: string; codigo: string | null }[]; itensObra: ItemObra[];
  podeEditar: boolean; podeDecidir: boolean; podeCancelar: boolean; podeCotar: boolean;
};

export async function obterRequisicao(a: Ator, id: string): Promise<RequisicaoCompleta> {
  exigirVer(a, "suprimentos.ver");
  if (!uuid(id)) throw new ErroDeRegra("Requisição não encontrada.");
  return comContexto(ctxCampo(a), async (c) => {
    const r = (await c.query(
      `select r.id, r.obra_id as "obraId", r.numero, to_char(r.data, 'YYYY-MM-DD') as data, to_char(r.necessidade, 'YYYY-MM-DD') as necessidade,
              r.observacao, r.situacao, r.motivo, u.nome as "criadoPor", r.criado_por as "criadoPorId", r.criado_em as "criadoEm", r.enviada_em as "enviadaEm",
              ud.nome as "decididaPor", r.decidida_em as "decididaEm"
         from requisicao r left join usuario u on u.id = r.criado_por left join usuario ud on ud.id = r.decidida_por where r.id = $1`, [id])).rows[0];
    if (!r) throw new ErroDeRegra("Requisição não encontrada.");
    const obra = await obraNoAcesso(c, a, r.obraId);
    const itens = (await c.query(
      `select i.id, i.material_id as "materialId", m.codigo, m.descricao, m.unidade, i.quantidade::float8 as quantidade, i.justificativa,
              previsto_material($2, m.id)::float8 as previsto,
              (select coalesce(sum(j.quantidade), 0) from requisicao_item j join requisicao q on q.id = j.requisicao_id
                where q.obra_id = $2 and j.material_id = m.id and q.situacao not in ('recusada', 'cancelada'))::float8 as "requisitadoTotal",
              case when s.id is not null then s.numero || ' ' || left(s.descricao, 60) end as "itemServico",
              (select (sum(x.preco * oi.quantidade * x.coeficiente) / nullif(sum(oi.quantidade * x.coeficiente), 0))::float8
                 from orcamento o join orcamento_item oi on oi.orcamento_id = o.id join orcamento_item_insumo x on x.item_id = oi.id
                where o.obra_id = $2 and o.situacao = 'aprovado' and x.codigo = m.codigo and x.tipo = 'material') as referencia,
              (select p.numero from pedido_item pi join pedido p on p.id = pi.pedido_id where pi.requisicao_item_id = i.id and p.situacao <> 'cancelado') as "pedidoNumero",
              (select p.id from pedido_item pi join pedido p on p.id = pi.pedido_id where pi.requisicao_item_id = i.id and p.situacao <> 'cancelado') as "pedidoId"
         from requisicao_item i join material m on m.id = i.material_id left join item_servico s on s.id = i.item_servico_id
        where i.requisicao_id = $1 order by m.descricao`, [id, r.obraId])).rows as ItemRequisicao[];
    const cot = (await c.query(
      `select c.id, c.empresa_id as "empresaId", e.razao_social as fornecedor, e.cnpj, to_char(c.data, 'YYYY-MM-DD') as data,
              to_char(c.validade, 'YYYY-MM-DD') as validade, c.prazo_entrega as "prazoEntrega", c.condicao_pagamento as "condicaoPagamento",
              c.frete::float8 as frete, c.observacao, (c.validade is not null and c.validade < hoje_local()) as vencida,
              (select p.id from pedido p where p.cotacao_id = c.id and p.situacao <> 'cancelado' limit 1) as "pedidoId",
              coalesce((select json_object_agg(ci.requisicao_item_id, ci.preco_unitario::float8) from cotacao_compra_item ci where ci.cotacao_id = c.id), '{}') as precos
         from cotacao_compra c join empresa e on e.id = c.empresa_id where c.requisicao_id = $1 order by c.criado_em`, [id])).rows;
    const qtd = new Map(itens.map((i) => [i.id, i.quantidade]));
    const cotacoes: CotacaoResumo[] = cot.map((x) => {
      const precos = x.precos as Record<string, number>;
      const total = Object.entries(precos).reduce((s, [k, p]) => s + p * (qtd.get(k) ?? 0), 0) + x.frete;
      return { ...x, precos, total, itensCotados: Object.keys(precos).length };
    });
    const menor: Record<string, number> = {};
    for (const i of itens) {
      const ps = cotacoes.filter((x) => !x.vencida).map((x) => x.precos[i.id]).filter((p): p is number => p != null);
      if (ps.length) menor[i.id] = Math.min(...ps);
    }
    const pedidos = await pedidosDe(c, "p.requisicao_id = $1", [id]);
    const fornecedores = pode(a, "suprimentos.comprar")
      ? (await c.query("select id, razao_social as \"razaoSocial\" from empresa where ativa and tipo in ('fornecedor', 'contratada') order by tipo desc, razao_social")).rows : [];
    const rascunho = r.situacao === "rascunho";
    return {
      ...r, obra, itens, cotacoes, menor, pedidos, fornecedores,
      materiais: rascunho ? (await c.query("select id, descricao, unidade, codigo from material where ativo order by descricao")).rows : [],
      itensObra: rascunho ? await itensDaObra(c, r.obraId) : [],
      podeEditar: rascunho && pode(a, "suprimentos.requisitar"),
      podeDecidir: r.situacao === "enviada" && pode(a, "suprimentos.aprovar") && r.criadoPorId !== a.id,
      podeCancelar: ["rascunho", "enviada", "aprovada"].includes(r.situacao) && (pode(a, "suprimentos.requisitar") || pode(a, "suprimentos.aprovar"))
        && !pedidos.some((p) => p.situacao !== "cancelado"),
      podeCotar: r.situacao === "aprovada" && pode(a, "suprimentos.comprar"),
    };
  });
}

// ---------------------------------------------------------------------------
// Cotação e pedido
// ---------------------------------------------------------------------------
export type DadosCotacao = {
  empresaId: string; validade?: string | null; prazoEntrega?: string | number | null; condicaoPagamento?: string | null; frete?: string | null;
  observacao?: string | null; precos: Record<string, string>;
};

export async function registrarCotacao(a: Ator, requisicaoId: string, d: DadosCotacao): Promise<string> {
  exigir(a, "suprimentos.comprar");
  if (!uuid(d.empresaId)) throw new ErroDeRegra("Escolha o fornecedor.");
  if (d.validade && !dataValida(d.validade)) throw new ErroDeRegra("Validade inválida.");
  const prazo = d.prazoEntrega == null || d.prazoEntrega === "" ? null : Number(d.prazoEntrega);
  if (prazo != null && !(Number.isInteger(prazo) && prazo >= 0 && prazo <= 365)) throw new ErroDeRegra("Prazo de entrega em dias inválido.");
  const frete = d.frete ? quantidade(d.frete, "Frete", true) : "0";
  const precos = Object.entries(d.precos).filter(([, v]) => String(v ?? "").trim() !== "").map(([k, v]) => [k, preco(v)] as const);
  if (!precos.length) throw new ErroDeRegra("Informe o preço de ao menos um material.");
  return comContexto(ctxCampo(a), async (c) => {
    await requisicaoNoAcesso(c, a, requisicaoId);
    let id: string;
    try {
      id = (await c.query(
        `insert into cotacao_compra (orgao_id, requisicao_id, empresa_id, validade, prazo_entrega, condicao_pagamento, frete, observacao)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [a.orgaoId, requisicaoId, d.empresaId, d.validade || null, prazo, limpo(d.condicaoPagamento), frete, limpo(d.observacao)])).rows[0].id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ErroDeRegra("Este fornecedor já tem cotação nesta requisição.");
      throw e;
    }
    for (const [item, p] of precos) {
      if (!uuid(item)) throw new ErroDeRegra("Item inválido.");
      await c.query("insert into cotacao_compra_item (orgao_id, cotacao_id, requisicao_item_id, preco_unitario) values ($1,$2,$3,$4)", [a.orgaoId, id, item, p]);
    }
    return id;
  });
}

/** Emite o pedido ao fornecedor com os itens escolhidos da cotação. Item que não é o menor preço exige justificativa. */
export async function emitirPedido(a: Ator, cotacaoId: string, d: { itens: string[]; prazoEntrega?: string | null; justificativa?: string | null }): Promise<string> {
  exigir(a, "suprimentos.comprar");
  if (!uuid(cotacaoId)) throw new ErroDeRegra("Cotação não encontrada.");
  const escolhidos = [...new Set(d.itens.filter(uuid))];
  if (!escolhidos.length) throw new ErroDeRegra("Escolha os materiais do pedido.");
  return comContexto(ctxCampo(a), async (c) => {
    const cot = (await c.query(
      `select c.id, c.requisicao_id, c.empresa_id, c.prazo_entrega, c.condicao_pagamento, c.frete::text as frete, (c.validade is not null and c.validade < hoje_local()) as vencida,
              r.obra_id from cotacao_compra c join requisicao r on r.id = c.requisicao_id where c.id = $1`, [cotacaoId])).rows[0];
    if (!cot) throw new ErroDeRegra("Cotação não encontrada.");
    await requisicaoNoAcesso(c, a, cot.requisicao_id);
    if (cot.vencida) throw new ErroDeRegra("A cotação está vencida.");
    const linhas = (await c.query(
      `select ci.requisicao_item_id as id, ci.preco_unitario::text as preco, ri.material_id, ri.quantidade::text as quantidade,
              (select min(o.preco_unitario) from cotacao_compra_item o join cotacao_compra oc on oc.id = o.cotacao_id
                where o.requisicao_item_id = ci.requisicao_item_id and (oc.validade is null or oc.validade >= hoje_local())) < ci.preco_unitario as caro
         from cotacao_compra_item ci join requisicao_item ri on ri.id = ci.requisicao_item_id
        where ci.cotacao_id = $1 and ci.requisicao_item_id = any($2::uuid[])`, [cotacaoId, escolhidos])).rows;
    if (linhas.length !== escolhidos.length) throw new ErroDeRegra("Há material sem preço nesta cotação.");
    if (linhas.some((l) => l.caro) && !limpo(d.justificativa)) throw new ErroDeRegra("Há material com preço maior que o de outro fornecedor: informe a justificativa.");
    let prazo = d.prazoEntrega || null;
    if (prazo && (!dataValida(prazo) || prazo < hoje())) throw new ErroDeRegra("Prazo de entrega inválido.");
    if (!prazo) prazo = (await c.query("select to_char(hoje_local() + $1::int, 'YYYY-MM-DD') as d", [cot.prazo_entrega ?? 7])).rows[0].d;
    const id = (await c.query(
      `insert into pedido (orgao_id, obra_id, requisicao_id, cotacao_id, empresa_id, prazo_entrega, condicao_pagamento, frete, justificativa)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [a.orgaoId, cot.obra_id, cot.requisicao_id, cotacaoId, cot.empresa_id, prazo, cot.condicao_pagamento, cot.frete, limpo(d.justificativa)])).rows[0].id;
    for (const l of linhas) {
      await c.query("insert into pedido_item (orgao_id, pedido_id, requisicao_item_id, material_id, quantidade, preco_unitario) values ($1,$2,$3,$4,$5,$6)",
        [a.orgaoId, id, l.id, l.material_id, l.quantidade, l.preco]);
    }
    return id;
  });
}

export type ItemPedido = { id: string; material: string; codigo: string | null; unidade: string; quantidade: number; preco: number; total: number; recebido: number; recusado: number; saldo: number };
export type Recebimento = {
  id: string; data: string; notaFiscal: string; noPrazo: boolean; notaQualidade: number; notaAtendimento: number; observacao: string | null; por: string | null;
  itens: { material: string; unidade: string; quantidade: number; recusada: number; motivo: string | null }[];
};
export type PedidoCompleto = ResumoPedido & {
  obraId: string; obra: ObraCampo; empresaId: string; cnpj: string; responsavel: string | null; email: string | null; telefone: string | null;
  condicaoPagamento: string | null; frete: number; justificativa: string | null; canceladoMotivo: string | null; criadoPor: string | null; criadoEm: Date;
  requisicaoId: string; cotacaoData: string; itens: ItemPedido[]; recebimentos: Recebimento[]; subtotal: number;
  podeReceber: boolean; podeCancelar: boolean;
};

export async function obterPedido(a: Ator, id: string): Promise<PedidoCompleto> {
  exigirVer(a, "suprimentos.ver");
  if (!uuid(id)) throw new ErroDeRegra("Pedido não encontrado.");
  return comContexto(ctxCampo(a), async (c) => {
    const [base] = await pedidosDe(c, "p.id = $1", [id]);
    if (!base) throw new ErroDeRegra("Pedido não encontrado.");
    const obra = await obraNoAcesso(c, a, base.obraId);
    const x = (await c.query(
      `select p.empresa_id as "empresaId", e.cnpj, e.responsavel, e.email, e.telefone, p.condicao_pagamento as "condicaoPagamento", p.frete::float8 as frete,
              p.justificativa, p.cancelado_motivo as "canceladoMotivo", u.nome as "criadoPor", p.criado_em as "criadoEm", p.requisicao_id as "requisicaoId",
              to_char(cc.data, 'YYYY-MM-DD') as "cotacaoData"
         from pedido p join empresa e on e.id = p.empresa_id join cotacao_compra cc on cc.id = p.cotacao_id left join usuario u on u.id = p.criado_por
        where p.id = $1`, [id])).rows[0];
    const itens = (await c.query(
      `select i.id, m.descricao as material, m.codigo, m.unidade, i.quantidade::float8 as quantidade, i.preco_unitario::float8 as preco,
              (i.quantidade * i.preco_unitario)::float8 as total,
              coalesce((select sum(r.quantidade) from recebimento_item r where r.pedido_item_id = i.id), 0)::float8 as recebido,
              coalesce((select sum(r.recusada) from recebimento_item r where r.pedido_item_id = i.id), 0)::float8 as recusado
         from pedido_item i join material m on m.id = i.material_id where i.pedido_id = $1 order by m.descricao`, [id])).rows
      .map((i) => ({ ...i, saldo: Math.max(0, i.quantidade - i.recebido - i.recusado) })) as ItemPedido[];
    const recebimentos = (await c.query(
      `select r.id, to_char(r.data, 'YYYY-MM-DD') as data, r.nota_fiscal as "notaFiscal", r.no_prazo as "noPrazo", r.nota_qualidade as "notaQualidade",
              r.nota_atendimento as "notaAtendimento", r.observacao, u.nome as por,
              coalesce((select json_agg(json_build_object('material', m.descricao, 'unidade', m.unidade, 'quantidade', ri.quantidade::float8,
                                                          'recusada', ri.recusada::float8, 'motivo', ri.motivo_recusa) order by m.descricao)
                          from recebimento_item ri join pedido_item pi on pi.id = ri.pedido_item_id join material m on m.id = pi.material_id
                         where ri.recebimento_id = r.id), '[]') as itens
         from recebimento r left join usuario u on u.id = r.criado_por where r.pedido_id = $1 order by r.data, r.criado_em`, [id])).rows;
    const aberto = base.situacao === "emitido" || base.situacao === "parcial";
    return {
      ...base, ...x, obra, itens, recebimentos, subtotal: itens.reduce((s, i) => s + i.total, 0),
      podeReceber: aberto && pode(a, "suprimentos.estoque"),
      podeCancelar: base.situacao === "emitido" && recebimentos.length === 0 && pode(a, "suprimentos.comprar"),
    };
  });
}

export async function cancelarPedido(a: Ator, id: string, motivo: string) {
  exigir(a, "suprimentos.comprar");
  if (!uuid(id)) throw new ErroDeRegra("Pedido não encontrado.");
  if (!limpo(motivo)) throw new ErroDeRegra("Informe o motivo do cancelamento.");
  await comContexto(ctxCampo(a), async (c) => {
    const p = (await c.query("select obra_id, situacao from pedido where id = $1 for update", [id])).rows[0];
    if (!p) throw new ErroDeRegra("Pedido não encontrado.");
    await obraNoAcesso(c, a, p.obra_id);
    if (p.situacao !== "emitido") throw new ErroDeRegra("Só o pedido sem recebimento é cancelado.");
    await c.query("update pedido set situacao = 'cancelado', cancelado_motivo = $2 where id = $1", [id, limpo(motivo)]);
  });
}

export type DadosRecebimento = {
  data: string; notaFiscal: string; notaQualidade: number; notaAtendimento: number; observacao?: string | null;
  itens: { pedidoItemId: string; quantidade: string; recusada?: string; motivo?: string | null }[];
};

export async function registrarRecebimento(a: Ator, pedidoId: string, d: DadosRecebimento): Promise<string> {
  exigir(a, "suprimentos.estoque");
  if (!uuid(pedidoId)) throw new ErroDeRegra("Pedido não encontrado.");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  if (!limpo(d.notaFiscal)) throw new ErroDeRegra("Informe a nota fiscal.");
  for (const n of [d.notaQualidade, d.notaAtendimento]) if (!(Number.isInteger(n) && n >= 1 && n <= 5)) throw new ErroDeRegra("Avalie o fornecedor de 1 a 5.");
  const itens = d.itens.map((i) => ({
    id: i.pedidoItemId, q: quantidade(i.quantidade || "0", "Quantidade recebida", true), r: quantidade(i.recusada || "0", "Quantidade recusada", true), motivo: limpo(i.motivo),
  })).filter((i) => Number(i.q) > 0 || Number(i.r) > 0);
  if (!itens.length) throw new ErroDeRegra("Informe a quantidade recebida.");
  if (itens.some((i) => Number(i.r) > 0 && !i.motivo)) throw new ErroDeRegra("Informe o motivo da recusa.");
  return comContexto(ctxCampo(a), async (c) => {
    const p = (await c.query("select obra_id from pedido where id = $1 for update", [pedidoId])).rows[0];
    if (!p) throw new ErroDeRegra("Pedido não encontrado.");
    await obraNoAcesso(c, a, p.obra_id);
    const id = (await c.query(
      "insert into recebimento (orgao_id, pedido_id, data, nota_fiscal, nota_qualidade, nota_atendimento, observacao) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [a.orgaoId, pedidoId, d.data, limpo(d.notaFiscal), d.notaQualidade, d.notaAtendimento, limpo(d.observacao)])).rows[0].id;
    for (const i of itens) {
      if (!uuid(i.id)) throw new ErroDeRegra("Item inválido.");
      await c.query("insert into recebimento_item (orgao_id, recebimento_id, pedido_item_id, quantidade, recusada, motivo_recusa) values ($1,$2,$3,$4,$5,$6)",
        [a.orgaoId, id, i.id, i.q, i.r, i.motivo]);
    }
    return id;
  });
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------
export type DadosMovimento = {
  tipo: string; materialId: string; quantidade: string; data: string; itemServicoId?: string | null; obraDestinoId?: string | null;
  observacao?: string | null; custoUnitario?: string | null;
};

export async function registrarMovimento(a: Ator, obraId: string, d: DadosMovimento): Promise<string> {
  exigir(a, "suprimentos.estoque");
  const tipo = d.tipo as TipoMovimento;
  if (!MOVIMENTOS_MANUAIS.includes(tipo)) throw new ErroDeRegra("Escolha o tipo de movimento.");
  if (!uuid(d.materialId)) throw new ErroDeRegra("Escolha o material.");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  const q = quantidade(d.quantidade);
  if (tipo === "saida" && !uuid(d.itemServicoId)) throw new ErroDeRegra("Informe o item de serviço que recebe o material.");
  if (tipo === "transferencia_saida" && !uuid(d.obraDestinoId)) throw new ErroDeRegra("Escolha a obra de destino.");
  if (tipo !== "saida" && !limpo(d.observacao)) throw new ErroDeRegra("Informe a justificativa.");
  const custo = tipo === "ajuste_entrada" && d.custoUnitario ? quantidade(d.custoUnitario, "Custo unitário", true) : "0";
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    if (tipo === "transferencia_saida") await obraNoAcesso(c, a, d.obraDestinoId!);
    return (await c.query(
      `insert into movimento_estoque (orgao_id, obra_id, material_id, data, tipo, quantidade, custo_unitario, item_servico_id, obra_destino_id, observacao)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [a.orgaoId, obraId, d.materialId, d.data, tipo, q, custo, tipo === "saida" ? d.itemServicoId : null,
        tipo === "transferencia_saida" ? d.obraDestinoId : null, limpo(d.observacao)])).rows[0].id;
  });
}

export async function definirMinimo(a: Ator, obraId: string, materialId: string, valor: string) {
  exigir(a, "suprimentos.estoque");
  if (!uuid(materialId)) throw new ErroDeRegra("Material não encontrado.");
  await comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    if (String(valor ?? "").trim() === "") {
      await c.query("delete from estoque_minimo where obra_id = $1 and material_id = $2", [obraId, materialId]);
      return;
    }
    const q = quantidade(valor, "Estoque mínimo", true);
    await c.query(
      `insert into estoque_minimo (orgao_id, obra_id, material_id, quantidade) values ($1,$2,$3,$4)
       on conflict (obra_id, material_id) do update set quantidade = excluded.quantidade`, [a.orgaoId, obraId, materialId, q]);
  });
}

export const saidaDoEstoque = (t: TipoMovimento) => SAI.has(t);

// ---------------------------------------------------------------------------
// Fornecedores e módulo
// ---------------------------------------------------------------------------
export type AvaliacaoFornecedor = {
  id: string; razaoSocial: string; cnpj: string; tipo: string; pedidos: number; recebimentos: number; noPrazo: number | null;
  qualidade: number | null; atendimento: number | null; valor: number; recusas: number; documentosVencidos: number; nota: number | null;
};

export async function avaliacaoFornecedores(a: Ator): Promise<AvaliacaoFornecedor[]> {
  exigirVer(a, "suprimentos.ver");
  return comContexto(ctxCampo(a), async (c) => (await c.query(
    `select e.id, e.razao_social as "razaoSocial", e.cnpj, e.tipo,
            (select count(*)::int from pedido p where p.empresa_id = e.id and p.situacao <> 'cancelado') as pedidos,
            count(r.id)::int as recebimentos,
            (avg(case when r.no_prazo then 100 else 0 end))::float8 as "noPrazo",
            avg(r.nota_qualidade)::float8 as qualidade, avg(r.nota_atendimento)::float8 as atendimento,
            coalesce((select sum(i.quantidade * i.preco_unitario + 0) from pedido p join pedido_item i on i.pedido_id = p.id
                       where p.empresa_id = e.id and p.situacao <> 'cancelado'), 0)::float8 as valor,
            coalesce((select sum(ri.recusada) from pedido p join recebimento rr on rr.pedido_id = p.id join recebimento_item ri on ri.recebimento_id = rr.id
                       where p.empresa_id = e.id and ri.recusada > 0), 0)::int as recusas,
            (select count(*)::int from (select distinct on (d.tipo) d.validade from documento_empresa d where d.empresa_id = e.id
                                         order by d.tipo, d.validade desc) t where t.validade < hoje_local()) as "documentosVencidos"
       from empresa e left join pedido p on p.empresa_id = e.id left join recebimento r on r.pedido_id = p.id
      where e.tipo in ('fornecedor', 'contratada') and e.ativa
      group by e.id
      having (select count(*) from pedido p where p.empresa_id = e.id) > 0 or e.tipo = 'fornecedor'
      order by e.razao_social`)).rows.map((f) => ({
    ...f,
    // Nota geral de 0 a 10: metade prazo, metade qualidade e atendimento.
    nota: f.recebimentos ? Math.round((((f.noPrazo ?? 0) / 100) * 5 + ((f.qualidade + f.atendimento) / 10) * 5) * 10) / 10 : null,
  })));
}

export type PainelModuloSuprimentos = {
  obras: { id: string; codigo: string; nome: string; aguardando: number; atrasados: number; abaixoMinimo: number; valorEstoque: number; consumo: number }[];
  aguardando: (ResumoRequisicao & { obraId: string; obraCodigo: string })[];
  atrasados: (ResumoPedido & { obraId: string; obraCodigo: string })[];
  podeAprovar: boolean;
};

export async function painelModuloSuprimentos(a: Ator): Promise<PainelModuloSuprimentos> {
  exigirVer(a, "suprimentos.ver");
  return comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "o.id", 1);
    const obras = (await c.query(
      `select o.id, o.codigo, o.nome,
              (select count(*)::int from requisicao r where r.obra_id = o.id and r.situacao = 'enviada') as aguardando,
              (select count(*)::int from pedido p where p.obra_id = o.id and p.situacao in ('emitido', 'parcial') and p.prazo_entrega < hoje_local()) as atrasados,
              (select count(*)::int from estoque_minimo em where em.obra_id = o.id
                 and em.quantidade > coalesce((select sum(sinal_movimento(x.tipo) * x.quantidade) from movimento_estoque x where x.obra_id = o.id and x.material_id = em.material_id), 0)) as "abaixoMinimo",
              coalesce((select sum(sinal_movimento(x.tipo) * x.quantidade * x.custo_unitario) from movimento_estoque x where x.obra_id = o.id), 0)::float8 as "valorEstoque",
              coalesce((select sum(x.quantidade * x.custo_unitario) from movimento_estoque x where x.obra_id = o.id and x.tipo in ('saida', 'perda')), 0)::float8 as consumo
         from obra o where o.situacao in ('em_execucao', 'paralisada') and ${v.sql} order by o.codigo`, v.params)).rows;
    const aguardando = (await c.query(
      `select r.id, r.numero, to_char(r.data, 'YYYY-MM-DD') as data, to_char(r.necessidade, 'YYYY-MM-DD') as necessidade, r.situacao, u.nome as "criadoPor",
              (select count(*)::int from requisicao_item i where i.requisicao_id = r.id) as itens, 0 as pedidos, false as atrasada,
              o.id as "obraId", o.codigo as "obraCodigo"
         from requisicao r join obra o on o.id = r.obra_id left join usuario u on u.id = r.criado_por
        where r.situacao = 'enviada' and ${v.sql} order by r.necessidade`, v.params)).rows;
    const atrasados = (await pedidosDe(c, `p.situacao in ('emitido', 'parcial') and p.prazo_entrega < hoje_local() and ${v.sql}`, v.params));
    return { obras, aguardando, atrasados, podeAprovar: pode(a, "suprimentos.aprovar") };
  });
}

/** Pendências de suprimentos para a página inicial. */
export async function pendenciasDeSuprimentos(a: Ator) {
  if (!pode(a, "suprimentos.ver")) return null;
  const p = await painelModuloSuprimentos(a);
  return {
    aguardando: p.aguardando.length, atrasados: p.atrasados.length,
    abaixoMinimo: p.obras.reduce((s, o) => s + o.abaixoMinimo, 0), podeAprovar: p.podeAprovar,
  };
}
