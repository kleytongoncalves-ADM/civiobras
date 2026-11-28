import type { PoolClient } from "pg";
import { comContexto, ErroDeRegra } from "../lib/db";
import { ctxCampo, dataValida, exigirVer, hoje, limpo, obraNoAcesso, obrasVisiveis, uuid, type ObraCampo } from "./campo";
import type { Ator } from "./obras";
import { exigir, pode } from "./permissoes";
import { itensDaObra, type ItemObra } from "./qualidade";
import { quantidade } from "./suprimentos";

export const ASOS = ["Admissional", "Periódico", "Retorno ao trabalho", "Mudança de função", "Demissional"];
export const TREINAMENTOS = [
  "NR-06 Equipamento de proteção individual", "NR-10 Segurança em eletricidade", "NR-11 Movimentação de cargas", "NR-12 Máquinas e equipamentos",
  "NR-18 Integração na construção", "NR-33 Espaço confinado", "NR-35 Trabalho em altura",
];
export const ROTULO_DOC_EMPRESA: Record<string, string> = {
  cnd_federal: "CND federal", fgts: "Regularidade do FGTS", trabalhista: "Certidão trabalhista", estadual: "Certidão estadual",
  municipal: "Certidão municipal", seguro: "Seguro", alvara: "Alvará", outro: "Outro",
};
export const TIPOS_DOC_EMPRESA = Object.keys(ROTULO_DOC_EMPRESA);
export const ROTULO_MANUTENCAO: Record<string, string> = { preventiva: "Preventiva", corretiva: "Corretiva", revisao: "Revisão" };
/** Hora extra com adicional mínimo de 50% (CLT, art. 59). */
export const ADICIONAL_EXTRA = 1.5;
const AVISO_DIAS = 30;
/** Data limite para o aviso de vencimento (hoje + 30 dias). */
export const limiteAviso = () => new Date(Date.parse(`${hoje()}T12:00:00Z`) + AVISO_DIAS * 86400000).toISOString().slice(0, 10);

const cpfLimpo = (v: string) => v.replace(/\D/g, "");
function cpfValido(v: string) {
  const c = cpfLimpo(v);
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

// ---------------------------------------------------------------------------
// Pessoas
// ---------------------------------------------------------------------------
export type Pessoa = {
  id: string; nome: string; cpf: string; funcao: string; empresaId: string | null; empresa: string | null; custoHora: number | null; ativa: boolean;
  pendencia: string | null; proximoVencimento: string | null; proximoItem: string | null; obraAtual: string | null; obraAtualId: string | null;
};
const COLUNAS_PESSOA = `p.id, p.nome, p.cpf, p.funcao, p.empresa_id as "empresaId", e.razao_social as empresa, p.custo_hora::float8 as "custoHora", p.ativa,
  pendencia_habilitacao(p.id, hoje_local()) as pendencia,
  (select to_char(t.validade, 'YYYY-MM-DD') from (select distinct on (h.tipo, h.descricao) h.descricao, h.validade from habilitacao h
     where h.pessoa_id = p.id and (h.tipo = 'aso' or h.obrigatorio) order by h.tipo, h.descricao, h.validade desc) t order by t.validade limit 1) as "proximoVencimento",
  (select t.descricao from (select distinct on (h.tipo, h.descricao) h.tipo, h.descricao, h.validade from habilitacao h
     where h.pessoa_id = p.id and (h.tipo = 'aso' or h.obrigatorio) order by h.tipo, h.descricao, h.validade desc) t order by t.validade limit 1) as "proximoItem",
  (select o.codigo from alocacao_pessoa x join obra o on o.id = x.obra_id where x.pessoa_id = p.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local() limit 1) as "obraAtual",
  (select x.obra_id from alocacao_pessoa x where x.pessoa_id = p.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local() limit 1) as "obraAtualId"`;

export async function listarPessoas(a: Ator, busca?: string): Promise<Pessoa[]> {
  exigirVer(a, "equipes.ver");
  const b = limpo(busca);
  return comContexto(ctxCampo(a), async (c) => (await c.query(
    `select ${COLUNAS_PESSOA} from pessoa p left join empresa e on e.id = p.empresa_id
      where ($1::text is null or p.nome ilike '%' || $1 || '%' or p.funcao ilike '%' || $1 || '%' or p.cpf like $1 || '%')
      order by p.ativa desc, p.nome`, [b])).rows);
}

export type DadosPessoa = { nome: string; cpf: string; funcao: string; empresaId?: string | null; custoHora?: string | null; ativa?: boolean };

export async function salvarPessoa(a: Ator, id: string | null, d: DadosPessoa): Promise<string> {
  exigir(a, "equipes.gerenciar");
  if (!limpo(d.nome)) throw new ErroDeRegra("Informe o nome.");
  if (!cpfValido(d.cpf)) throw new ErroDeRegra("CPF inválido.");
  if (!limpo(d.funcao)) throw new ErroDeRegra("Informe a função.");
  const custo = d.custoHora ? quantidade(d.custoHora, "Custo por hora", true) : null;
  const valores = [limpo(d.nome), cpfLimpo(d.cpf), limpo(d.funcao), uuid(d.empresaId) ? d.empresaId : null, custo];
  return comContexto(ctxCampo(a), async (c) => {
    try {
      if (id) {
        if (!uuid(id)) throw new ErroDeRegra("Pessoa não encontrada.");
        const r = await c.query("update pessoa set nome = $2, cpf = $3, funcao = $4, empresa_id = $5, custo_hora = $6, ativa = $7 where id = $1 returning id",
          [id, ...valores, d.ativa ?? true]);
        if (!r.rows[0]) throw new ErroDeRegra("Pessoa não encontrada.");
        return id;
      }
      return (await c.query("insert into pessoa (orgao_id, nome, cpf, funcao, empresa_id, custo_hora) values ($1,$2,$3,$4,$5,$6) returning id",
        [a.orgaoId, ...valores])).rows[0].id;
    } catch (e) {
      if ((e as { constraint?: string }).constraint === "pessoa_cpf_unico") throw new ErroDeRegra("Já existe uma pessoa com este CPF.");
      throw e;
    }
  });
}

export type Habilitacao = {
  id: string; tipo: "aso" | "treinamento"; descricao: string; data: string; validade: string; cargaHoraria: number | null; obrigatorio: boolean;
  vigente: boolean; vencida: boolean; vencendo: boolean; por: string | null;
};
export type PessoaCompleta = Pessoa & {
  habilitacoes: Habilitacao[];
  alocacoes: { id: string; obraId: string; obraCodigo: string; obraNome: string; funcao: string | null; inicio: string; fim: string | null }[];
  horas: { data: string; obraCodigo: string; item: string | null; normais: number; extras: number }[];
  empresas: { id: string; razaoSocial: string }[]; podeGerenciar: boolean;
};

export async function obterPessoa(a: Ator, id: string): Promise<PessoaCompleta> {
  exigirVer(a, "equipes.ver");
  if (!uuid(id)) throw new ErroDeRegra("Pessoa não encontrada.");
  return comContexto(ctxCampo(a), async (c) => {
    const p = (await c.query(`select ${COLUNAS_PESSOA} from pessoa p left join empresa e on e.id = p.empresa_id where p.id = $1`, [id])).rows[0] as Pessoa | undefined;
    if (!p) throw new ErroDeRegra("Pessoa não encontrada.");
    const habilitacoes = (await c.query(
      `select h.id, h.tipo, h.descricao, to_char(h.data, 'YYYY-MM-DD') as data, to_char(h.validade, 'YYYY-MM-DD') as validade, h.carga_horaria as "cargaHoraria",
              h.obrigatorio, u.nome as por,
              h.id = (select z.id from habilitacao z where z.pessoa_id = h.pessoa_id and z.tipo = h.tipo and z.descricao = h.descricao order by z.validade desc limit 1) as vigente,
              h.validade < hoje_local() as vencida, h.validade between hoje_local() and hoje_local() + ${AVISO_DIAS} as vencendo
         from habilitacao h left join usuario u on u.id = h.criado_por where h.pessoa_id = $1 order by h.tipo, h.descricao, h.validade desc`, [id])).rows;
    const alocacoes = (await c.query(
      `select x.id, x.obra_id as "obraId", o.codigo as "obraCodigo", o.nome as "obraNome", x.funcao, to_char(x.inicio, 'YYYY-MM-DD') as inicio, to_char(x.fim, 'YYYY-MM-DD') as fim
         from alocacao_pessoa x join obra o on o.id = x.obra_id where x.pessoa_id = $1 order by x.inicio desc`, [id])).rows;
    const horas = (await c.query(
      `select to_char(x.data, 'YYYY-MM-DD') as data, o.codigo as "obraCodigo", case when i.id is not null then i.numero || ' ' || left(i.descricao, 50) end as item,
              x.horas_normais::float8 as normais, x.horas_extras::float8 as extras
         from apontamento x join obra o on o.id = x.obra_id left join item_servico i on i.id = x.item_servico_id
        where x.pessoa_id = $1 order by x.data desc, x.criado_em desc limit 60`, [id])).rows;
    const empresas = (await c.query("select id, razao_social as \"razaoSocial\" from empresa where ativa order by razao_social")).rows;
    return { ...p, habilitacoes, alocacoes, horas, empresas, podeGerenciar: pode(a, "equipes.gerenciar") };
  });
}

export type DadosHabilitacao = { tipo: string; descricao: string; data: string; validade: string; cargaHoraria?: string | null; obrigatorio?: boolean };

export async function registrarHabilitacao(a: Ator, pessoaId: string, d: DadosHabilitacao): Promise<string> {
  exigir(a, "equipes.gerenciar");
  if (!uuid(pessoaId)) throw new ErroDeRegra("Pessoa não encontrada.");
  if (d.tipo !== "aso" && d.tipo !== "treinamento") throw new ErroDeRegra("Escolha ASO ou treinamento.");
  if (!limpo(d.descricao)) throw new ErroDeRegra(d.tipo === "aso" ? "Informe o tipo de ASO." : "Informe o treinamento.");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  if (!dataValida(d.validade) || d.validade < d.data) throw new ErroDeRegra("Informe a validade.");
  const ch = d.cargaHoraria ? Number(d.cargaHoraria) : null;
  if (ch != null && !(Number.isInteger(ch) && ch > 0 && ch <= 1000)) throw new ErroDeRegra("Carga horária inválida.");
  return comContexto(ctxCampo(a), async (c) => (await c.query(
    "insert into habilitacao (orgao_id, pessoa_id, tipo, descricao, data, validade, carga_horaria, obrigatorio) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [a.orgaoId, pessoaId, d.tipo, limpo(d.descricao), d.data, d.validade, ch, d.tipo === "aso" ? true : d.obrigatorio ?? true])).rows[0].id);
}

// ---------------------------------------------------------------------------
// Equipamentos
// ---------------------------------------------------------------------------
export type Equipamento = {
  id: string; descricao: string; identificacao: string | null; propriedade: "proprio" | "locado"; empresaId: string | null; empresa: string | null;
  custoHora: number | null; ativo: boolean; disponivel: boolean; proximaRevisao: string | null; obraAtual: string | null; obraAtualId: string | null;
};
const COLUNAS_EQ = `q.id, q.descricao, q.identificacao, q.propriedade, q.empresa_id as "empresaId", e.razao_social as empresa, q.custo_hora::float8 as "custoHora", q.ativo,
  equipamento_disponivel(q.id, hoje_local()) as disponivel,
  (select to_char(m.proxima_revisao, 'YYYY-MM-DD') from manutencao m where m.equipamento_id = q.id order by m.data desc, m.criado_em desc limit 1) as "proximaRevisao",
  (select o.codigo from alocacao_equipamento x join obra o on o.id = x.obra_id where x.equipamento_id = q.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local() limit 1) as "obraAtual",
  (select x.obra_id from alocacao_equipamento x where x.equipamento_id = q.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local() limit 1) as "obraAtualId"`;

export async function listarEquipamentos(a: Ator): Promise<Equipamento[]> {
  exigirVer(a, "equipes.ver");
  return comContexto(ctxCampo(a), async (c) => (await c.query(
    `select ${COLUNAS_EQ} from equipamento q left join empresa e on e.id = q.empresa_id order by q.ativo desc, q.descricao`)).rows);
}

export type DadosEquipamento = { descricao: string; identificacao?: string | null; propriedade: string; empresaId?: string | null; custoHora?: string | null; ativo?: boolean };

export async function salvarEquipamento(a: Ator, id: string | null, d: DadosEquipamento): Promise<string> {
  exigir(a, "equipes.gerenciar");
  if (!limpo(d.descricao)) throw new ErroDeRegra("Informe a descrição.");
  if (d.propriedade !== "proprio" && d.propriedade !== "locado") throw new ErroDeRegra("Informe se é próprio ou locado.");
  if (d.propriedade === "locado" && !uuid(d.empresaId)) throw new ErroDeRegra("Informe a locadora.");
  const custo = d.custoHora ? quantidade(d.custoHora, "Custo por hora", true) : null;
  const valores = [limpo(d.descricao), limpo(d.identificacao), d.propriedade, d.propriedade === "locado" ? d.empresaId : null, custo];
  return comContexto(ctxCampo(a), async (c) => {
    if (id) {
      if (!uuid(id)) throw new ErroDeRegra("Equipamento não encontrado.");
      const r = await c.query("update equipamento set descricao = $2, identificacao = $3, propriedade = $4, empresa_id = $5, custo_hora = $6, ativo = $7 where id = $1 returning id",
        [id, ...valores, d.ativo ?? true]);
      if (!r.rows[0]) throw new ErroDeRegra("Equipamento não encontrado.");
      return id;
    }
    return (await c.query("insert into equipamento (orgao_id, descricao, identificacao, propriedade, empresa_id, custo_hora) values ($1,$2,$3,$4,$5,$6) returning id",
      [a.orgaoId, ...valores])).rows[0].id;
  });
}

export type EquipamentoCompleto = Equipamento & {
  manutencoes: { id: string; data: string; tipo: string; descricao: string; proximaRevisao: string | null; custo: number | null; por: string | null }[];
  alocacoes: { id: string; obraId: string; obraCodigo: string; obraNome: string; inicio: string; fim: string | null }[];
  horas: { data: string; obraCodigo: string; item: string | null; horas: number }[];
  empresas: { id: string; razaoSocial: string }[]; podeGerenciar: boolean;
};

export async function obterEquipamento(a: Ator, id: string): Promise<EquipamentoCompleto> {
  exigirVer(a, "equipes.ver");
  if (!uuid(id)) throw new ErroDeRegra("Equipamento não encontrado.");
  return comContexto(ctxCampo(a), async (c) => {
    const q = (await c.query(`select ${COLUNAS_EQ} from equipamento q left join empresa e on e.id = q.empresa_id where q.id = $1`, [id])).rows[0] as Equipamento | undefined;
    if (!q) throw new ErroDeRegra("Equipamento não encontrado.");
    const manutencoes = (await c.query(
      `select m.id, to_char(m.data, 'YYYY-MM-DD') as data, m.tipo, m.descricao, to_char(m.proxima_revisao, 'YYYY-MM-DD') as "proximaRevisao", m.custo::float8 as custo, u.nome as por
         from manutencao m left join usuario u on u.id = m.criado_por where m.equipamento_id = $1 order by m.data desc, m.criado_em desc`, [id])).rows;
    const alocacoes = (await c.query(
      `select x.id, x.obra_id as "obraId", o.codigo as "obraCodigo", o.nome as "obraNome", to_char(x.inicio, 'YYYY-MM-DD') as inicio, to_char(x.fim, 'YYYY-MM-DD') as fim
         from alocacao_equipamento x join obra o on o.id = x.obra_id where x.equipamento_id = $1 order by x.inicio desc`, [id])).rows;
    const horas = (await c.query(
      `select to_char(x.data, 'YYYY-MM-DD') as data, o.codigo as "obraCodigo", case when i.id is not null then i.numero || ' ' || left(i.descricao, 50) end as item, x.horas::float8 as horas
         from apontamento_equipamento x join obra o on o.id = x.obra_id left join item_servico i on i.id = x.item_servico_id
        where x.equipamento_id = $1 order by x.data desc limit 60`, [id])).rows;
    const empresas = (await c.query("select id, razao_social as \"razaoSocial\" from empresa where ativa order by razao_social")).rows;
    return { ...q, manutencoes, alocacoes, horas, empresas, podeGerenciar: pode(a, "equipes.gerenciar") };
  });
}

export async function registrarManutencao(a: Ator, equipamentoId: string, d: { data: string; tipo: string; descricao: string; proximaRevisao?: string | null; custo?: string | null }) {
  exigir(a, "equipes.gerenciar");
  if (!uuid(equipamentoId)) throw new ErroDeRegra("Equipamento não encontrado.");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  if (!ROTULO_MANUTENCAO[d.tipo]) throw new ErroDeRegra("Escolha o tipo de manutenção.");
  if (!limpo(d.descricao)) throw new ErroDeRegra("Descreva o serviço feito.");
  if (d.proximaRevisao && (!dataValida(d.proximaRevisao) || d.proximaRevisao <= d.data)) throw new ErroDeRegra("A próxima revisão é posterior à manutenção.");
  const custo = d.custo ? quantidade(d.custo, "Custo", true) : null;
  await comContexto(ctxCampo(a), (c) => c.query(
    "insert into manutencao (orgao_id, equipamento_id, data, tipo, descricao, proxima_revisao, custo) values ($1,$2,$3,$4,$5,$6,$7)",
    [a.orgaoId, equipamentoId, d.data, d.tipo, limpo(d.descricao), d.proximaRevisao || null, custo]));
}

// ---------------------------------------------------------------------------
// Documentos das empresas
// ---------------------------------------------------------------------------
export type DocumentoEmpresa = { id: string; tipo: string; numero: string | null; emissao: string | null; validade: string; vencido: boolean; vencendo: boolean; observacao: string | null };
export type EmpresaDocumentos = { id: string; razaoSocial: string; cnpj: string; tipo: string; documentos: DocumentoEmpresa[]; vencidos: number; vencendo: number; pessoas: number };

export async function documentosDasEmpresas(a: Ator): Promise<EmpresaDocumentos[]> {
  exigirVer(a, "equipes.ver");
  return comContexto(ctxCampo(a), async (c) => (await c.query(
    `select e.id, e.razao_social as "razaoSocial", e.cnpj, e.tipo,
            (select count(*)::int from pessoa p where p.empresa_id = e.id and p.ativa) as pessoas,
            coalesce((select json_agg(json_build_object('id', d.id, 'tipo', d.tipo, 'numero', d.numero, 'emissao', to_char(d.emissao, 'YYYY-MM-DD'),
                                                        'validade', to_char(d.validade, 'YYYY-MM-DD'), 'observacao', d.observacao,
                                                        'vencido', d.validade < hoje_local(), 'vencendo', d.validade between hoje_local() and hoje_local() + ${AVISO_DIAS}) order by d.tipo)
                        from (select distinct on (x.tipo) x.* from documento_empresa x where x.empresa_id = e.id order by x.tipo, x.validade desc) d), '[]') as documentos
       from empresa e where e.ativa order by e.razao_social`)).rows.map((e) => ({
    ...e, vencidos: (e.documentos as DocumentoEmpresa[]).filter((d) => d.vencido).length, vencendo: (e.documentos as DocumentoEmpresa[]).filter((d) => d.vencendo).length,
  })));
}

export async function registrarDocumentoEmpresa(a: Ator, empresaId: string, d: { tipo: string; numero?: string | null; emissao?: string | null; validade: string; observacao?: string | null }) {
  exigir(a, "equipes.gerenciar");
  if (!uuid(empresaId)) throw new ErroDeRegra("Empresa não encontrada.");
  if (!ROTULO_DOC_EMPRESA[d.tipo]) throw new ErroDeRegra("Escolha o documento.");
  if (d.emissao && !dataValida(d.emissao)) throw new ErroDeRegra("Data de emissão inválida.");
  if (!dataValida(d.validade) || (d.emissao && d.validade < d.emissao)) throw new ErroDeRegra("Informe a validade.");
  await comContexto(ctxCampo(a), (c) => c.query(
    "insert into documento_empresa (orgao_id, empresa_id, tipo, numero, emissao, validade, observacao) values ($1,$2,$3,$4,$5,$6,$7)",
    [a.orgaoId, empresaId, d.tipo, limpo(d.numero), d.emissao || null, d.validade, limpo(d.observacao)]));
}

// ---------------------------------------------------------------------------
// Equipe da obra: alocação, horas, custo e produtividade
// ---------------------------------------------------------------------------
export type AlocacaoPessoa = {
  id: string; pessoaId: string; nome: string; funcao: string; empresa: string | null; inicio: string; fim: string | null; ativa: boolean;
  pendencia: string | null; vencimento: string | null; vencimentoItem: string | null; horasMes: number;
};
export type AlocacaoEquipamento = { id: string; equipamentoId: string; descricao: string; identificacao: string | null; inicio: string; fim: string | null; ativa: boolean; disponivel: boolean; proximaRevisao: string | null; horasMes: number };
export type LinhaCusto = {
  itemId: string; numero: string; descricao: string; unidade: string; orcado: number; medido: number; quantidadeMedida: number;
  materiais: number; maoDeObra: number; equipamentos: number; realizado: number;
  horas: number; horasPorUnidade: number | null; previstoPorUnidade: number | null; indice: number | null;
};
export type PainelEquipes = {
  obra: ObraCampo; pessoas: AlocacaoPessoa[]; equipamentos: AlocacaoEquipamento[];
  disponiveis: { id: string; nome: string; funcao: string; empresa: string | null; pendencia: string | null }[];
  equipamentosLivres: { id: string; descricao: string; identificacao: string | null; disponivel: boolean }[];
  apontamentos: { data: string; nome: string; funcao: string; item: string | null; normais: number; extras: number; custo: number }[];
  apontamentosEq: { data: string; descricao: string; item: string | null; horas: number; custo: number }[];
  custos: LinhaCusto[]; itens: ItemObra[];
  totalMateriais: number; totalMaoDeObra: number; totalEquipamentos: number; horasMes: number; alertas: number;
  podeGerenciar: boolean; podeApontar: boolean;
};

/** Custo realizado e produtividade por item de serviço da obra. */
export async function custosDaObra(c: PoolClient, obraId: string): Promise<LinhaCusto[]> {
  return (await c.query(
    `with itens as (
       select i.id, i.numero, i.descricao, i.unidade, i.ordem, k.numero as contrato, i.orcamento_item_id,
              (quantidade_vigente(i.id) * i.preco_unitario) as orcado
         from item_servico i join contrato k on k.id = i.contrato_id where k.obra_id = $1 and k.situacao not in ('rascunho', 'rescindido')),
     med as (select im.item_servico_id, sum(im.quantidade) as q, sum(im.valor) as v from item_medido im join medicao m on m.id = im.medicao_id
              where m.situacao <> 'cancelada' group by 1),
     mat as (select item_servico_id, sum(quantidade * custo_unitario) as v from movimento_estoque where obra_id = $1 and tipo = 'saida' group by 1),
     mo as (select item_servico_id, sum(horas_normais + horas_extras) as h,
                   sum(coalesce(custo_hora, 0) * (horas_normais + horas_extras * ${ADICIONAL_EXTRA})) as v from apontamento where obra_id = $1 group by 1),
     eq as (select item_servico_id, sum(coalesce(custo_hora, 0) * horas) as v from apontamento_equipamento where obra_id = $1 group by 1)
     select i.id as "itemId", i.numero, i.descricao, i.unidade, i.orcado::float8 as orcado, coalesce(med.v, 0)::float8 as medido, coalesce(med.q, 0)::float8 as "quantidadeMedida",
            coalesce(mat.v, 0)::float8 as materiais, coalesce(mo.v, 0)::float8 as "maoDeObra", coalesce(eq.v, 0)::float8 as equipamentos, coalesce(mo.h, 0)::float8 as horas,
            (select sum(x.coeficiente) from orcamento_item_insumo x where x.item_id = i.orcamento_item_id and x.tipo = 'mao_de_obra' and lower(x.unidade) = 'h')::float8 as "previstoPorUnidade"
       from itens i left join med on med.item_servico_id = i.id left join mat on mat.item_servico_id = i.id
       left join mo on mo.item_servico_id = i.id left join eq on eq.item_servico_id = i.id
      where mat.v is not null or mo.v is not null or eq.v is not null or med.v is not null
      order by i.contrato, i.ordem`, [obraId])).rows.map((l) => {
    const horasPorUnidade = l.horas > 0 && l.quantidadeMedida > 0 ? l.horas / l.quantidadeMedida : null;
    return {
      ...l, realizado: l.materiais + l.maoDeObra + l.equipamentos, horasPorUnidade,
      indice: horasPorUnidade != null && l.previstoPorUnidade ? horasPorUnidade / l.previstoPorUnidade : null,
    };
  });
}

/** completo: sem limite de linhas, para planilha e relatório. A tela mostra os apontamentos mais recentes. */
export async function painelEquipes(a: Ator, obraId: string, completo = false): Promise<PainelEquipes> {
  exigirVer(a, "equipes.ver");
  return comContexto(ctxCampo(a), async (c) => {
    const obra = await obraNoAcesso(c, a, obraId);
    const pessoas = (await c.query(
      `select x.id, x.pessoa_id as "pessoaId", p.nome, coalesce(x.funcao, p.funcao) as funcao, e.razao_social as empresa,
              to_char(x.inicio, 'YYYY-MM-DD') as inicio, to_char(x.fim, 'YYYY-MM-DD') as fim,
              (x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local()) as ativa,
              pendencia_habilitacao(p.id, hoje_local()) as pendencia,
              (select to_char(t.validade, 'YYYY-MM-DD') from (select distinct on (h.tipo, h.descricao) h.descricao, h.validade from habilitacao h
                 where h.pessoa_id = p.id and (h.tipo = 'aso' or h.obrigatorio) order by h.tipo, h.descricao, h.validade desc) t
                order by t.validade limit 1) as vencimento,
              (select t.descricao from (select distinct on (h.tipo, h.descricao) h.tipo, h.descricao, h.validade from habilitacao h
                 where h.pessoa_id = p.id and (h.tipo = 'aso' or h.obrigatorio) order by h.tipo, h.descricao, h.validade desc) t
                order by t.validade limit 1) as "vencimentoItem",
              coalesce((select sum(z.horas_normais + z.horas_extras) from apontamento z where z.pessoa_id = p.id and z.obra_id = x.obra_id
                         and z.data >= date_trunc('month', hoje_local())), 0)::float8 as "horasMes"
         from alocacao_pessoa x join pessoa p on p.id = x.pessoa_id left join empresa e on e.id = p.empresa_id
        where x.obra_id = $1 order by (x.fim is null or x.fim >= hoje_local()) desc, p.nome`, [obraId])).rows as AlocacaoPessoa[];
    const equipamentos = (await c.query(
      `select x.id, x.equipamento_id as "equipamentoId", q.descricao, q.identificacao, to_char(x.inicio, 'YYYY-MM-DD') as inicio, to_char(x.fim, 'YYYY-MM-DD') as fim,
              (x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local()) as ativa, equipamento_disponivel(q.id, hoje_local()) as disponivel,
              (select to_char(m.proxima_revisao, 'YYYY-MM-DD') from manutencao m where m.equipamento_id = q.id order by m.data desc, m.criado_em desc limit 1) as "proximaRevisao",
              coalesce((select sum(z.horas) from apontamento_equipamento z where z.equipamento_id = q.id and z.obra_id = x.obra_id
                         and z.data >= date_trunc('month', hoje_local())), 0)::float8 as "horasMes"
         from alocacao_equipamento x join equipamento q on q.id = x.equipamento_id
        where x.obra_id = $1 order by (x.fim is null or x.fim >= hoje_local()) desc, q.descricao`, [obraId])).rows as AlocacaoEquipamento[];
    const podeGerenciar = pode(a, "equipes.gerenciar");
    const disponiveis = podeGerenciar ? (await c.query(
      `select p.id, p.nome, p.funcao, e.razao_social as empresa, pendencia_habilitacao(p.id, hoje_local()) as pendencia
         from pessoa p left join empresa e on e.id = p.empresa_id
        where p.ativa and not exists (select 1 from alocacao_pessoa x where x.pessoa_id = p.id and x.obra_id = $1 and coalesce(x.fim, 'infinity'::date) >= hoje_local())
        order by p.nome`, [obraId])).rows : [];
    const equipamentosLivres = podeGerenciar ? (await c.query(
      `select q.id, q.descricao, q.identificacao, equipamento_disponivel(q.id, hoje_local()) as disponivel from equipamento q
        where q.ativo and not exists (select 1 from alocacao_equipamento x where x.equipamento_id = q.id and coalesce(x.fim, 'infinity'::date) >= hoje_local())
        order by q.descricao`)).rows : [];
    const apontamentos = (await c.query(
      `select to_char(z.data, 'YYYY-MM-DD') as data, p.nome, p.funcao, case when i.id is not null then i.numero || ' ' || left(i.descricao, 50) end as item,
              z.horas_normais::float8 as normais, z.horas_extras::float8 as extras,
              (coalesce(z.custo_hora, 0) * (z.horas_normais + z.horas_extras * ${ADICIONAL_EXTRA}))::float8 as custo
         from apontamento z join pessoa p on p.id = z.pessoa_id left join item_servico i on i.id = z.item_servico_id
        where z.obra_id = $1 order by z.data desc, p.nome${completo ? "" : " limit 120"}`, [obraId])).rows;
    const apontamentosEq = (await c.query(
      `select to_char(z.data, 'YYYY-MM-DD') as data, q.descricao, case when i.id is not null then i.numero || ' ' || left(i.descricao, 50) end as item,
              z.horas::float8 as horas, (coalesce(z.custo_hora, 0) * z.horas)::float8 as custo
         from apontamento_equipamento z join equipamento q on q.id = z.equipamento_id left join item_servico i on i.id = z.item_servico_id
        where z.obra_id = $1 order by z.data desc, q.descricao${completo ? "" : " limit 60"}`, [obraId])).rows;
    const custos = await custosDaObra(c, obraId);
    const ativas = pessoas.filter((p) => p.ativa);
    return {
      obra, pessoas, equipamentos, disponiveis, equipamentosLivres, apontamentos, apontamentosEq, custos, itens: await itensDaObra(c, obraId),
      totalMateriais: custos.reduce((s, l) => s + l.materiais, 0), totalMaoDeObra: custos.reduce((s, l) => s + l.maoDeObra, 0),
      totalEquipamentos: custos.reduce((s, l) => s + l.equipamentos, 0), horasMes: pessoas.reduce((s, p) => s + p.horasMes, 0),
      alertas: ativas.filter((p) => p.pendencia || (p.vencimento && p.vencimento <= limiteAviso())).length + equipamentos.filter((q) => q.ativa && !q.disponivel).length,
      podeGerenciar, podeApontar: pode(a, "equipes.apontar"),
    };
  });
}

export async function alocarPessoa(a: Ator, obraId: string, d: { pessoaId: string; inicio: string; fim?: string | null; funcao?: string | null }) {
  exigir(a, "equipes.gerenciar");
  if (!uuid(d.pessoaId)) throw new ErroDeRegra("Escolha a pessoa.");
  if (!dataValida(d.inicio)) throw new ErroDeRegra("Informe o início.");
  if (d.fim && (!dataValida(d.fim) || d.fim < d.inicio)) throw new ErroDeRegra("O fim é posterior ao início.");
  await comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    await c.query("insert into alocacao_pessoa (orgao_id, obra_id, pessoa_id, funcao, inicio, fim) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, obraId, d.pessoaId, limpo(d.funcao), d.inicio, d.fim || null]);
  });
}

export async function encerrarAlocacao(a: Ator, tipo: "pessoa" | "equipamento", id: string, fim: string) {
  exigir(a, "equipes.gerenciar");
  if (!uuid(id)) throw new ErroDeRegra("Alocação não encontrada.");
  if (!dataValida(fim)) throw new ErroDeRegra("Informe a data de saída.");
  const tabela = tipo === "pessoa" ? "alocacao_pessoa" : "alocacao_equipamento";
  await comContexto(ctxCampo(a), async (c) => {
    const x = (await c.query(`select obra_id, to_char(inicio, 'YYYY-MM-DD') as inicio, fim from ${tabela} where id = $1 for update`, [id])).rows[0];
    if (!x) throw new ErroDeRegra("Alocação não encontrada.");
    await obraNoAcesso(c, a, x.obra_id);
    if (x.fim) throw new ErroDeRegra("A alocação já foi encerrada.");
    if (fim < x.inicio) throw new ErroDeRegra("A saída é posterior ao início.");
    await c.query(`update ${tabela} set fim = $2 where id = $1`, [id, fim]);
  });
}

export async function alocarEquipamento(a: Ator, obraId: string, d: { equipamentoId: string; inicio: string; fim?: string | null }) {
  exigir(a, "equipes.gerenciar");
  if (!uuid(d.equipamentoId)) throw new ErroDeRegra("Escolha o equipamento.");
  if (!dataValida(d.inicio)) throw new ErroDeRegra("Informe o início.");
  if (d.fim && (!dataValida(d.fim) || d.fim < d.inicio)) throw new ErroDeRegra("O fim é posterior ao início.");
  await comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    await c.query("insert into alocacao_equipamento (orgao_id, obra_id, equipamento_id, inicio, fim) values ($1,$2,$3,$4,$5)",
      [a.orgaoId, obraId, d.equipamentoId, d.inicio, d.fim || null]);
  });
}

export type DadosApontamento = { data: string; itemServicoId?: string | null; linhas: { pessoaId: string; normais: string; extras?: string }[] };

/** Apontamento de horas da turma no dia, num item de serviço. */
export async function apontarHoras(a: Ator, obraId: string, d: DadosApontamento): Promise<number> {
  exigir(a, "equipes.apontar");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  const linhas = d.linhas.map((l) => ({
    id: l.pessoaId, n: quantidade(l.normais || "0", "Horas normais", true), x: quantidade(l.extras || "0", "Horas extras", true),
  })).filter((l) => Number(l.n) + Number(l.x) > 0);
  if (!linhas.length) throw new ErroDeRegra("Informe as horas de ao menos uma pessoa.");
  if (linhas.some((l) => Number(l.n) > 24 || Number(l.x) > 24)) throw new ErroDeRegra("Horas acima de 24 no dia.");
  return comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    for (const l of linhas) {
      if (!uuid(l.id)) throw new ErroDeRegra("Pessoa inválida.");
      await c.query("insert into apontamento (orgao_id, obra_id, pessoa_id, data, item_servico_id, horas_normais, horas_extras) values ($1,$2,$3,$4,$5,$6,$7)",
        [a.orgaoId, obraId, l.id, d.data, uuid(d.itemServicoId) ? d.itemServicoId : null, l.n, l.x]);
    }
    return linhas.length;
  });
}

export async function apontarEquipamento(a: Ator, obraId: string, d: { data: string; equipamentoId: string; itemServicoId?: string | null; horas: string }) {
  exigir(a, "equipes.apontar");
  if (!dataValida(d.data) || d.data > hoje()) throw new ErroDeRegra("Data inválida.");
  if (!uuid(d.equipamentoId)) throw new ErroDeRegra("Escolha o equipamento.");
  const h = quantidade(d.horas, "Horas");
  if (Number(h) > 24) throw new ErroDeRegra("Horas acima de 24 no dia.");
  await comContexto(ctxCampo(a), async (c) => {
    await obraNoAcesso(c, a, obraId);
    await c.query("insert into apontamento_equipamento (orgao_id, obra_id, equipamento_id, data, item_servico_id, horas) values ($1,$2,$3,$4,$5,$6)",
      [a.orgaoId, obraId, d.equipamentoId, d.data, uuid(d.itemServicoId) ? d.itemServicoId : null, h]);
  });
}

/** Equipe alocada na data, agrupada por função e empresa (para o efetivo do diário). */
export async function efetivoAlocado(c: PoolClient, obraId: string, data: string) {
  return (await c.query(
    `select coalesce(x.funcao, p.funcao) as funcao, coalesce(e.razao_social, 'Equipe própria') as empresa, count(*)::int as quantidade
       from alocacao_pessoa x join pessoa p on p.id = x.pessoa_id left join empresa e on e.id = p.empresa_id
      where x.obra_id = $1 and x.inicio <= $2 and coalesce(x.fim, 'infinity'::date) >= $2
      group by 1, 2 order by 2, 1`, [obraId, data])).rows as { funcao: string; empresa: string; quantidade: number }[];
}

// ---------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------
export type PainelModuloEquipes = {
  pessoas: Pessoa[]; equipamentos: Equipamento[]; empresas: EmpresaDocumentos[];
  obras: { id: string; codigo: string; nome: string; pessoas: number; equipamentos: number; horasMes: number }[];
  ativas: number; pendentes: number; vencendo: number; indisponiveis: number; documentosVencidos: number; documentosVencendo: number;
  podeGerenciar: boolean;
};

export async function painelModuloEquipes(a: Ator): Promise<PainelModuloEquipes> {
  exigirVer(a, "equipes.ver");
  const [pessoas, equipamentos, empresas] = await Promise.all([listarPessoas(a), listarEquipamentos(a), documentosDasEmpresas(a)]);
  const obras = await comContexto(ctxCampo(a), async (c) => {
    const v = obrasVisiveis(a, "o.id", 1);
    return (await c.query(
      `select o.id, o.codigo, o.nome,
              (select count(*)::int from alocacao_pessoa x where x.obra_id = o.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local()) as pessoas,
              (select count(*)::int from alocacao_equipamento x where x.obra_id = o.id and x.inicio <= hoje_local() and coalesce(x.fim, 'infinity'::date) >= hoje_local()) as equipamentos,
              coalesce((select sum(z.horas_normais + z.horas_extras) from apontamento z where z.obra_id = o.id and z.data >= date_trunc('month', hoje_local())), 0)::float8 as "horasMes"
         from obra o where o.situacao in ('em_execucao', 'paralisada') and ${v.sql} order by o.codigo`, v.params)).rows;
  });
  const h = hoje();
  const limite = new Date(Date.parse(`${h}T12:00:00Z`) + AVISO_DIAS * 86400000).toISOString().slice(0, 10);
  const ativas = pessoas.filter((p) => p.ativa);
  return {
    pessoas, equipamentos, empresas, obras,
    ativas: ativas.length, pendentes: ativas.filter((p) => p.pendencia).length,
    vencendo: ativas.filter((p) => !p.pendencia && p.proximoVencimento && p.proximoVencimento <= limite).length,
    indisponiveis: equipamentos.filter((q) => q.ativo && !q.disponivel).length,
    documentosVencidos: empresas.reduce((s, e) => s + e.vencidos, 0), documentosVencendo: empresas.reduce((s, e) => s + e.vencendo, 0),
    podeGerenciar: pode(a, "equipes.gerenciar"),
  };
}

/** Pendências de equipes para a página inicial. */
export async function pendenciasDeEquipes(a: Ator) {
  if (!pode(a, "equipes.ver")) return null;
  const p = await painelModuloEquipes(a);
  return { pendentes: p.pendentes, vencendo: p.vencendo, indisponiveis: p.indisponiveis, documentosVencidos: p.documentosVencidos };
}
