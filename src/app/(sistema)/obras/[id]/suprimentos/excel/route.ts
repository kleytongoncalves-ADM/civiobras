import { ErroDeRegra } from "@/lib/db";
import { abaTabela, capa, FORMATO, novaPasta, responderPlanilha, type Linha } from "@/lib/excel-modelo";
import { dataCurta, unidadeMedida } from "@/lib/formato";
import { comoAtor, usuarioAtual } from "@/lib/sessao";
import { SemPermissao } from "@/servicos/permissoes";
import { painelSuprimentos, ROTULO_MOVIMENTO, ROTULO_PEDIDO, ROTULO_REQUISICAO } from "@/servicos/suprimentos";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await usuarioAtual();
  if (!u) return new Response("Sessão encerrada.", { status: 401 });
  let p;
  try {
    p = await painelSuprimentos(comoAtor(u), id, true);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) return new Response(e.message, { status: 404 });
    throw e;
  }
  const validos = p.pedidos.filter((x) => x.situacao !== "cancelado");
  const comprado = validos.reduce((s, x) => s + x.total, 0);
  const doc = { orgao: u.orgaoNome, titulo: `Suprimentos · ${p.obra.codigo}`, subtitulo: p.obra.nome, geradoEm: new Date(), geradoPor: u.nome };
  const wb = novaPasta(doc);
  await capa(wb, doc, [
    ["Obra", `${p.obra.codigo} · ${p.obra.nome}`],
    ["Requisições", String(p.requisicoes.length)],
    ["Pedidos de compra", `${validos.length} (${p.atrasados} com entrega atrasada)`],
    ["Materiais abaixo do mínimo", String(p.abaixoMinimo)],
  ], [["Valor em estoque (R$)", p.valorEstoque, FORMATO.moeda], ["Material aplicado (R$)", p.consumoMateriais, FORMATO.moeda], ["Comprado (R$)", comprado, FORMATO.moeda]]);
  const est = p.estoque.filter((l) => l.recebido || l.requisitado || l.saldo || l.previsto);
  await abaTabela(wb, doc, "Estoque", {
    titulo: "Previsto, comprado, consumido e saldo", paisagem: true,
    colunas: [
      { titulo: "Código", largura: 10 }, { titulo: "Material", largura: 40 }, { titulo: "Un.", largura: 6 }, { titulo: "Previsto", largura: 12, formato: FORMATO.quantidade },
      { titulo: "Requisitado", largura: 12, formato: FORMATO.quantidade }, { titulo: "Recebido", largura: 12, formato: FORMATO.quantidade }, { titulo: "Consumido", largura: 12, formato: FORMATO.quantidade },
      { titulo: "Perdas", largura: 11, formato: FORMATO.quantidade }, { titulo: "Saldo", largura: 12, formato: FORMATO.quantidade }, { titulo: "Mínimo", largura: 11, formato: FORMATO.quantidade },
      { titulo: "Custo médio", largura: 13, formato: FORMATO.moeda }, { titulo: "Valor em estoque", largura: 15, formato: FORMATO.moeda },
    ],
    linhas: [
      ...est.map((l): Linha => ({ valores: [l.codigo ?? "", l.descricao, unidadeMedida(l.unidade), l.previsto || null, l.requisitado, l.recebido, l.consumido, l.perdas, l.saldo, l.minimo, l.custoMedio, l.valor] })),
      { tipo: "total", valores: ["", "Total", "", null, null, null, null, null, null, null, null, p.valorEstoque] },
    ],
  });
  await abaTabela(wb, doc, "Pedidos", {
    titulo: "Pedidos de compra", paisagem: false,
    colunas: [{ titulo: "Nº", largura: 6 }, { titulo: "Emissão", largura: 11, alinhar: "center" }, { titulo: "Fornecedor", largura: 34 }, { titulo: "Requisição", largura: 11 },
      { titulo: "Entrega até", largura: 11, alinhar: "center" }, { titulo: "Situação", largura: 12 }, { titulo: "Total", largura: 15, formato: FORMATO.moeda }],
    linhas: [
      ...p.pedidos.map((x): Linha => ({ valores: [x.numero, dataCurta(x.data), x.fornecedor, `nº ${x.requisicaoNumero}`, dataCurta(x.prazoEntrega), x.atrasado ? "Atrasado" : ROTULO_PEDIDO[x.situacao], x.total] })),
      { tipo: "total", valores: ["", "", "Total (sem cancelados)", "", "", "", comprado] },
    ],
  });
  await abaTabela(wb, doc, "Requisições", {
    titulo: "Requisições de material", paisagem: false,
    colunas: [{ titulo: "Nº", largura: 6 }, { titulo: "Data", largura: 11, alinhar: "center" }, { titulo: "Necessário em", largura: 13, alinhar: "center" }, { titulo: "Solicitante", largura: 26 },
      { titulo: "Itens", largura: 7, formato: "0" }, { titulo: "Pedidos", largura: 8, formato: "0" }, { titulo: "Situação", largura: 12 }],
    linhas: p.requisicoes.map((r): Linha => ({ valores: [r.numero, dataCurta(r.data), dataCurta(r.necessidade), r.criadoPor ?? "", r.itens, r.pedidos, ROTULO_REQUISICAO[r.situacao]] })),
  });
  await abaTabela(wb, doc, "Movimentos", {
    titulo: "Movimentos de estoque", paisagem: true,
    colunas: [{ titulo: "Data", largura: 11, alinhar: "center" }, { titulo: "Movimento", largura: 22 }, { titulo: "Material", largura: 36 }, { titulo: "Un.", largura: 6 },
      { titulo: "Quantidade", largura: 12, formato: FORMATO.quantidade }, { titulo: "Custo unitário", largura: 13, formato: FORMATO.moeda }, { titulo: "Valor", largura: 14, formato: FORMATO.moeda },
      { titulo: "Serviço ou destino", largura: 32 }, { titulo: "Observação", largura: 30 }, { titulo: "Registrado por", largura: 20 }],
    linhas: p.movimentos.map((m): Linha => ({ valores: [dataCurta(m.data), ROTULO_MOVIMENTO[m.tipo], m.material, unidadeMedida(m.unidade), m.quantidade, m.custoUnitario, m.valor, m.item ?? m.destino ?? "", m.observacao ?? "", m.por ?? ""] })),
  });
  if (p.perdas.length) {
    await abaTabela(wb, doc, "Perdas", {
      titulo: "Perdas: real × teórico", paisagem: false,
      colunas: [{ titulo: "Item", largura: 8 }, { titulo: "Serviço", largura: 36 }, { titulo: "Material", largura: 30 }, { titulo: "Un.", largura: 6 },
        { titulo: "Teórico", largura: 12, formato: FORMATO.quantidade }, { titulo: "Real", largura: 12, formato: FORMATO.quantidade }, { titulo: "Perda real", largura: 11, formato: FORMATO.pct }, { titulo: "Prevista", largura: 10, formato: FORMATO.pct }],
      linhas: p.perdas.map((x): Linha => ({ valores: [x.itemNumero, x.itemDescricao, x.material, unidadeMedida(x.unidade), x.teorico, x.real, x.perda, x.prevista] })),
    });
  }
  return responderPlanilha(wb, `suprimentos-${p.obra.codigo}.xlsx`);
}
