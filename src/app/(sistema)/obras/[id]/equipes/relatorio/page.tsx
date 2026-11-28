import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { CabecalhoRelatorio, Indicadores, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { BarraComposicao, BarrasHorizontais, COR } from "@/componentes/relatorio/Graficos";
import { ErroDeRegra } from "@/lib/db";
import { dataCurta, dataHora, moeda, numero, percentual, resumir } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { ADICIONAL_EXTRA, limiteAviso, painelEquipes } from "@/servicos/equipes";
import { SemPermissao } from "@/servicos/permissoes";

export const metadata: Metadata = { title: "Relatório de equipes e custos" };

export default async function RelatorioEquipes({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await exigirUsuario();
  let p;
  try {
    p = await painelEquipes(comoAtor(u), id, true);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) notFound();
    throw e;
  }
  const ativas = p.pessoas.filter((x) => x.ativa);
  const eqAtivos = p.equipamentos.filter((x) => x.ativa);
  const realizado = p.totalMateriais + p.totalMaoDeObra + p.totalEquipamentos;
  const custos = p.custos.filter((l) => l.realizado > 0 || l.horas > 0);
  const orcadoMedido = custos.reduce((s, l) => s + l.medido, 0);
  const pendentes = ativas.filter((x) => x.pendencia);
  const baixa = custos.filter((l) => l.indice != null && l.indice > 1.1);
  const horasNormais = p.apontamentos.reduce((s, a) => s + a.normais, 0);
  const horasExtras = p.apontamentos.reduce((s, a) => s + a.extras, 0);
  const porFuncao = new Map<string, number>();
  for (const a of p.apontamentos) porFuncao.set(a.funcao, (porFuncao.get(a.funcao) ?? 0) + a.normais + a.extras);
  const pontos: string[] = [];
  pontos.push(`${ativas.length} ${ativas.length === 1 ? "pessoa alocada" : "pessoas alocadas"} e ${eqAtivos.length} ${eqAtivos.length === 1 ? "equipamento" : "equipamentos"} na obra hoje.`);
  if (realizado > 0) pontos.push(`Custo realizado de ${moeda(realizado)}${orcadoMedido > 0 ? `, frente a ${moeda(orcadoMedido)} medidos nos mesmos serviços` : ""}.`);
  if (pendentes.length) pontos.push(`${pendentes.length} ${pendentes.length === 1 ? "pessoa alocada com ASO ou treinamento vencido; não pode receber apontamento" : "pessoas alocadas com ASO ou treinamento vencido; não podem receber apontamento"}.`);
  if (baixa.length) pontos.push(`${baixa.length} ${baixa.length === 1 ? "serviço consumiu" : "serviços consumiram"} mais de 10% acima das horas previstas por unidade.`);
  if (horasExtras > 0) pontos.push(`${numero(horasExtras, 1)} h extras apontadas (${percentual((horasExtras / Math.max(1, horasNormais + horasExtras)) * 100, 1)} das horas).`);
  let s = 0;
  const n = () => ++s;

  return (
    <div className="grade">
      <div className="barra-acoes nao-imprimir">
        <Link href={`/obras/${id}/equipes`} className="botao botao-neutro"><ArrowLeft /> Voltar</Link>
        <a href={`/obras/${id}/equipes/excel`} className="botao botao-neutro"><FileSpreadsheet /> Excel</a>
        <BotaoImprimir />
      </div>
      <article className="rel">
        <CabecalhoRelatorio orgao={u.orgaoNome} tipo="Relatório de equipes, recursos e custo realizado" titulo={`Equipes · ${p.obra.codigo}`} subtitulo={p.obra.nome}
          selo={{ texto: pendentes.length ? "Habilitação vencida" : p.alertas ? "Validades a vencer" : "Equipe regular", cor: pendentes.length ? "vermelho" : p.alertas ? "laranja" : "verde" }}
          dados={[["Obra", `${p.obra.codigo} · ${p.obra.nome}`], ["Posição em", dataHora(new Date())], ["Pessoas na obra", String(ativas.length)], ["Equipamentos na obra", String(eqAtivos.length)]]} />

        <Secao numero={n()} titulo="Resumo executivo">
          <Indicadores itens={[
            { rotulo: "Custo realizado", valor: moeda(realizado), destaque: true },
            { rotulo: "Mão de obra", valor: moeda(p.totalMaoDeObra) },
            { rotulo: "Materiais", valor: moeda(p.totalMateriais) },
            { rotulo: "Equipamentos", valor: moeda(p.totalEquipamentos) },
            { rotulo: "Horas no mês", valor: `${numero(p.horasMes, 1)} h` },
          ]} />
          <ul className="rel-pontos">{pontos.map((x) => <li key={x}>{x}</li>)}</ul>
          {realizado > 0 && <BarraComposicao titulo="Composição do custo realizado" rotuloTotal="Custo realizado" fatias={[
            { rotulo: "Materiais", valor: p.totalMateriais, cor: COR.material }, { rotulo: "Mão de obra", valor: p.totalMaoDeObra, cor: COR.maoDeObra },
            { rotulo: "Equipamentos", valor: p.totalEquipamentos, cor: COR.equipamento }]} />}
        </Secao>

        {custos.length > 0 && (
          <Secao numero={n()} titulo="Custo realizado e produtividade por serviço" descricao="Índice de produtividade = horas apontadas por unidade medida ÷ horas previstas por unidade na composição. Acima de 1, a equipe gastou mais horas que o previsto.">
            <table className="rel-tabela">
              <thead><tr><th>Item</th><th>Serviço</th><th className="dir">Medido (R$)</th><th className="dir">Materiais</th><th className="dir">Mão de obra</th><th className="dir">Equipamentos</th><th className="dir">Realizado</th><th className="dir">h/un. real</th><th className="dir">h/un. prevista</th><th className="dir">Índice</th></tr></thead>
              <tbody>{custos.map((l) => (
                <tr key={l.itemId}><td className="num">{l.numero}</td><td><span className="rel-desc">{resumir(l.descricao, 60)}</span></td>
                  <td className="dir num">{moeda(l.medido)}</td><td className="dir num">{moeda(l.materiais)}</td><td className="dir num">{moeda(l.maoDeObra)}</td><td className="dir num">{moeda(l.equipamentos)}</td>
                  <td className="dir num forte">{moeda(l.realizado)}</td>
                  <td className="dir num">{l.horasPorUnidade != null ? numero(l.horasPorUnidade, 3) : "—"}</td><td className="dir num">{l.previstoPorUnidade != null ? numero(l.previstoPorUnidade, 3) : "—"}</td>
                  <td className={`dir num${l.indice != null && l.indice > 1.1 ? " forte" : ""}`}>{l.indice != null ? numero(l.indice, 2) : "—"}</td></tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={2}>Total</td><td className="dir num">{moeda(orcadoMedido)}</td><td className="dir num">{moeda(p.totalMateriais)}</td><td className="dir num">{moeda(p.totalMaoDeObra)}</td>
                <td className="dir num">{moeda(p.totalEquipamentos)}</td><td className="dir num">{moeda(realizado)}</td><td colSpan={3} /></tr></tfoot>
            </table>
          </Secao>
        )}

        <Secao numero={n()} titulo="Equipe alocada">
          {p.pessoas.length === 0 ? <p className="fraco">Nenhuma pessoa alocada.</p> : (
            <table className="rel-tabela">
              <thead><tr><th>Pessoa</th><th>Função</th><th>Empresa</th><th>Período</th><th className="dir">Horas no mês</th><th>ASO e treinamentos</th></tr></thead>
              <tbody>{p.pessoas.map((x) => (
                <tr key={x.id}><td>{x.nome}</td><td>{x.funcao}</td><td>{x.empresa ?? "Equipe própria"}</td>
                  <td className="num">{dataCurta(x.inicio)} a {x.fim ? dataCurta(x.fim) : "atual"}</td><td className="dir num">{x.horasMes ? numero(x.horasMes, 1) : "—"}</td>
                  <td>{x.pendencia ? x.pendencia.replace(/^./, (c) => c.toUpperCase()) : x.vencimento && x.vencimento <= limiteAviso() ? `${x.vencimentoItem} vence em ${dataCurta(x.vencimento)}` : "Em dia"}</td></tr>
              ))}</tbody>
            </table>
          )}
          {porFuncao.size > 1 && <BarrasHorizontais titulo="Horas apontadas por função" unidade="h" casas={1} cor={COR.maoDeObra} itens={[...porFuncao].sort((a, b) => b[1] - a[1]).map(([rotulo, valor]) => ({ rotulo, valor }))} />}
        </Secao>

        {p.equipamentos.length > 0 && (
          <Secao numero={n()} titulo="Equipamentos">
            <table className="rel-tabela">
              <thead><tr><th>Equipamento</th><th>Identificação</th><th>Período</th><th>Próxima revisão</th><th className="dir">Horas no mês</th><th>Situação</th></tr></thead>
              <tbody>{p.equipamentos.map((q) => (
                <tr key={q.id}><td>{q.descricao}</td><td>{q.identificacao ?? "—"}</td><td className="num">{dataCurta(q.inicio)} a {q.fim ? dataCurta(q.fim) : "atual"}</td>
                  <td className="num">{dataCurta(q.proximaRevisao)}</td><td className="dir num">{q.horasMes ? numero(q.horasMes, 1) : "—"}</td><td>{q.disponivel ? "Disponível" : "Manutenção vencida"}</td></tr>
              ))}</tbody>
            </table>
          </Secao>
        )}

        <Secao numero={n()} titulo="Metodologia e fontes">
          <ul className="rel-metodologia">
            <li><b>Mão de obra:</b> horas normais × custo/hora + horas extras × custo/hora × {numero(ADICIONAL_EXTRA, 1)} (adicional mínimo de 50%, CLT art. 59). O custo/hora é o do cadastro da pessoa no dia do apontamento.</li>
            <li><b>Materiais:</b> saídas e perdas de estoque destinadas ao serviço, valoradas pelo custo médio.</li>
            <li><b>Equipamentos:</b> horas apontadas × custo/hora do equipamento.</li>
            <li><b>Medido:</b> valor acumulado das medições do serviço, para comparação com o realizado.</li>
            <li><b>Habilitação:</b> pessoa sem ASO válido ou com treinamento obrigatório vencido não pode ser alocada nem receber apontamento.</li>
            <li><b>Fonte:</b> alocações, apontamentos, cadastro de pessoas e equipamentos, estoque e medições registrados no sistema para esta obra.</li>
          </ul>
        </Secao>
        <RodapeRelatorio texto={`CiviObras · ${u.orgaoNome} · ${p.obra.codigo} · relatório de equipes · gerado em ${dataHora(new Date())}`} />
      </article>
    </div>
  );
}
