"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ErroDeRegra } from "@/lib/db";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { lancarMuro, sugerirMuro, type LinhaMuro, type ParametrosMuro } from "@/servicos/assistente-muro";
import { PARCELAS_BDI, type Bdi, type TipoObraBdi } from "@/servicos/calculo";
import {
  adicionarComposicao, adicionarCotacao, adicionarEtapa, adicionarInsumo, adicionarItemCotado, aprovarOrcamento,
  cancelarOrcamento, criarOrcamento, editarItem, novaVersao, removerCotacao, removerEtapa, removerItem, renomearEtapa, salvarMedidas,
  salvarCronograma, salvarDadosGerais, trocarBase, type CriterioCotacao,
  configurarMontagem, etapaPeloNome, moverEtapa, moverItem, alterarQuantidade,
} from "@/servicos/orcamentos";
import { SemPermissao } from "@/servicos/permissoes";
import type { TipoInsumo } from "@/servicos/precos";
import type { Regra } from "@/lib/decimal";

export type Estado = { erro?: string; ok?: string; dados?: unknown };

const t = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const ator = async () => comoAtor(await exigirUsuario());

function falha(e: unknown): Estado {
  if (e instanceof ErroDeRegra || e instanceof SemPermissao) return { erro: e.message };
  throw e;
}

/** Executa, atualiza as telas do orçamento e devolve o estado para o formulário. */
async function executar(id: string, fn: () => Promise<unknown>, ok?: string): Promise<Estado> {
  try {
    await fn();
  } catch (e) {
    return falha(e);
  }
  revalidatePath(`/orcamentos/${id}`, "layout");
  return ok ? { ok } : {};
}

export async function acaoCriarOrcamento(_: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  let id: string;
  try {
    id = await criarOrcamento(a, {
      obraId: t(f, "obraId"), nome: t(f, "nome"), tabelaId: t(f, "tabelaId"),
      arredondamento: (t(f, "arredondamento") || null) as Regra | null, tipoObraBdi: t(f, "tipoObraBdi") as TipoObraBdi,
    });
  } catch (e) {
    return falha(e);
  }
  revalidatePath("/orcamentos");
  redirect(`/orcamentos/${id}/montar?escolher=1`);
}

export async function acaoEtapa(id: string, etapaId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  if (t(f, "acao") === "remover") return executar(id, () => removerEtapa(a, id, etapaId));
  return executar(id, () => renomearEtapa(a, id, etapaId, t(f, "nome")));
}

export async function acaoNovaEtapa(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => adicionarEtapa(a, id, t(f, "nome")));
}

export async function acaoAdicionarItem(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const base = { etapaId: t(f, "etapaId"), quantidade: t(f, "quantidade"), memoria: t(f, "memoria"), tipoBdi: (t(f, "tipoBdi") || "obra") as "obra" | "fornecimento" };
  const tipo = t(f, "tipo");
  return executar(id, async () => {
    if (tipo === "composicao") await adicionarComposicao(a, id, t(f, "refId"), base);
    else if (tipo === "insumo") await adicionarInsumo(a, id, t(f, "refId"), base);
    else await adicionarItemCotado(a, id, {
      ...base, descricao: t(f, "descricao"), unidade: t(f, "unidade"), tipo: (t(f, "tipoInsumo") || "material") as TipoInsumo,
      criterio: (t(f, "criterio") || "mediana") as CriterioCotacao, justificativa: t(f, "justificativa"),
    });
  }, "Item incluído.");
}

export async function acaoEditarItem(id: string, itemId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  if (t(f, "acao") === "remover") return executar(id, () => removerItem(a, id, itemId));
  return executar(id, () => editarItem(a, id, itemId, {
    quantidade: t(f, "quantidade"), memoria: t(f, "memoria"), tipoBdi: (t(f, "tipoBdi") || undefined) as "obra" | "fornecimento" | undefined,
  }), "Item atualizado.");
}

export async function acaoRemoverItem(id: string, itemId: string): Promise<Estado> {
  const a = await ator();
  try {
    await removerItem(a, id, itemId);
  } catch (e) {
    return falha(e);
  }
  revalidatePath(`/orcamentos/${id}`, "layout");
  redirect(`/orcamentos/${id}`);
}

export async function acaoCotacao(id: string, itemId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  if (t(f, "acao") === "remover") return executar(id, () => removerCotacao(a, id, itemId, t(f, "cotacaoId")));
  return executar(id, () => adicionarCotacao(a, id, itemId, {
    fornecedor: t(f, "fornecedor"), cnpj: t(f, "cnpj"), data: t(f, "data"), valor: t(f, "valor"), validade: t(f, "validade"),
  }), "Cotação registrada.");
}

export async function acaoDadosGerais(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const bdi = (prefixo: string) => Object.fromEntries(PARCELAS_BDI.map((p) => [p, t(f, `${prefixo}_${p}`)])) as Bdi;
  return executar(id, () => salvarDadosGerais(a, id, {
    nome: t(f, "nome"), arredondamento: t(f, "arredondamento") as Regra, tipoObraBdi: t(f, "tipoObraBdi") as TipoObraBdi,
    bdiObra: bdi("obra"), bdiFornecimento: bdi("forn"),
    encargosHorista: t(f, "encargosHorista"), encargosMensalista: t(f, "encargosMensalista"),
    responsavelTecnico: t(f, "responsavelTecnico"), registroProfissional: t(f, "registroProfissional"), art: t(f, "art"),
  }), "Dados salvos.");
}

export async function acaoTrocarBase(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => trocarBase(a, id, t(f, "tabelaId")), "Preços atualizados para a nova base.");
}

export async function acaoCronograma(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const percentuais: Record<string, Record<number, string>> = {};
  for (const [k, v] of f.entries()) {
    const m = /^p_([0-9a-f-]{36})_(\d+)$/.exec(k);
    if (!m) continue;
    (percentuais[m[1]] ??= {})[Number(m[2])] = String(v);
  }
  return executar(id, () => salvarCronograma(a, id, {
    periodos: Number(t(f, "periodos")), unidadePeriodo: t(f, "unidadePeriodo") as "semana" | "mes", inicio: t(f, "inicio"), percentuais,
  }), "Cronograma salvo.");
}

export async function acaoAprovar(id: string): Promise<Estado> {
  const a = await ator();
  try {
    await aprovarOrcamento(a, id);
  } catch (e) {
    return falha(e);
  }
  revalidatePath("/", "layout");
  redirect(`/orcamentos/${id}/nota`);
}

export async function acaoCancelar(id: string): Promise<Estado> {
  const a = await ator();
  return executar(id, () => cancelarOrcamento(a, id), "Orçamento cancelado.");
}

export async function acaoNovaVersao(id: string): Promise<Estado> {
  const a = await ator();
  let novo: string;
  try {
    novo = await novaVersao(a, id);
  } catch (e) {
    return falha(e);
  }
  revalidatePath("/orcamentos");
  redirect(`/orcamentos/${novo}`);
}

export async function acaoSugerirMuro(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const p: ParametrosMuro = {
    comprimento: t(f, "comprimento"), altura: t(f, "altura"), vaoPilaretes: t(f, "vaoPilaretes"), larguraSapata: t(f, "larguraSapata"),
    alturaSapata: t(f, "alturaSapata"), profundidadeVala: t(f, "profundidadeVala"), larguraVala: t(f, "larguraVala"), faces: t(f, "faces") === "1" ? "1" : "2",
  };
  try {
    const linhas: LinhaMuro[] = await sugerirMuro(a, id, p);
    return { dados: { parametros: p, linhas } };
  } catch (e) {
    return falha(e);
  }
}

export async function acaoLancarMuro(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const chaves = f.getAll("chave").map(String);
  const linhas = chaves.filter((k) => f.get(`usar_${k}`)).map((k) => ({
    composicaoId: t(f, `comp_${k}`), quantidade: t(f, `qtd_${k}`), memoria: t(f, `mem_${k}`),
  }));
  try {
    await lancarMuro(a, id, { nomeEtapa: t(f, "nomeEtapa"), modo: t(f, "modo") === "material" ? "material" : "servico", linhas });
  } catch (e) {
    return falha(e);
  }
  revalidatePath(`/orcamentos/${id}`, "layout");
  redirect(`/orcamentos/${id}`);
}

const metros = (v: string) => { if (!v) return null; const n = Number(v.replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

export async function acaoMedidas3d(id: string, itemId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => salvarMedidas(a, id, itemId, { local: t(f, "local"), altura: metros(t(f, "altura")), comprimento: metros(t(f, "comprimento")), etapaInteira: f.get("etapaInteira") === "on" }));
}

/** Passo 2 do assistente: como montar e quais bases usar. */
export async function acaoMontagem(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const modo = t(f, "modo") as "assunto" | "livre";
  const r = await executar(id, () => configurarMontagem(a, id, { modo, tabelasExtras: f.getAll("base").map(String) }));
  if (r.erro) return r;
  redirect(`/orcamentos/${id}/montar`);
}

/**
 * Inclusão pelo assistente. A etapa pode ser uma existente ou uma nova pelo nome
 * (por padrão, o nome do assunto).
 */
export async function acaoIncluirDoAssistente(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, async () => {
    const escolha = t(f, "etapaId");
    const etapaId = escolha === "nova" ? await etapaPeloNome(a, id, t(f, "novaEtapa")) : escolha;
    const base = {
      etapaId, quantidade: t(f, "quantidade"), memoria: t(f, "memoria"), tipoBdi: (t(f, "tipoBdi") || "obra") as "obra" | "fornecimento",
      tabelaId: t(f, "tabelaId") || null, assuntoId: t(f, "assuntoId") || null,
    };
    if (t(f, "tipo") === "insumo") await adicionarInsumo(a, id, t(f, "refId"), base);
    else await adicionarComposicao(a, id, t(f, "refId"), base);
  }, "Incluído no orçamento.");
}

/** Inclui de uma vez os serviços pré-selecionados pelo tamanho (pacote do assunto). */
export async function acaoIncluirPacote(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const total = Number(t(f, "linhas")) || 0;
  let incluidos = 0;
  const r = await executar(id, async () => {
    const escolha = t(f, "etapaId");
    const etapaId = escolha === "nova" ? await etapaPeloNome(a, id, t(f, "novaEtapa")) : escolha;
    for (let i = 0; i < total; i++) {
      if (!f.get(`usar_${i}`)) continue;
      const [refId, tabelaId] = t(f, `ref_${i}`).split("|");
      if (!refId) continue;
      await adicionarComposicao(a, id, refId, {
        etapaId, quantidade: t(f, `qtd_${i}`), memoria: t(f, `mem_${i}`), tabelaId: tabelaId || null, assuntoId: t(f, "assuntoId") || null,
      });
      incluidos++;
    }
    if (!incluidos) throw new ErroDeRegra("Marque ao menos um serviço com composição escolhida.");
  });
  if (r.erro) return r;
  return { ok: incluidos === 1 ? "1 serviço incluído." : `${incluidos} serviços incluídos.` };
}

export async function acaoMoverEtapa(id: string, etapaId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => moverEtapa(a, id, etapaId, t(f, "sentido") === "subir" ? "subir" : "descer"));
}

export async function acaoMoverItem(id: string, itemId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  const sentido = t(f, "sentido");
  return executar(id, () => moverItem(a, id, itemId, {
    etapaId: t(f, "etapaId") || undefined, sentido: sentido === "subir" || sentido === "descer" ? sentido : undefined,
  }));
}

/** Revisão: quantidade alterada na própria linha; o botão de lixeira do mesmo formulário remove o item. */
export async function acaoLinhaItem(id: string, itemId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  if (t(f, "acao") === "remover") return executar(id, () => removerItem(a, id, itemId));
  return executar(id, () => alterarQuantidade(a, id, itemId, t(f, "quantidade")));
}
