import { ErroDeRegra } from "@/lib/db";
import { abaComparativo } from "@/lib/excel-comparativo";
import { abaTabela, FORMATO, logo, novaPasta, responderPlanilha, type Linha } from "@/lib/excel-modelo";
import { comoAtor, usuarioAtual } from "@/lib/sessao";
import { formatarCnpj } from "@/servicos/contratos";
import { FATORES, ROTULO_CRITERIO_APURACAO, ROTULO_FATOR } from "@/servicos/cotacao-calculo";
import { obterSolicitacao, protocolo, ROTULO_CONVITE } from "@/servicos/cotacoes";
import { SemPermissao } from "@/servicos/permissoes";
import { ROTULO_FONTE, ROTULO_REGIME, type Fonte, type Regime } from "@/servicos/precos";
import { unidade } from "@/lib/unidade";

const n = (v: string | null | undefined) => (v == null ? null : Number(v));
const FUSO = "America/Sao_Paulo";
const quando = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d)) : "";
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const mesAno = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(0, 4)}`;
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await usuarioAtual();
  if (!u) return new Response("Sessão encerrada.", { status: 401 });
  const a = comoAtor(u);
  let s;
  try {
    s = await obterSolicitacao(a, id);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) return new Response(e.message, { status: 404 });
    throw e;
  }
  const m = s.precosVisiveis ? s.mapa : null;
  const todos = s.precosVisiveis ? s.mapaTodos ?? m : null;
  const dentro = new Set(s.comparadas.map((p) => p.conviteId));
  const ap = s.situacao === "apurada" ? s.apuracoes[0] ?? null : null;
  const r = ap?.resultado ?? null;
  const numero = String(s.numero).padStart(3, "0");
  const doc = {
    orgao: u.orgaoNome, titulo: `Cotação de materiais nº ${numero}`,
    subtitulo: `${s.titulo} · ${s.obraCodigo} · ${s.obraNome}`, geradoEm: new Date(), geradoPor: u.nome,
  };
  const wb = novaPasta(doc);

  // Primeira aba: comparativo de preços no modelo CiviObras, só com os itens e os fornecedores desta cotação.
  const fonte = ROTULO_FONTE[s.fonte as Fonte] ?? s.fonte;
  const linhas = m?.linhas ?? null;
  const fornecedores = m?.fornecedores ?? [];
  await abaComparativo(wb, {
    titulo: `Comparativo de preços · Cotação nº ${numero}`,
    subtitulo: `${s.titulo} · ${u.orgaoNome}`,
    rodape: `CiviObras · Comparativo de preços da cotação nº ${numero} · gerado em ${quando(doc.geradoEm)} por ${u.nome}`,
    identificacao: [
      ["Obra", `${s.obraCodigo} · ${s.obraNome}`],
      ["Orçamento", `Nº ${s.orcamentoNumero} v${s.orcamentoVersao} · ${s.orcamentoNome}`],
      ["Referência de preços", `${fonte} ${s.uf} ${mesAno(s.mes)} · ${ROTULO_REGIME[s.regime as Regime] ?? s.regime}`],
      ["Prazo das propostas", quando(s.prazo)],
    ],
    fonte, regra: s.arredondamento,
    itens: (linhas ? linhas.map((l) => l.material) : s.materiais).map((x) => ({
      codigo: x.semSinapi ? "" : x.codigo, descricao: x.descricao, unidade: unidade(x.unidade), quantidade: Number(x.quantidade),
      referencia: x.semSinapi || x.precoReferencia == null ? null : Number(x.precoReferencia),
    })),
    fornecedores: fornecedores.map((fo) => {
      const conv = s.convites.find((c) => c.id === fo.conviteId);
      const prop = s.propostas.find((p) => p.conviteId === fo.conviteId);
      return {
        nome: fo.fornecedor, cnpj: conv ? formatarCnpj(conv.cnpj) : "",
        precos: linhas!.map((l) => { const o = l.ofertas.find((x) => x.conviteId === fo.conviteId); return o && o.precoSemFrete != null && !o.excluida ? Number(o.precoSemFrete) : null; }),
        frete: s.freteIncluso || !prop ? null : Number(prop.frete) || 0,
      };
    }),
    semPropostas: m ? "Nenhuma proposta recebida até agora." : "Os preços dos fornecedores ficam fechados até o encerramento do prazo.",
  }, await logo());

  await abaTabela(wb, doc, "Fornecedores", {
    titulo: "Fornecedores consultados", paisagem: true,
    colunas: [{ titulo: "Fornecedor", largura: 38 }, { titulo: "CNPJ", largura: 20 }, { titulo: "Contato", largura: 22 }, { titulo: "E-mail", largura: 28 }, { titulo: "Situação", largura: 16 },
      { titulo: "Convite enviado", largura: 17 }, { titulo: "Abriu o link", largura: 17 }, { titulo: "Proposta recebida", largura: 17 }, { titulo: "Versão", largura: 8, alinhar: "center" }, { titulo: "Na comparação", largura: 14, alinhar: "center" },
      { titulo: "Itens cotados", largura: 12, formato: "0" }, { titulo: "Total", largura: 16, formato: FORMATO.moeda }, { titulo: "Observação", largura: 36 }],
    linhas: s.convites.map((c): Linha => ({ valores: [c.razaoSocial, formatarCnpj(c.cnpj), c.contato ?? "", c.email ?? "", ROTULO_CONVITE[c.situacao], quando(c.enviadoEm), quando(c.abertoEm), quando(c.respostaEm),
      c.versao ?? "", c.situacao === "respondeu" ? (c.naComparacao ? "Sim" : "Não") : "", c.cotados, n(todos?.fornecedores.find((f) => f.conviteId === c.id)?.total), c.declinouMotivo ?? c.motivo ?? ""] })),
  });

  if (m && s.propostas.length) {
    await abaTabela(wb, doc, "Propostas", {
      titulo: "Propostas recebidas", paisagem: true, nota: "Última versão de cada fornecedor recebida dentro do prazo, com os preços como foram enviados (sem o frete). O total do grupo já inclui o frete.",
      colunas: [{ titulo: "Fornecedor", largura: 34 }, { titulo: "Código", largura: 12 }, { titulo: "Material", largura: 50 }, { titulo: "Und.", largura: 7, alinhar: "center" },
        { titulo: "Quantidade", largura: 13, formato: "#,##0.0000" }, { titulo: "Preço unitário", largura: 15, formato: '"R$" #,##0.0000' }, { titulo: "Total", largura: 16, formato: FORMATO.moeda },
        { titulo: "Marca", largura: 20 }, { titulo: "Modelo", largura: 18 }, { titulo: "Situação", largura: 22 }, { titulo: "Observação", largura: 34 }],
      linhas: s.propostas.flatMap((p): Linha[] => [
        { tipo: "grupo", valores: [`${p.fornecedor} · v${p.versao} · ${quando(p.enviadaEm)} · protocolo ${protocolo(p.resumo, p.versao)}`, "", `Responsável: ${p.responsavelNome}${p.origem === "equipe" ? ` · lançada pela equipe (${p.documento ?? ""})` : ""}`, "", null, null,
          n((todos ?? m).fornecedores.find((f) => f.conviteId === p.conviteId)?.total), "", "", [dentro.has(p.conviteId) ? "" : "fora da comparação", p.prazoEntrega != null ? `entrega ${p.prazoEntrega} d` : "", p.pagamentoDias != null ? `pagamento ${p.pagamentoDias} d` : "", p.garantiaMeses != null ? `garantia ${p.garantiaMeses} m` : ""].filter(Boolean).join(" · "), p.observacao ?? ""] },
        ...(dentro.has(p.conviteId) ? m : todos ?? m).linhas.map((l): Linha => {
          const o = l.ofertas.find((x) => x.conviteId === p.conviteId);
          return { valores: [p.fornecedor, l.material.semSinapi ? "" : l.material.codigo, l.material.descricao, unidade(l.material.unidade), n(l.material.quantidade), n(o?.precoSemFrete), o?.precoSemFrete == null ? null : Math.round(Number(l.material.quantidade) * Number(o.precoSemFrete) * 100) / 100, o?.marca ?? "", o?.modelo ?? "",
            !o || o.preco == null ? "Indisponível" : o.excluida === "nao_atende" ? "Não atende à especificação" : o.excluida ? "Desconsiderado" : !dentro.has(p.conviteId) ? "Fora da comparação" : o.menor ? "Menor preço do item" : "", o?.justificativa ?? o?.observacao ?? ""] };
        }),
      ]),
    });

  }

  if (m && s.comparacao?.classificacao.length) {
    const c = s.comparacao;
    const fat = FATORES.filter((k) => c.pesos[k] > 0);
    await abaTabela(wb, doc, "Custo-benefício", {
      titulo: "Comparação automática de custo-benefício", paisagem: true,
      nota: `Nota de 0 a 100 por fator, ponderada pelos pesos ${c.pesosDaSolicitacao ? "fixados no envio da solicitação" : "padrão do sistema"}, entre as propostas que cotaram todos os itens. A marca não pontua.`,
      colunas: [{ titulo: "Posição", largura: 9, alinhar: "center" }, { titulo: "Fornecedor", largura: 40 }, { titulo: "Total", largura: 17, formato: FORMATO.moeda },
        ...fat.map((k) => ({ titulo: `${ROTULO_FATOR[k]} (peso ${c.pesos[k]})`, largura: 18, formato: "0.00" })), { titulo: "Nota final", largura: 12, formato: "0.00" },
        { titulo: "Entrega (dias)", largura: 12, formato: "0" }, { titulo: "Pagamento (dias)", largura: 13, formato: "0" }, { titulo: "Garantia (meses)", largura: 13, formato: "0" }],
      linhas: c.classificacao.map((x): Linha => ({ valores: [x.posicao, x.fornecedor, n(x.total), ...fat.map((k) => x.notas?.[k] ?? null), x.nota, x.prazoEntrega, x.pagamentoDias, x.garantiaMeses] })),
    });
  }

  if (r && ap) {
    const cb = r.criterio === "custo_beneficio";
    await abaTabela(wb, doc, "Apuração", {
      titulo: `Apuração nº ${ap.numero} · ${ROTULO_CRITERIO_APURACAO[r.criterio]}`, paisagem: true,
      nota: `Desempate: ${r.desempate}${ap.justificativa ? ` Justificativa da homologação: ${ap.justificativa}` : ""}`,
      colunas: [{ titulo: "Posição", largura: 9, alinhar: "center" }, { titulo: "Fornecedor", largura: 40 }, { titulo: "Itens cotados", largura: 12, formato: "0" }, { titulo: "Itens vencidos", largura: 12, formato: "0" },
        { titulo: "Total da proposta", largura: 17, formato: FORMATO.moeda }, { titulo: "Valor vencido", largura: 17, formato: FORMATO.moeda }, { titulo: "Nota final", largura: 11, formato: "0.00" },
        { titulo: "Entrega (dias)", largura: 12, formato: "0" }, { titulo: "Pagamento (dias)", largura: 13, formato: "0" }, { titulo: "Garantia (meses)", largura: 13, formato: "0" }, { titulo: "Resultado", largura: 16 }],
      linhas: r.classificacao.map((c): Linha => ({ valores: [c.posicao, c.fornecedor, c.itensCotados, c.itensVencidos, n(c.total), n(c.valorVencido), cb ? c.nota : null, c.prazoEntrega, c.pagamentoDias, c.garantiaMeses,
        r.vencedor?.conviteId === c.conviteId ? "Vencedor" : r.criterio === "item" && c.itensVencidos > 0 ? "Vence itens" : ""] })),
    });
    const pri = 6, ult = 5 + r.itens.length;
    await abaTabela(wb, doc, "Resultado", {
      titulo: "Resultado por item", paisagem: true, nota: "Economia = total de referência − total apurado, nos itens com preço de referência.",
      colunas: [{ titulo: "Código", largura: 12 }, { titulo: "Material", largura: 50 }, { titulo: "Und.", largura: 7, alinhar: "center" }, { titulo: "Quantidade", largura: 13, formato: "#,##0.0000" },
        { titulo: "Fornecedor", largura: 34 }, { titulo: "Marca e modelo", largura: 24 }, { titulo: "Preço unitário", largura: 15, formato: '"R$" #,##0.0000' }, { titulo: "Total", largura: 16, formato: FORMATO.moeda },
        { titulo: "Referência", largura: 16, formato: FORMATO.moeda }, { titulo: "Economia", largura: 15, formato: FORMATO.moeda }],
      linhas: [
        ...r.itens.map((i, k): Linha => ({ valores: [i.codigo, i.descricao, unidade(i.unidade), n(i.quantidade), i.fornecedor ?? "Sem proposta válida", [i.marca, i.modelo].filter(Boolean).join(" · "), n(i.preco),
          i.total == null ? null : { formula: `ROUND(D${pri + k}*G${pri + k},2)`, result: Number(i.total) }, n(i.refTotal), i.economia == null ? null : { formula: `I${pri + k}-H${pri + k}`, result: Number(i.economia) }] })),
        { tipo: "total", valores: ["", "Total", "", null, "", "", null, { formula: `SUM(H${pri}:H${ult})`, result: Number(r.totalResultado) }, { formula: `SUM(I${pri}:I${ult})`, result: Number(r.totalReferencia) },
          r.economia == null ? null : { formula: `SUM(J${pri}:J${ult})`, result: Number(r.economia) }] },
      ],
    });
  }

  await abaTabela(wb, doc, "Histórico", {
    titulo: "Registro de eventos", paisagem: true,
    colunas: [{ titulo: "Data e hora", largura: 18 }, { titulo: "Evento", largura: 60 }, { titulo: "Usuário", largura: 26 }, { titulo: "Fornecedor", largura: 34 }, { titulo: "Justificativa", largura: 50 }],
    linhas: [...s.eventos].reverse().map((e): Linha => ({ valores: [quando(e.em), e.resumo, e.usuario ?? "", e.fornecedor ?? "",
      typeof e.detalhe?.justificativa === "string" ? e.detalhe.justificativa : typeof e.detalhe?.motivo === "string" ? e.detalhe.motivo : ""] })),
  });

  return responderPlanilha(wb, `cotacao-${s.obraCodigo}-${numero}.xlsx`);
}
