import { ErroDeRegra } from "@/lib/db";
import { abaTabela, capa, novaPasta, responderPlanilha, type Linha } from "@/lib/excel-modelo";
import { dataCurta } from "@/lib/formato";
import { comoAtor, usuarioAtual } from "@/lib/sessao";
import { SemPermissao } from "@/servicos/permissoes";
import { painelSeguranca, ROTULO_OCORRENCIA } from "@/servicos/seguranca";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await usuarioAtual();
  if (!u) return new Response("Sessão encerrada.", { status: 401 });
  let p;
  try {
    p = await painelSeguranca(comoAtor(u), id, true);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) return new Response(e.message, { status: 404 });
    throw e;
  }
  const doc = { orgao: u.orgaoNome, titulo: `Segurança · ${p.obra.codigo}`, subtitulo: p.obra.nome, geradoEm: new Date(), geradoPor: u.nome };
  const wb = novaPasta(doc);
  await capa(wb, doc, [
    ["Obra", `${p.obra.codigo} · ${p.obra.nome}`],
    ["Último acidente", p.ultimoAcidente ? dataCurta(p.ultimoAcidente) : "Nenhum"],
    ["Ocorrências", `${p.acidentes} ${p.acidentes === 1 ? "acidente" : "acidentes"}, ${p.quaseAcidentes} ${p.quaseAcidentes === 1 ? "quase acidente" : "quase acidentes"}, ${p.riscos} ${p.riscos === 1 ? "risco grave" : "riscos graves"}`],
    ["Ações corretivas abertas", `${p.abertas} (${p.vencidas} vencidas)`],
    ...(p.diasSemAcidente == null ? [["Dias sem acidente", "Obra sem data de início"] as [string, string]] : []),
  ], [...(p.diasSemAcidente == null ? [] : [["Dias sem acidente", p.diasSemAcidente, "0"] as [string, number, string]]), ["Dias de afastamento", p.afastamento, "0"], ["Horas paralisadas", p.horasParalisadas, "0.0"]]);
  await abaTabela(wb, doc, "Ocorrências", {
    titulo: "Ocorrências de segurança", paisagem: true,
    colunas: [
      { titulo: "Nº", largura: 6 }, { titulo: "Data", largura: 11, alinhar: "center" }, { titulo: "Hora", largura: 7 }, { titulo: "Tipo", largura: 22 }, { titulo: "Local", largura: 18 },
      { titulo: "Descrição", largura: 46 }, { titulo: "Envolvido", largura: 18 }, { titulo: "Empresa", largura: 18 }, { titulo: "Afastamento (dias)", largura: 11, formato: "0" }, { titulo: "CAT", largura: 10 },
      { titulo: "Horas paralisadas", largura: 11, formato: "0.0" }, { titulo: "Ação corretiva", largura: 36 }, { titulo: "Responsável", largura: 18 }, { titulo: "Prazo", largura: 11, alinhar: "center" },
      { titulo: "Situação", largura: 11 }, { titulo: "Encerramento", largura: 36 },
    ],
    linhas: p.ocorrencias.map((o): Linha => ({ valores: [
      o.numero, dataCurta(o.data), o.hora ?? "", ROTULO_OCORRENCIA[o.tipo], o.local ?? "", o.descricao, o.envolvido ?? "", o.empresa ?? "", o.diasAfastamento, o.cat ?? "",
      o.paralisacao ? o.horasParalisadas : null, o.acaoCorretiva, o.responsavel, dataCurta(o.prazo), o.situacao === "encerrada" ? "Encerrada" : o.vencida ? "Vencida" : "Aberta", o.encerramento ?? "",
    ] })),
  });
  await abaTabela(wb, doc, "EPI", {
    titulo: "Entrega de EPI", paisagem: false,
    colunas: [{ titulo: "Data", largura: 11, alinhar: "center" }, { titulo: "Trabalhador", largura: 26 }, { titulo: "Função", largura: 18 }, { titulo: "Empresa", largura: 20 }, { titulo: "EPI", largura: 24 }, { titulo: "CA", largura: 10 }, { titulo: "Qtd.", largura: 7, formato: "0" }],
    linhas: p.epis.map((e): Linha => ({ valores: [dataCurta(e.data), e.trabalhador, e.funcao ?? "", e.empresa ?? "", e.epi, e.ca ?? "", e.quantidade] })),
  });
  return responderPlanilha(wb, `seguranca-${p.obra.codigo}.xlsx`);
}
