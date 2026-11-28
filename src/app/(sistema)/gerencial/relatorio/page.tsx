import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { CabecalhoRelatorio, Indicadores, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { BarrasHorizontais, ColunasMensais, COR } from "@/componentes/relatorio/Graficos";
import { dataCurta, dataHora, moeda, numero, percentual } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { LIMITES, painelGerencial, type Nivel } from "@/servicos/gerencial";
import { pode } from "@/servicos/permissoes";
import { ROTULO_SITUACAO } from "@/servicos/rotulos";
import { descreverFiltros, lerFiltros, rotuloMes } from "../filtros";

export const metadata: Metadata = { title: "Relatório gerencial de obras" };
const ROTULO_NIVEL: Record<Nivel, string> = { vermelho: "Crítica", amarelo: "Atenção", verde: "Em dia" };
const COR_NIVEL: Record<Nivel, string> = { vermelho: "#d23c3c", amarelo: "#e59a1c", verde: "#2a9d63" };

export default async function RelatorioGerencial({ searchParams }: { searchParams: Promise<{ tipo?: string; unidade?: string; situacao?: string }> }) {
  const u = await exigirUsuario();
  const ator = comoAtor(u);
  if (!pode(ator, "gerencial.ver")) notFound();
  const filtros = lerFiltros(await searchParams);
  const p = await painelGerencial(ator, filtros);
  const qs = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v) as [string, string][]).toString();
  const t = p.totais;
  const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
  const comContrato = p.obras.filter((o) => o.contratado > 0);
  const comIdp = p.obras.filter((o) => o.idp != null);
  const atencao = p.obras.filter((o) => o.motivos.length > 0);
  const vencidos = p.vencimentos.filter((v) => v.vencido);
  const mensalComValor = p.mensal.some((m) => m.medido || m.pago);

  const pontos: string[] = [];
  pontos.push(`${p.obras.length} ${p.obras.length === 1 ? "obra no recorte" : "obras no recorte"}: ${p.porNivel.vermelho} em situação crítica, ${p.porNivel.amarelo} em atenção e ${p.porNivel.verde} em dia.`);
  if (t.contratado > 0) pontos.push(`Valor contratado de ${moeda(t.contratado)}, com ${moeda(t.medido)} medidos (${percentual(pct(t.medido, t.contratado), 1)}) e ${moeda(t.pago)} pagos.`);
  if (t.aPagar > 0) pontos.push(`${moeda(t.aPagar)} em medições aprovadas aguardando pagamento.`);
  const atrasadas = comIdp.filter((o) => o.idp! < LIMITES.idpAtencao && (o.situacao === "em_execucao" || o.situacao === "paralisada"));
  if (atrasadas.length) pontos.push(`${atrasadas.length} ${atrasadas.length === 1 ? "obra com avanço físico abaixo do previsto" : "obras com avanço físico abaixo do previsto"} (IDP menor que ${numero(LIMITES.idpAtencao, 2)}).`);
  if (vencidos.length) pontos.push(`${vencidos.length} ${vencidos.length === 1 ? "prazo vencido" : "prazos vencidos"} na agenda de documentos, contratos, garantias e habilitações.`);
  let s = 0;
  const n = () => ++s;

  return (
    <div className="grade">
      <div className="barra-acoes nao-imprimir">
        <Link href={`/gerencial${qs ? `?${qs}` : ""}`} className="botao botao-neutro"><ArrowLeft /> Voltar</Link>
        <a href={`/gerencial/excel${qs ? `?${qs}` : ""}`} className="botao botao-neutro"><FileSpreadsheet /> Excel</a>
        <BotaoImprimir />
      </div>
      <article className="rel">
        <CabecalhoRelatorio orgao={u.orgaoNome} tipo="Relatório gerencial consolidado" titulo="Carteira de obras" subtitulo={descreverFiltros(filtros, p.unidades)}
          selo={{ texto: p.porNivel.vermelho ? `${p.porNivel.vermelho} ${p.porNivel.vermelho === 1 ? "obra crítica" : "obras críticas"}` : p.porNivel.amarelo ? "Pontos de atenção" : "Carteira em dia", cor: p.porNivel.vermelho ? "vermelho" : p.porNivel.amarelo ? "laranja" : "verde" }}
          dados={[["Recorte", descreverFiltros(filtros, p.unidades)], ["Posição em", dataHora(new Date())], ["Obras", String(p.obras.length)], ["Emitido por", u.nome]]} />

        <Secao numero={n()} titulo="Resumo executivo">
          <Indicadores itens={[
            { rotulo: "Valor contratado", valor: moeda(t.contratado), destaque: true },
            { rotulo: "Medido", valor: moeda(t.medido), detalhe: `${percentual(pct(t.medido, t.contratado), 1)} do contratado` },
            { rotulo: "Pago", valor: moeda(t.pago), detalhe: `${percentual(pct(t.pago, t.medido), 1)} do medido` },
            { rotulo: "A pagar", valor: moeda(t.aPagar) },
            { rotulo: "Saldo a medir", valor: moeda(t.saldo) },
          ]} />
          <ul className="rel-pontos">{pontos.map((x) => <li key={x}>{x}</li>)}</ul>
          {p.obras.length > 0 && <BarrasHorizontais titulo="Obras por situação do semáforo (quantidade)" unidade=""
            itens={(["vermelho", "amarelo", "verde"] as Nivel[]).map((k) => ({ rotulo: ROTULO_NIVEL[k], valor: p.porNivel[k], cor: COR_NIVEL[k] }))} />}
        </Secao>

        <Secao numero={n()} titulo="Pontos de atenção por obra">
          {atencao.length === 0 ? <p className="fraco">Nenhuma obra com ponto de atenção no recorte.</p> : (
            <table className="rel-tabela">
              <thead><tr><th>Obra</th><th>Situação</th><th>Nível</th><th>Motivos</th></tr></thead>
              <tbody>{atencao.map((o) => (
                <tr key={o.id}><td><b className="num">{o.codigo}</b> {o.nome}</td><td>{ROTULO_SITUACAO[o.situacao]}</td>
                  <td><span className="sinal" style={{ ["--sinal" as string]: COR_NIVEL[o.nivel] }} />{ROTULO_NIVEL[o.nivel]}</td>
                  <td>{o.motivos.map((m) => m.texto).join("; ")}.</td></tr>
              ))}</tbody>
            </table>
          )}
        </Secao>

        {comContrato.length > 0 && (
          <Secao numero={n()} titulo="Execução financeira por obra" descricao="Valores dos contratos assinados, incluindo aditivos. A pagar = líquido das medições aprovadas menos os pagamentos registrados.">
            <table className="rel-tabela">
              <thead><tr><th>Obra</th><th className="dir">Contratado (R$)</th><th className="dir">Medido (R$)</th><th className="dir">Medido</th><th className="dir">Pago (R$)</th><th className="dir">A pagar (R$)</th><th className="dir">Saldo (R$)</th><th>Vigência</th></tr></thead>
              <tbody>{comContrato.map((o) => (
                <tr key={o.id}><td><b className="num">{o.codigo}</b> {o.nome}</td>
                  <td className="dir num">{moeda(o.contratado)}</td><td className="dir num">{moeda(o.medido)}</td><td className="dir num">{percentual(o.executadoPct, 1)}</td>
                  <td className="dir num">{moeda(o.pago)}</td><td className="dir num">{moeda(o.aPagar)}</td><td className="dir num">{moeda(o.saldo)}</td>
                  <td className="num">{o.vigenciaFim ? dataCurta(o.vigenciaFim) : "—"}</td></tr>
              ))}</tbody>
              <tfoot><tr><td>Total</td><td className="dir num">{moeda(t.contratado)}</td><td className="dir num">{moeda(t.medido)}</td><td className="dir num">{percentual(pct(t.medido, t.contratado), 1)}</td>
                <td className="dir num">{moeda(t.pago)}</td><td className="dir num">{moeda(t.aPagar)}</td><td className="dir num">{moeda(t.saldo)}</td><td /></tr></tfoot>
            </table>
            {mensalComValor && <ColunasMensais titulo="Medido e pago por mês nos últimos 12 meses (R$)" series={[{ rotulo: "Medido", cor: COR.bdi }, { rotulo: "Pago", cor: COR.maoDeObra }]}
              meses={p.mensal.map((x) => ({ rotulo: rotuloMes(x.mes), valores: [x.medido, x.pago] }))} />}
          </Secao>
        )}

        {comIdp.length > 0 && (
          <Secao numero={n()} titulo="Avanço físico" descricao={`IDP = valor agregado ÷ valor planejado até hoje na linha de base do cronograma. Abaixo de ${numero(LIMITES.idpAtencao, 2)} pede atenção; abaixo de ${numero(LIMITES.idpCritico, 2)} é crítico.`}>
            <table className="rel-tabela">
              <thead><tr><th>Obra</th><th>Situação</th><th className="dir">Previsto até hoje</th><th className="dir">Executado</th><th className="dir">Medido</th><th className="dir">IDP</th></tr></thead>
              <tbody>{comIdp.map((o) => (
                <tr key={o.id}><td><b className="num">{o.codigo}</b> {o.nome}</td><td>{ROTULO_SITUACAO[o.situacao]}</td>
                  <td className="dir num">{percentual(o.previstoPct!, 1)}</td><td className="dir num">{percentual(o.realizadoPct!, 1)}</td>
                  <td className="dir num">{o.contratado ? percentual(o.executadoPct, 1) : "—"}</td>
                  <td className={`dir num${o.idp! < LIMITES.idpAtencao ? " forte" : ""}`}>{numero(o.idp!, 2)}</td></tr>
              ))}</tbody>
            </table>
          </Secao>
        )}

        <Secao numero={n()} titulo="Agenda de vencimentos" descricao="Prazos vencidos e os que vencem nos próximos 60 dias.">
          {p.vencimentos.length === 0 ? <p className="fraco">Nenhum prazo vencido ou a vencer nos próximos 60 dias.</p> : (
            <table className="rel-tabela">
              <thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Obra</th><th>Situação</th></tr></thead>
              <tbody>{p.vencimentos.map((v, i) => (
                <tr key={i}><td className="num">{dataCurta(v.data)}</td><td>{v.tipo}</td><td>{v.descricao}</td><td className="num">{v.obraCodigo ?? "—"}</td><td className={v.vencido ? "forte" : ""}>{v.vencido ? "Vencido" : "A vencer"}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Secao>

        <Secao numero={n()} titulo="Metodologia e fontes">
          <ul className="rel-metodologia">
            <li><b>Semáforo:</b> crítico com IDP abaixo de {numero(LIMITES.idpCritico, 2)}, vigência do contrato encerrada ou não conformidade grave ou impeditiva aberta. Atenção com IDP abaixo de {numero(LIMITES.idpAtencao, 2)}, vigência terminando em até {LIMITES.vigenciaAviso} dias, mais de {LIMITES.diasSemMedicao} dias sem medição aprovada, medido mais de {LIMITES.medidoAFrente} pontos percentuais à frente do físico, não conformidade com prazo vencido, documento obrigatório faltando ou vencido, pessoa alocada com ASO ou treinamento vencido, ou obra paralisada.</li>
            <li><b>Financeiro:</b> contratado é o valor atual dos contratos assinados, com aditivos e reajustes; medido é o bruto das medições aprovadas; pago, os pagamentos registrados.</li>
            <li><b>Físico:</b> valor agregado e valor planejado da linha de base do cronograma, na data de emissão.</li>
            <li><b>Recorte:</b> obras da licitação ao recebimento provisório no seu acesso{qs ? ", com os filtros indicados no cabeçalho" : ""}.</li>
            <li><b>Fonte:</b> contratos, medições, pagamentos, cronogramas, não conformidades, documentos e equipes registrados no sistema.</li>
          </ul>
        </Secao>
        <RodapeRelatorio texto={`CiviObras · ${u.orgaoNome} · relatório gerencial · gerado em ${dataHora(new Date())}`} />
      </article>
    </div>
  );
}
