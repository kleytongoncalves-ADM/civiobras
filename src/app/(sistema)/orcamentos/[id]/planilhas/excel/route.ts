import { ErroDeRegra } from "@/lib/db";
import { abaTabela, capa, FORMATO, novaPasta, responderPlanilha, type Linha } from "@/lib/excel-modelo";
import { mesAno, unidadeMedida } from "@/lib/formato";
import { comoAtor, usuarioAtual } from "@/lib/sessao";
import { insumosDoOrcamento, obterOrcamento, ROTULO_SITUACAO_ORC, rotuloOrcamento } from "@/servicos/orcamentos";
import { analiticaDoOrcamento, peso } from "@/servicos/planilhas";
import { ROTULO_FONTE, ROTULO_REGIME, ROTULO_TIPO_INSUMO } from "@/servicos/precos";
import { SemPermissao } from "@/servicos/permissoes";

const n = (v: string | null | undefined) => (v == null ? null : Number(v));

/** Planilha sintética ou analítica do orçamento, no modelo CiviObras. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tipo = new URL(req.url).searchParams.get("tipo") === "analitica" ? "analitica" : "sintetica";
  const u = await usuarioAtual();
  if (!u) return new Response("Sessão encerrada.", { status: 401 });
  const a = comoAtor(u);
  let o;
  try {
    o = await obterOrcamento(a, id);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) return new Response(e.message, { status: 404 });
    throw e;
  }
  const bases = (o.bases.length ? o.bases : [{ fonte: o.fonte, mes: o.mes, regime: o.regime }])
    .map((b) => `${ROTULO_FONTE[b.fonte]} ${o.uf} ${mesAno(b.mes)}${b.fonte === "sinapi" ? ` (${ROTULO_REGIME[b.regime].toLowerCase()})` : ""}`).join(" + ");
  const titulo = tipo === "sintetica" ? "Planilha orçamentária sintética" : "Planilha orçamentária analítica";
  const doc = { orgao: u.orgaoNome, titulo, subtitulo: `${o.obraCodigo} · ${o.obraNome} · ${rotuloOrcamento(o)}`, geradoEm: new Date(), geradoPor: u.nome };
  const wb = novaPasta(doc);
  const itens = o.etapas.flatMap((e) => e.itens);

  await capa(wb, doc, [
    ["Obra", `${o.obraCodigo} · ${o.obraNome}`],
    ["Orçamento", `${rotuloOrcamento(o)} · ${o.nome}`],
    ["Situação", ROTULO_SITUACAO_ORC[o.situacao]],
    ["Bases e data-base", bases],
    ["BDI de obra", `${o.bdiObraPct.replace(".", ",")}%`],
    ["Totais", `${o.arredondamento === "truncar" ? "Truncados" : "Arredondados"} em 2 casas`],
    ["Responsável técnico", [o.responsavelTecnico, o.registroProfissional].filter(Boolean).join(" · ")],
    ["ART/RRT", o.art ?? ""],
  ], [
    ["Valor global com BDI", Number(o.totais.total)],
    ["Custo direto", Number(o.totais.custo)],
    [`BDI ${o.bdiObraPct.replace(".", ",")}%`, Number(o.totais.bdi)],
    ["Serviços", itens.length, "0"],
  ]);

  if (tipo === "sintetica") {
    await abaTabela(wb, doc, "Sintética", {
      titulo, paisagem: true,
      nota: "Preço com BDI = custo unitário × (1 + BDI). Peso = participação no valor global. Cada item traz a base, o código e a data-base de origem.",
      colunas: [
        { titulo: "Item", largura: 8, alinhar: "left" }, { titulo: "Código", largura: 12 }, { titulo: "Banco", largura: 11 }, { titulo: "Data-base", largura: 10, alinhar: "center" },
        { titulo: "Descrição", largura: 60 }, { titulo: "Und.", largura: 7, alinhar: "center" }, { titulo: "Quant.", largura: 11, formato: FORMATO.quantidade },
        { titulo: "Custo unit.", largura: 14, formato: FORMATO.moeda }, { titulo: "Preço c/ BDI", largura: 14, formato: FORMATO.moeda },
        { titulo: "Total", largura: 16, formato: FORMATO.moeda }, { titulo: "Peso (%)", largura: 10, formato: FORMATO.pct }, { titulo: "Memória de cálculo", largura: 40 },
      ],
      linhas: [
        ...o.etapas.flatMap((e): Linha[] => [
          { tipo: "grupo", valores: [`${e.ordem}. ${e.nome}`, "", "", "", "", "", null, null, null, n(e.totais.total), peso(o, e.totais.total), ""] },
          ...e.itens.map((i): Linha => ({ valores: [
            i.numero, i.fonte === "cotacao" ? "" : i.codigo ?? "", ROTULO_FONTE[i.fonte], mesAno(i.baseMes ?? o.mes), i.descricao, unidadeMedida(i.unidade), n(i.quantidade),
            i.semPreco ? null : n(i.custoUnitario), i.semPreco ? null : n(i.precoUnitario), i.semPreco ? null : n(i.total), i.semPreco ? null : peso(o, i.total), i.memoria ?? "",
          ] })),
          { tipo: "total", valores: [`Subtotal ${e.ordem}. ${e.nome}`, "", "", "", "", "", null, null, null, n(e.totais.total), peso(o, e.totais.total), ""] },
        ]),
        { tipo: "total", valores: ["Custo direto (sem BDI)", "", "", "", "", "", null, null, null, n(o.totais.custo), null, ""] },
        { tipo: "total", valores: [`BDI (${o.bdiObraPct.replace(".", ",")}%)`, "", "", "", "", "", null, null, null, n(o.totais.bdi), null, ""] },
        { tipo: "total", valores: ["Valor global com BDI", "", "", "", "", "", null, null, null, n(o.totais.total), 100, ""] },
      ],
    });
  } else {
    const analitica = analiticaDoOrcamento(o, await insumosDoOrcamento(a, id));
    const linhas: Linha[] = [];
    for (const { item: i, linhas: ls } of analitica) {
      linhas.push({ tipo: "grupo", valores: [
        `${i.numero} · ${i.fonte === "cotacao" || !i.codigo ? ROTULO_FONTE[i.fonte] : `${ROTULO_FONTE[i.fonte]} ${i.codigo}`} · ${mesAno(i.baseMes ?? o.mes)} · ${i.descricao} (${unidadeMedida(i.unidade)})`,
        "", "", "", "", null, null, null,
      ] });
      for (const l of ls) {
        linhas.push({ valores: [
          l.nivel === 1 ? `   ${l.codigo}` : l.codigo, l.fonte ? ROTULO_FONTE[l.fonte] : "", l.nivel === 1 ? `   · ${l.descricao}` : l.descricao,
          l.tipo === "auxiliar" ? "Composição auxiliar" : l.tipoInsumo ? ROTULO_TIPO_INSUMO[l.tipoInsumo] : "", unidadeMedida(l.unidade),
          l.coeficiente, l.preco, l.nivel === 1 ? null : l.parcial,
        ] });
      }
      const bdi = i.semPreco ? null : Math.round((Number(i.precoUnitario) - Number(i.custoUnitario ?? 0)) * 100) / 100;
      linhas.push({ tipo: "total", valores: ["Custo unitário (sem BDI)", "", "", "", "", null, null, i.semPreco ? null : n(i.custoUnitario)] });
      linhas.push({ valores: ["", "", `BDI (${(i.tipoBdi === "fornecimento" ? o.bdiFornecimentoPct : o.bdiObraPct).replace(".", ",")}%)`, "", "", null, null, bdi] });
      linhas.push({ valores: ["", "", `Preço unitário com BDI · quantidade ${Number(i.quantidade).toLocaleString("pt-BR")} ${unidadeMedida(i.unidade)} · total do item ${i.semPreco ? "—" : Number(i.total).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`, "", "", null, null, i.semPreco ? null : n(i.precoUnitario)] });
    }
    await abaTabela(wb, doc, "Analítica", {
      titulo, paisagem: true,
      nota: "Insumos das composições auxiliares aparecem recuados, com o coeficiente da própria auxiliar; o parcial da auxiliar já soma esses insumos. Preços congelados na data-base de cada item.",
      colunas: [
        { titulo: "Código", largura: 14 }, { titulo: "Banco", largura: 11 }, { titulo: "Descrição", largura: 64 }, { titulo: "Tipo", largura: 18 }, { titulo: "Und.", largura: 7, alinhar: "center" },
        { titulo: "Coeficiente", largura: 13, formato: "#,##0.000000" }, { titulo: "Preço unit.", largura: 14, formato: FORMATO.moeda }, { titulo: "Parcial", largura: 15, formato: FORMATO.moeda },
      ],
      linhas,
    });
  }

  return responderPlanilha(wb, `${tipo}-${o.obraCodigo}-${rotuloOrcamento(o).replace(" ", "-")}.xlsx`);
}
