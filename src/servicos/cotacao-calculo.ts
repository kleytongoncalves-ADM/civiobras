/**
 * Contas da cotação de materiais: mapa comparativo e apuração.
 * Funções puras, sem banco, para que o resultado possa ser refeito e conferido.
 */
import { ajustar, dec, div, mul, texto, ZERO, type Dec, type Regra } from "../lib/decimal";

export type Criterio = "item" | "global" | "custo_beneficio";
export type Pesos = { preco: number; prazo: number; pagamento: number; garantia: number; historico: number };
export const PESOS_PADRAO: Pesos = { preco: 100, prazo: 0, pagamento: 0, garantia: 0, historico: 0 };
export const FATORES: (keyof Pesos)[] = ["preco", "prazo", "pagamento", "garantia", "historico"];
export const ROTULO_FATOR: Record<keyof Pesos, string> = {
  preco: "Preço", prazo: "Prazo de entrega", pagamento: "Condição de pagamento", garantia: "Garantia", historico: "Histórico de entregas",
};
export const ROTULO_CRITERIO_APURACAO: Record<Criterio, string> = {
  item: "Menor preço por item", global: "Menor preço global", custo_beneficio: "Melhor custo-benefício",
};

export type Limites = { abaixo: number; acima: number; tolerancia: number };
/** Preço sinalizado quando fica 50% abaixo ou 100% acima da mediana ou da referência. "Igual" cobre ±1%. */
export const LIMITES_PADRAO: Limites = { abaixo: 50, acima: 100, tolerancia: 1 };

export type MaterialC = { id: string; codigo: string; descricao: string; unidade: string; quantidade: string; precoReferencia: string | null; semSinapi: boolean };
export type ItemProposta = { preco: string | null; marca: string | null; modelo: string | null; observacao?: string | null; indisponivel: boolean };
export type PropostaC = {
  conviteId: string; fornecedor: string; enviadaEm: string;
  prazoEntrega: number | null; pagamentoDias: number | null; garantiaMeses: number | null; historico: number | null;
  /** Frete cobrado à parte (R$). Entra na comparação rateado pelos itens cotados. */
  frete?: string | null;
  itens: Record<string, ItemProposta>;
};
export type AvaliacaoC = { conviteId: string; materialId: string; tipo: "nao_atende" | "desconsiderado"; justificativa: string };

export type ClasseSinapi = "abaixo" | "igual" | "acima";
export type Oferta = {
  conviteId: string; preco: string | null; precoSemFrete: string | null; total: string | null; marca: string | null; modelo: string | null; observacao: string | null;
  indisponivel: boolean; excluida: AvaliacaoC["tipo"] | null; justificativa: string | null;
  difSinapi: number | null; classe: ClasseSinapi | null; discrepante: "baixo" | "alto" | null; menor: boolean;
};
export type LinhaMapa = {
  material: MaterialC; refTotal: string | null; ofertas: Oferta[];
  menor: { conviteId: string; preco: string; total: string } | null;
  validas: number; diferencaPropostas: number | null; economia: string | null; classe: ClasseSinapi | null;
};
export type TotalFornecedor = {
  conviteId: string; fornecedor: string; total: string; frete: string; itensCotados: number; itens: number; completa: boolean;
  refCotados: string; difSinapi: number | null; classe: ClasseSinapi | null; itensVencidos: number; valorVencido: string;
};
export type Mapa = {
  linhas: LinhaMapa[]; fornecedores: TotalFornecedor[];
  totalReferencia: string; itensComReferencia: number; itensCotados: number; itensComTres: number;
  menorGlobal: { conviteId: string; fornecedor: string; total: string } | null;
  economiaGlobal: string | null; economiaGlobalPct: number | null;
  somaMenores: string; refDosMenores: string; economiaPorItem: string; economiaPorItemPct: number | null;
  custoConcentrar: string | null; discrepantes: number;
};

const pct = (a: Dec, b: Dec) => (b === ZERO ? null : Number(texto(div(a - b, b) * 100n, 4)));
const classificar = (d: number | null, tol: number): ClasseSinapi | null => (d == null ? null : Math.abs(d) <= tol ? "igual" : d < 0 ? "abaixo" : "acima");
function mediana(v: Dec[]): Dec {
  const o = [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2n;
}

/** Desempate fixo: menor prazo de entrega, depois a proposta enviada primeiro. */
function antes(a: PropostaC, b: PropostaC) {
  const pa = a.prazoEntrega ?? Number.MAX_SAFE_INTEGER, pb = b.prazoEntrega ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.enviadaEm < b.enviadaEm ? -1 : a.enviadaEm > b.enviadaEm ? 1 : a.conviteId < b.conviteId ? -1 : 1;
}

/**
 * Fração do frete sobre o valor dos itens cotados de cada proposta. O preço comparado de cada item
 * é o preço com o frete rateado: preço × (1 + frete ÷ soma dos itens cotados).
 */
function fatoresDeFrete(materiais: MaterialC[], propostas: PropostaC[]) {
  return new Map(propostas.map((p) => {
    const frete = p.frete ? dec(p.frete) : ZERO;
    if (frete <= ZERO) return [p.conviteId, { frete: ZERO, fator: ZERO }] as const;
    const soma = materiais.reduce((t, m) => {
      const i = p.itens[m.id];
      return !i || i.indisponivel || i.preco == null ? t : t + mul(dec(m.quantidade), dec(i.preco));
    }, ZERO);
    return [p.conviteId, { frete, fator: soma > ZERO ? div(frete, soma) : ZERO }] as const;
  }));
}

export function comparar(materiais: MaterialC[], propostas: PropostaC[], avaliacoes: AvaliacaoC[], regra: Regra, limites: Limites = LIMITES_PADRAO): Mapa {
  const fretes = fatoresDeFrete(materiais, propostas);
  const excl = new Map(avaliacoes.map((a) => [`${a.conviteId}|${a.materialId}`, a]));
  const porConvite = new Map(propostas.map((p) => [p.conviteId, p]));
  const acum = new Map(propostas.map((p) => [p.conviteId, { total: ZERO, ref: ZERO, cotados: 0, vencidos: 0, valorVencido: ZERO }]));
  let totalRef = ZERO, comRef = 0, cotados = 0, comTres = 0, somaMenores = ZERO, refMenores = ZERO, discrepantes = 0;

  const linhas = materiais.map((m): LinhaMapa => {
    const qtd = dec(m.quantidade);
    const ref = m.precoReferencia == null ? null : dec(m.precoReferencia);
    const refTotal = ref == null ? null : ajustar(mul(qtd, ref), 2, regra);
    if (refTotal != null) { totalRef += refTotal; comRef += 1; }
    const validos: { p: PropostaC; preco: Dec }[] = [];
    const ofertas = propostas.map((p): Oferta => {
      const i = p.itens[m.id];
      const av = excl.get(`${p.conviteId}|${m.id}`) ?? null;
      const base = { conviteId: p.conviteId, marca: i?.marca ?? null, modelo: i?.modelo ?? null, observacao: i?.observacao ?? null,
        excluida: av?.tipo ?? null, justificativa: av?.justificativa ?? null, discrepante: null, menor: false } as const;
      if (!i || i.indisponivel || i.preco == null) return { ...base, preco: null, precoSemFrete: null, total: null, indisponivel: true, difSinapi: null, classe: null };
      const semFrete = dec(i.preco);
      const preco = semFrete + mul(semFrete, fretes.get(p.conviteId)!.fator);
      if (!av) validos.push({ p, preco });
      const d = ref == null || m.semSinapi ? null : pct(preco, ref);
      return { ...base, preco: texto(preco, 4), precoSemFrete: texto(semFrete, 4), total: texto(ajustar(mul(qtd, preco), 2, regra)), indisponivel: false, difSinapi: d, classe: classificar(d, limites.tolerancia) };
    });

    const med = validos.length >= 3 ? mediana(validos.map((v) => v.preco)) : null;
    for (const o of ofertas) {
      if (o.preco == null || o.excluida) continue;
      const preco = dec(o.preco);
      const fora = (b: Dec | null) => (b == null || b === ZERO ? null : preco * 100n < b * BigInt(100 - limites.abaixo) ? "baixo" : preco * 100n > b * BigInt(100 + limites.acima) ? "alto" : null);
      o.discrepante = fora(med) ?? (m.semSinapi ? null : fora(ref));
      if (o.discrepante) discrepantes += 1;
      const a = acum.get(o.conviteId)!;
      a.total += dec(o.total!); a.cotados += 1;
      if (refTotal != null) a.ref += refTotal;
    }

    let menor: LinhaMapa["menor"] = null, diferenca: number | null = null, economia: string | null = null, classe: ClasseSinapi | null = null;
    if (validos.length) {
      cotados += 1;
      if (validos.length >= 3) comTres += 1;
      validos.sort((a, b) => (a.preco < b.preco ? -1 : a.preco > b.preco ? 1 : antes(a.p, b.p)));
      const v = validos[0], maior = validos[validos.length - 1].preco;
      const total = ajustar(mul(qtd, v.preco), 2, regra);
      menor = { conviteId: v.p.conviteId, preco: texto(v.preco, 4), total: texto(total) };
      ofertas.find((o) => o.conviteId === v.p.conviteId)!.menor = true;
      diferenca = validos.length > 1 ? pct(maior, v.preco) : null;
      somaMenores += total;
      const a = acum.get(v.p.conviteId)!;
      a.vencidos += 1; a.valorVencido += total;
      if (refTotal != null && !m.semSinapi) {
        refMenores += refTotal;
        economia = texto(refTotal - total);
        classe = classificar(pct(v.preco, ref!), limites.tolerancia);
      }
    }
    return { material: m, refTotal: refTotal == null ? null : texto(refTotal), ofertas, menor, validas: validos.length, diferencaPropostas: diferenca, economia, classe };
  });

  const fornecedores = propostas.map((p): TotalFornecedor => {
    const a = acum.get(p.conviteId)!;
    const d = a.cotados ? pct(a.total, a.ref) : null;
    return {
      conviteId: p.conviteId, fornecedor: p.fornecedor, total: texto(a.total), frete: texto(fretes.get(p.conviteId)!.frete), itensCotados: a.cotados, itens: materiais.length,
      completa: a.cotados === materiais.length && materiais.length > 0, refCotados: texto(a.ref), difSinapi: d, classe: classificar(d, limites.tolerancia),
      itensVencidos: a.vencidos, valorVencido: texto(a.valorVencido),
    };
  });

  const completas = fornecedores.filter((f) => f.completa)
    .sort((a, b) => (dec(a.total) < dec(b.total) ? -1 : dec(a.total) > dec(b.total) ? 1 : antes(porConvite.get(a.conviteId)!, porConvite.get(b.conviteId)!)));
  const mg = completas[0] ?? null;
  const ecoGlobal = mg && comRef === materiais.length ? totalRef - dec(mg.total) : null;
  const ecoItem = refMenores - linhas.reduce((s, l) => (l.menor && l.economia != null ? s + dec(l.menor.total) : s), ZERO);
  return {
    linhas, fornecedores, totalReferencia: texto(totalRef), itensComReferencia: comRef, itensCotados: cotados, itensComTres: comTres,
    menorGlobal: mg ? { conviteId: mg.conviteId, fornecedor: mg.fornecedor, total: mg.total } : null,
    economiaGlobal: ecoGlobal == null ? null : texto(ecoGlobal),
    economiaGlobalPct: ecoGlobal == null || totalRef === ZERO ? null : Number(texto(div(ecoGlobal, totalRef) * 100n, 2)),
    somaMenores: texto(somaMenores), refDosMenores: texto(refMenores), economiaPorItem: texto(ecoItem),
    economiaPorItemPct: refMenores === ZERO ? null : Number(texto(div(ecoItem, refMenores) * 100n, 2)),
    custoConcentrar: mg && cotados === materiais.length ? texto(dec(mg.total) - somaMenores) : null, discrepantes,
  };
}

// ---------------------------------------------------------------------------
// Apuração
// ---------------------------------------------------------------------------
export type Classificado = {
  posicao: number; conviteId: string; fornecedor: string; total: string; itensCotados: number; itensVencidos: number; valorVencido: string;
  nota: number | null; notas: Partial<Record<keyof Pesos, number>> | null;
  prazoEntrega: number | null; pagamentoDias: number | null; garantiaMeses: number | null; historico: number | null; enviadaEm: string;
};
export type ItemApurado = { materialId: string; codigo: string; descricao: string; unidade: string; quantidade: string; refTotal: string | null;
  conviteId: string | null; fornecedor: string | null; preco: string | null; total: string | null; marca: string | null; modelo: string | null; economia: string | null };
export type Apuracao = {
  criterio: Criterio; pesos: Pesos; classificacao: Classificado[]; itens: ItemApurado[];
  vencedor: { conviteId: string; fornecedor: string } | null;
  totalReferencia: string; totalResultado: string; economia: string | null; economiaPct: number | null;
  semVencedor: string | null; desempate: string; desconsiderados: (AvaliacaoC & { fornecedor: string; codigo: string; descricao: string; preco: string | null })[];
};

export function validarPesos(p: Pesos) {
  for (const k of FATORES) if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 100) return "Os pesos são números inteiros de 0 a 100.";
  if (FATORES.reduce((s, k) => s + p[k], 0) !== 100) return "Os pesos precisam somar 100.";
  if (p.preco < 50) return "O preço pesa ao menos 50.";
  return null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function apurar(mapa: Mapa, propostas: PropostaC[], avaliacoes: AvaliacaoC[], criterio: Criterio, pesos: Pesos, escolhido?: string | null): Apuracao {
  const porConvite = new Map(propostas.map((p) => [p.conviteId, p]));
  const nome = (id: string) => porConvite.get(id)?.fornecedor ?? "";
  const totais = new Map(mapa.fornecedores.map((f) => [f.conviteId, f]));
  const linha = (f: TotalFornecedor, posicao: number, nota: number | null = null, notas: Classificado["notas"] = null): Classificado => {
    const p = porConvite.get(f.conviteId)!;
    return { posicao, conviteId: f.conviteId, fornecedor: f.fornecedor, total: f.total, itensCotados: f.itensCotados, itensVencidos: f.itensVencidos, valorVencido: f.valorVencido,
      nota, notas, prazoEntrega: p.prazoEntrega, pagamentoDias: p.pagamentoDias, garantiaMeses: p.garantiaMeses, historico: p.historico, enviadaEm: p.enviadaEm };
  };
  const ordem = (a: TotalFornecedor, b: TotalFornecedor) => antes(porConvite.get(a.conviteId)!, porConvite.get(b.conviteId)!);
  const porTotal = (a: TotalFornecedor, b: TotalFornecedor) => (dec(a.total) < dec(b.total) ? -1 : dec(a.total) > dec(b.total) ? 1 : ordem(a, b));

  let classificacao: Classificado[] = [];
  let semVencedor: string | null = null;
  let vencedorId: string | null = null;
  const completas = mapa.fornecedores.filter((f) => f.completa);

  if (criterio === "item") {
    classificacao = [...mapa.fornecedores].filter((f) => f.itensCotados > 0)
      .sort((a, b) => b.itensVencidos - a.itensVencidos || (dec(b.valorVencido) > dec(a.valorVencido) ? 1 : -1) || ordem(a, b)).map((f, i) => linha(f, i + 1));
    if (!mapa.itensCotados) semVencedor = "Nenhum item recebeu preço válido.";
  } else if (!completas.length) {
    semVencedor = "Nenhuma proposta cotou todos os itens. Sem proposta completa não há vencedor pelo total.";
    classificacao = [...mapa.fornecedores].filter((f) => f.itensCotados > 0).sort(porTotal).map((f, i) => linha(f, i + 1));
  } else if (criterio === "global") {
    classificacao = [...completas].sort(porTotal).map((f, i) => linha(f, i + 1));
    vencedorId = classificacao[0].conviteId;
  } else {
    const ps = completas.map((f) => porConvite.get(f.conviteId)!);
    const menorTotal = Math.min(...completas.map((f) => Number(f.total)));
    const prazos = ps.map((p) => p.prazoEntrega).filter((v): v is number => v != null);
    const menorPrazo = prazos.length ? Math.min(...prazos) : null;
    const maiorPag = Math.max(0, ...ps.map((p) => p.pagamentoDias ?? 0));
    const maiorGar = Math.max(0, ...ps.map((p) => p.garantiaMeses ?? 0));
    const hist = ps.map((p) => p.historico).filter((v): v is number => v != null);
    const mediaHist = hist.length ? hist.reduce((s, v) => s + v, 0) / hist.length : 0;
    const notas = completas.map((f) => {
      const p = porConvite.get(f.conviteId)!;
      const n: Record<keyof Pesos, number> = {
        preco: Number(f.total) > 0 ? r2((menorTotal / Number(f.total)) * 100) : 0,
        prazo: p.prazoEntrega == null || menorPrazo == null ? 0 : p.prazoEntrega === 0 ? 100 : r2((menorPrazo / p.prazoEntrega) * 100),
        pagamento: maiorPag ? r2(((p.pagamentoDias ?? 0) / maiorPag) * 100) : 0,
        garantia: maiorGar ? r2(((p.garantiaMeses ?? 0) / maiorGar) * 100) : 0,
        historico: r2(p.historico ?? mediaHist),
      };
      return { f, n, nota: r2(FATORES.reduce((s, k) => s + (n[k] * pesos[k]) / 100, 0)) };
    });
    notas.sort((a, b) => b.nota - a.nota || porTotal(a.f, b.f));
    classificacao = notas.map((x, i) => linha(x.f, i + 1, x.nota, x.n));
    vencedorId = classificacao[0].conviteId;
  }

  const escolha = criterio !== "item" && escolhido && totais.get(escolhido)?.completa ? escolhido : vencedorId;
  const itens = mapa.linhas.map((l): ItemApurado => {
    const m = l.material;
    const base = { materialId: m.id, codigo: m.codigo, descricao: m.descricao, unidade: m.unidade, quantidade: m.quantidade, refTotal: l.refTotal };
    const o = criterio === "item" ? l.ofertas.find((x) => x.menor) : l.ofertas.find((x) => x.conviteId === escolha && x.preco != null && !x.excluida);
    if (!o) return { ...base, conviteId: null, fornecedor: null, preco: null, total: null, marca: null, modelo: null, economia: null };
    return { ...base, conviteId: o.conviteId, fornecedor: nome(o.conviteId), preco: o.preco, total: o.total, marca: o.marca, modelo: o.modelo,
      economia: l.refTotal != null && !m.semSinapi ? texto(dec(l.refTotal) - dec(o.total!)) : null };
  });
  const totalResultado = itens.reduce((s, i) => s + dec(i.total ?? "0"), ZERO);
  const refCobertos = itens.reduce((s, i) => (i.economia != null ? s + dec(i.refTotal!) : s), ZERO);
  const eco = itens.reduce((s, i) => (i.economia != null ? s + dec(i.economia) : s), ZERO);
  const temResultado = itens.some((i) => i.conviteId);

  return {
    criterio, pesos, classificacao, itens,
    vencedor: escolha ? { conviteId: escolha, fornecedor: nome(escolha) } : null,
    totalReferencia: mapa.totalReferencia, totalResultado: texto(totalResultado),
    economia: temResultado && refCobertos !== ZERO ? texto(eco) : null,
    economiaPct: temResultado && refCobertos !== ZERO ? Number(texto(div(eco, refCobertos) * 100n, 2)) : null,
    semVencedor, desempate: "Menor prazo de entrega; persistindo, a proposta enviada primeiro.",
    desconsiderados: avaliacoes.map((a) => {
      const l = mapa.linhas.find((x) => x.material.id === a.materialId);
      return { ...a, fornecedor: nome(a.conviteId), codigo: l?.material.codigo ?? "", descricao: l?.material.descricao ?? "",
        preco: l?.ofertas.find((o) => o.conviteId === a.conviteId)?.preco ?? null };
    }),
  };
}

// ---------------------------------------------------------------------------
// Comparação automática
// ---------------------------------------------------------------------------
/** Pesos usados na comparação de custo-benefício quando a solicitação não definiu os seus. */
export const PESOS_EQUILIBRIO: Pesos = { preco: 60, prazo: 20, pagamento: 5, garantia: 15, historico: 0 };

/** Média e mediana dos preços unitários de um item. Só entram preços informados: item indisponível, zerado ou retirado da disputa fica de fora. */
export function mediaMediana(l: LinhaMapa): { media: number | null; mediana: number | null; menor: number | null; maior: number | null; precos: number } {
  const v = l.ofertas.filter((o) => o.preco != null && !o.excluida).map((o) => Number(o.preco)).filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return { media: null, mediana: null, menor: null, maior: null, precos: 0 };
  const m = Math.floor(v.length / 2);
  return { media: v.reduce((s, x) => s + x, 0) / v.length, mediana: v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, menor: v[0], maior: v[v.length - 1], precos: v.length };
}

export type Comparacao = {
  porItem: { total: string; fornecedores: { fornecedor: string; itens: number; valor: string }[] } | null;
  global: { fornecedor: string; total: string } | null;
  custoBeneficio: { fornecedor: string; total: string; nota: number | null } | null;
  pesos: Pesos; pesosDaSolicitacao: boolean; classificacao: Classificado[];
};

/** Melhor preço (por item e global) e melhor custo-benefício, calculados sempre, qualquer que seja o critério da solicitação. */
export function compararAutomatico(mapa: Mapa, propostas: PropostaC[], avaliacoes: AvaliacaoC[], criterio: Criterio, pesosSolicitacao: Pesos): Comparacao {
  const daSolicitacao = criterio === "custo_beneficio";
  const pesos = daSolicitacao ? pesosSolicitacao : PESOS_EQUILIBRIO;
  const cb = apurar(mapa, propostas, avaliacoes, "custo_beneficio", pesos);
  const venc = mapa.fornecedores.filter((f) => f.itensVencidos > 0).sort((a, b) => b.itensVencidos - a.itensVencidos || Number(b.valorVencido) - Number(a.valorVencido));
  const primeiro = cb.semVencedor ? null : cb.classificacao[0] ?? null;
  return {
    porItem: mapa.itensCotados ? { total: mapa.somaMenores, fornecedores: venc.map((f) => ({ fornecedor: f.fornecedor, itens: f.itensVencidos, valor: f.valorVencido })) } : null,
    global: mapa.menorGlobal ? { fornecedor: mapa.menorGlobal.fornecedor, total: mapa.menorGlobal.total } : null,
    custoBeneficio: primeiro ? { fornecedor: primeiro.fornecedor, total: primeiro.total, nota: primeiro.nota } : null,
    pesos, pesosDaSolicitacao: daSolicitacao, classificacao: cb.semVencedor ? [] : cb.classificacao,
  };
}

/** Total da média e da mediana: quantidade × valor de cada item, somados. */
export function totaisMediaMediana(mapa: Mapa): { media: number | null; mediana: number | null } {
  const est = mapa.linhas.map((l) => ({ q: Number(l.material.quantidade), ...mediaMediana(l) }));
  const somar = (k: "media" | "mediana") => (est.some((e) => e[k] != null) ? est.reduce((t, e) => t + (e[k] == null ? 0 : Math.round(e.q * e[k]! * 100) / 100), 0) : null);
  return { media: somar("media"), mediana: somar("mediana") };
}
