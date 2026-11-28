"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ErroDeRegra } from "@/lib/db";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import {
  adicionarGarantia, assinarContrato, criarContrato, definirExecutor, designar, salvarContrato, salvarEmpresa,
  type DadosContrato, type Executor, type Modalidade, type Natureza, type Regime, type TipoEmpresa,
} from "@/servicos/contratos";
import { SemPermissao } from "@/servicos/permissoes";

export type Estado = { erro?: string; ok?: string };

const t = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const ator = async () => comoAtor(await exigirUsuario());

function falha(e: unknown): Estado {
  if (e instanceof ErroDeRegra || e instanceof SemPermissao) return { erro: e.message };
  throw e;
}

async function executar(id: string, fn: () => Promise<unknown>, ok?: string): Promise<Estado> {
  try {
    await fn();
  } catch (e) {
    return falha(e);
  }
  revalidatePath(`/contratos/${id}`);
  revalidatePath("/contratos");
  return ok ? { ok } : {};
}

function lerContrato(f: FormData): Omit<DadosContrato, "orcamentoId"> {
  return {
    empresaId: t(f, "empresaId") || null, numero: t(f, "numero"), processo: t(f, "processo"), objeto: t(f, "objeto"),
    regime: t(f, "regime") as Regime, natureza: t(f, "natureza") as Natureza, desconto: t(f, "desconto") || "0",
    dataAssinatura: t(f, "dataAssinatura"), dataOrdemServico: t(f, "dataOrdemServico"), prazoExecucaoDias: t(f, "prazoExecucaoDias"),
    vigenciaFim: t(f, "vigenciaFim"), dataBase: t(f, "dataBase"), indiceReajuste: t(f, "indiceReajuste"),
    gestorId: t(f, "gestorId") || null, fiscalId: t(f, "fiscalId") || null,
  };
}

export async function acaoCriarContrato(_: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  let id: string;
  try {
    id = await criarContrato(a, { ...lerContrato(f), orcamentoId: t(f, "orcamentoId") });
  } catch (e) {
    return falha(e);
  }
  revalidatePath("/contratos");
  redirect(`/contratos/${id}`);
}

export async function acaoSalvarContrato(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => salvarContrato(a, id, lerContrato(f)), "Dados salvos.");
}

export async function acaoExecutor(id: string, itemId: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => definirExecutor(a, id, itemId, t(f, "executor") as Executor));
}

export async function acaoAssinar(id: string): Promise<Estado> {
  const a = await ator();
  const res: { lb?: Awaited<ReturnType<typeof assinarContrato>> } = {};
  const r = await executar(id, async () => { res.lb = await assinarContrato(a, id); });
  const lb = res.lb;
  if (r.erro) return r;
  return { ok: lb === "gravada" ? "Contrato assinado. O cronograma foi gravado como linha de base."
    : lb === "pendente" ? "Contrato assinado. O cronograma tem pendências e continua em elaboração; grave a linha de base quando resolver."
    : "Contrato assinado." };
}

export async function acaoDesignar(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => designar(a, id, t(f, "gestorId") || null, t(f, "fiscalId") || null), "Designação salva.");
}

export async function acaoGarantia(id: string, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  return executar(id, () => adicionarGarantia(a, id, {
    modalidade: t(f, "modalidade") as Modalidade, valor: t(f, "valor"), instituicao: t(f, "instituicao"), documento: t(f, "documento"),
    inicio: t(f, "inicio"), vencimento: t(f, "vencimento"),
  }), "Garantia registrada.");
}

export async function acaoEmpresa(id: string | null, _: Estado, f: FormData): Promise<Estado> {
  const a = await ator();
  try {
    await salvarEmpresa(a, {
      razaoSocial: t(f, "razaoSocial"), cnpj: t(f, "cnpj"), tipo: (t(f, "tipo") || "contratada") as TipoEmpresa,
      responsavel: t(f, "responsavel"), email: t(f, "email"), telefone: t(f, "telefone"),
    }, id ?? undefined);
  } catch (e) {
    return falha(e);
  }
  revalidatePath("/contratos/empresas");
  revalidatePath("/contratos/novo");
  return { ok: id ? "Empresa atualizada." : "Empresa cadastrada." };
}
