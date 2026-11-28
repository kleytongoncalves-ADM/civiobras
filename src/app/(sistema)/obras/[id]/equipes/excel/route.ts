import { ErroDeRegra } from "@/lib/db";
import { abaTabela, capa, FORMATO, novaPasta, responderPlanilha, type Linha } from "@/lib/excel-modelo";
import { dataCurta, unidadeMedida } from "@/lib/formato";
import { comoAtor, usuarioAtual } from "@/lib/sessao";
import { limiteAviso, painelEquipes } from "@/servicos/equipes";
import { SemPermissao } from "@/servicos/permissoes";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await usuarioAtual();
  if (!u) return new Response("Sessão encerrada.", { status: 401 });
  let p;
  try {
    p = await painelEquipes(comoAtor(u), id, true);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) return new Response(e.message, { status: 404 });
    throw e;
  }
  const realizado = p.totalMateriais + p.totalMaoDeObra + p.totalEquipamentos;
  const ativas = p.pessoas.filter((x) => x.ativa);
  const doc = { orgao: u.orgaoNome, titulo: `Equipes · ${p.obra.codigo}`, subtitulo: p.obra.nome, geradoEm: new Date(), geradoPor: u.nome };
  const wb = novaPasta(doc);
  await capa(wb, doc, [
    ["Obra", `${p.obra.codigo} · ${p.obra.nome}`],
    ["Pessoas na obra", `${ativas.length} (${ativas.filter((x) => x.pendencia).length} com habilitação vencida)`],
    ["Equipamentos na obra", String(p.equipamentos.filter((x) => x.ativa).length)],
  ], [["Custo realizado (R$)", realizado, FORMATO.moeda], ["Mão de obra (R$)", p.totalMaoDeObra, FORMATO.moeda], ["Horas no mês", p.horasMes, "0.0"]]);
  const custos = p.custos.filter((l) => l.realizado > 0 || l.horas > 0);
  await abaTabela(wb, doc, "Custo por serviço", {
    titulo: "Custo realizado e produtividade por serviço", paisagem: true,
    colunas: [
      { titulo: "Item", largura: 8 }, { titulo: "Serviço", largura: 44 }, { titulo: "Un.", largura: 6 }, { titulo: "Qtd. medida", largura: 12, formato: FORMATO.quantidade },
      { titulo: "Medido", largura: 14, formato: FORMATO.moeda }, { titulo: "Materiais", largura: 14, formato: FORMATO.moeda }, { titulo: "Mão de obra", largura: 14, formato: FORMATO.moeda },
      { titulo: "Equipamentos", largura: 14, formato: FORMATO.moeda }, { titulo: "Realizado", largura: 14, formato: FORMATO.moeda }, { titulo: "Horas", largura: 10, formato: "0.0" },
      { titulo: "h/un. real", largura: 10, formato: "0.000" }, { titulo: "h/un. prevista", largura: 11, formato: "0.000" }, { titulo: "Índice", largura: 9, formato: "0.00" },
    ],
    linhas: [
      ...custos.map((l): Linha => ({ valores: [l.numero, l.descricao, unidadeMedida(l.unidade), l.quantidadeMedida, l.medido, l.materiais, l.maoDeObra, l.equipamentos, l.realizado, l.horas, l.horasPorUnidade, l.previstoPorUnidade, l.indice] })),
      { tipo: "total", valores: ["", "Total", "", null, custos.reduce((s, l) => s + l.medido, 0), p.totalMateriais, p.totalMaoDeObra, p.totalEquipamentos, realizado, custos.reduce((s, l) => s + l.horas, 0), null, null, null] },
    ],
  });
  await abaTabela(wb, doc, "Equipe", {
    titulo: "Equipe alocada", paisagem: false,
    colunas: [{ titulo: "Pessoa", largura: 28 }, { titulo: "Função", largura: 18 }, { titulo: "Empresa", largura: 26 }, { titulo: "Início", largura: 11, alinhar: "center" },
      { titulo: "Fim", largura: 11, alinhar: "center" }, { titulo: "Horas no mês", largura: 11, formato: "0.0" }, { titulo: "ASO e treinamentos", largura: 34 }],
    linhas: p.pessoas.map((x): Linha => ({ valores: [x.nome, x.funcao, x.empresa ?? "Equipe própria", dataCurta(x.inicio), x.fim ? dataCurta(x.fim) : "", x.horasMes,
      x.pendencia ? x.pendencia.replace(/^./, (c) => c.toUpperCase()) : x.vencimento && x.vencimento <= limiteAviso() ? `${x.vencimentoItem} vence em ${dataCurta(x.vencimento)}` : "Em dia"] })),
  });
  await abaTabela(wb, doc, "Horas", {
    titulo: "Horas apontadas", paisagem: false,
    colunas: [{ titulo: "Data", largura: 11, alinhar: "center" }, { titulo: "Pessoa", largura: 28 }, { titulo: "Função", largura: 18 }, { titulo: "Serviço", largura: 40 },
      { titulo: "Normais", largura: 9, formato: "0.0" }, { titulo: "Extras", largura: 9, formato: "0.0" }, { titulo: "Custo", largura: 13, formato: FORMATO.moeda }],
    linhas: p.apontamentos.map((a): Linha => ({ valores: [dataCurta(a.data), a.nome, a.funcao, a.item ?? "", a.normais, a.extras, a.custo] })),
  });
  if (p.equipamentos.length) {
    await abaTabela(wb, doc, "Equipamentos", {
      titulo: "Equipamentos e horas", paisagem: false,
      colunas: [{ titulo: "Data", largura: 11, alinhar: "center" }, { titulo: "Equipamento", largura: 32 }, { titulo: "Serviço", largura: 40 }, { titulo: "Horas", largura: 9, formato: "0.0" }, { titulo: "Custo", largura: 13, formato: FORMATO.moeda }],
      linhas: p.apontamentosEq.map((a): Linha => ({ valores: [dataCurta(a.data), a.descricao, a.item ?? "", a.horas, a.custo] })),
    });
  }
  return responderPlanilha(wb, `equipes-${p.obra.codigo}.xlsx`);
}
