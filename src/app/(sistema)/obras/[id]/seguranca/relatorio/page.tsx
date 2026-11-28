import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { CabecalhoRelatorio, Indicadores, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { BarrasHorizontais, COR } from "@/componentes/relatorio/Graficos";
import { ErroDeRegra } from "@/lib/db";
import { dataCurta, dataHora, numero } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { SemPermissao } from "@/servicos/permissoes";
import { ROTULO_GRAVIDADE, ROTULO_SITUACAO_NC, rotuloNc } from "@/servicos/qualidade";
import { painelSeguranca, ROTULO_OCORRENCIA, TIPOS_OCORRENCIA } from "@/servicos/seguranca";

export const metadata: Metadata = { title: "Relatório de segurança" };

export default async function RelatorioSeguranca({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await exigirUsuario();
  let p;
  try {
    p = await painelSeguranca(comoAtor(u), id, true);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) notFound();
    throw e;
  }
  const porTipo = TIPOS_OCORRENCIA.map((t) => ({ rotulo: ROTULO_OCORRENCIA[t], valor: p.ocorrencias.filter((o) => o.tipo === t).length, cor: t.startsWith("acidente") ? "#c23a3a" : t === "risco_grave" ? COR.maoDeObra : COR.material }));
  const epis = new Map<string, number>();
  for (const e of p.epis) epis.set(e.epi, (epis.get(e.epi) ?? 0) + e.quantidade);
  const ncs = p.qualidade.ncs.filter((n) => n.situacao === "aberta" || n.situacao === "corrigida");
  const pontos: string[] = [];
  if (p.diasSemAcidente != null) pontos.push(p.ultimoAcidente ? `${p.diasSemAcidente} dias sem acidente desde ${dataCurta(p.ultimoAcidente)}.` : `${p.diasSemAcidente} dias sem acidente desde o início da obra.`);
  if (p.vencidas) pontos.push(`${p.vencidas} ${p.vencidas === 1 ? "ação corretiva vencida" : "ações corretivas vencidas"}.`);
  if (p.horasParalisadas) pontos.push(`${numero(p.horasParalisadas, 1)} h de frente paralisada por risco à segurança.`);
  if (ncs.length) pontos.push(`${ncs.length} ${ncs.length === 1 ? "não conformidade de segurança em aberto" : "não conformidades de segurança em aberto"}.`);
  let s = 0;
  const n = () => ++s;

  return (
    <div className="grade">
      <div className="barra-acoes nao-imprimir">
        <Link href={`/obras/${id}/seguranca`} className="botao botao-neutro"><ArrowLeft /> Voltar</Link>
        <a href={`/obras/${id}/seguranca/excel`} className="botao botao-neutro"><FileSpreadsheet /> Excel</a>
        <BotaoImprimir />
      </div>
      <article className="rel">
        <CabecalhoRelatorio orgao={u.orgaoNome} tipo="Relatório de segurança do trabalho" titulo={`Segurança · ${p.obra.codigo}`} subtitulo={p.obra.nome}
          selo={{ texto: p.diasSemAcidente == null ? "Obra sem data de início" : `${p.diasSemAcidente} dias sem acidente`, cor: p.acidentes && p.diasSemAcidente != null && p.diasSemAcidente < 30 ? "laranja" : "verde" }}
          dados={[["Obra", `${p.obra.codigo} · ${p.obra.nome}`], ["Posição em", dataHora(new Date())], ["Ocorrências", String(p.ocorrencias.length)], ["Entregas de EPI", String(p.epis.length)]]} />
        <Secao numero={n()} titulo="Resumo executivo">
          <Indicadores itens={[
            { rotulo: "Dias sem acidente", valor: String(p.diasSemAcidente ?? "—"), destaque: true },
            { rotulo: "Acidentes", valor: String(p.acidentes), detalhe: `${p.afastamento} dias de afastamento` },
            { rotulo: "Quase acidentes", valor: String(p.quaseAcidentes) },
            { rotulo: "Riscos graves", valor: String(p.riscos), detalhe: `${numero(p.horasParalisadas, 1)} h paralisadas` },
            { rotulo: "Ações abertas", valor: String(p.abertas), detalhe: `${p.vencidas} vencidas` },
          ]} />
          <ul className="rel-pontos">{pontos.map((x) => <li key={x}>{x}</li>)}</ul>
        </Secao>
        {p.ocorrencias.length > 0 && (
          <Secao numero={n()} titulo="Ocorrências e ações corretivas">
            <BarrasHorizontais titulo="Ocorrências por tipo" unidade="" itens={porTipo} />
            <table className="rel-tabela">
              <thead><tr><th>Nº</th><th>Data</th><th>Tipo</th><th>Descrição</th><th>Ação corretiva</th><th>Prazo</th><th>Situação</th></tr></thead>
              <tbody>{p.ocorrencias.map((o) => (
                <tr key={o.id}><td className="num">{o.numero}</td><td className="num">{dataCurta(o.data)}</td><td>{ROTULO_OCORRENCIA[o.tipo]}</td>
                  <td>{o.descricao}{o.envolvido ? <div className="fraco">{o.envolvido}{o.diasAfastamento ? `, ${o.diasAfastamento} dias de afastamento` : ""}</div> : null}</td>
                  <td>{o.acaoCorretiva}<div className="fraco">{o.responsavel}</div></td><td className="num">{dataCurta(o.prazo)}</td>
                  <td>{o.situacao === "encerrada" ? "Encerrada" : o.vencida ? "Vencida" : "Aberta"}</td></tr>
              ))}</tbody>
            </table>
          </Secao>
        )}
        {p.qualidade.inspecoes.length > 0 && (
          <Secao numero={n()} titulo="Inspeções de segurança">
            <table className="rel-tabela">
              <thead><tr><th>Nº</th><th>Checklist</th><th>Data</th><th>Local</th><th className="dir">Conformidade</th></tr></thead>
              <tbody>{p.qualidade.inspecoes.map((i) => { const t = i.conformes + i.naoConformes; return (
                <tr key={i.id}><td className="num">{i.numero}</td><td>{i.titulo}</td><td className="num">{dataCurta(i.data)}</td><td>{i.local ?? "—"}</td><td className="dir num">{t ? Math.round((i.conformes / t) * 100) : 100}%</td></tr>); })}</tbody>
            </table>
          </Secao>
        )}
        {ncs.length > 0 && (
          <Secao numero={n()} titulo="Não conformidades de segurança em aberto">
            <table className="rel-tabela">
              <thead><tr><th>NC</th><th>Descrição</th><th>Gravidade</th><th>Responsável</th><th>Prazo</th><th>Situação</th></tr></thead>
              <tbody>{ncs.map((x) => <tr key={x.id}><td className="num">{rotuloNc(x)}</td><td>{x.titulo}</td><td>{ROTULO_GRAVIDADE[x.gravidade]}</td><td>{x.responsavel}</td><td className="num">{dataCurta(x.prazo)}</td><td>{ROTULO_SITUACAO_NC[x.situacao]}</td></tr>)}</tbody>
            </table>
          </Secao>
        )}
        {epis.size > 0 && (
          <Secao numero={n()} titulo="Entrega de EPI">
            <BarrasHorizontais titulo="Unidades entregues por EPI" unidade="un." itens={[...epis].sort((a, b) => b[1] - a[1]).map(([rotulo, valor]) => ({ rotulo, valor }))} />
          </Secao>
        )}
        <Secao numero={n()} titulo="Metodologia e fontes">
          <ul className="rel-metodologia">
            <li><b>Dias sem acidente:</b> dias corridos desde o último acidente (com ou sem afastamento) ou, sem acidente, desde a ordem de serviço.</li>
            <li><b>Ação vencida:</b> ocorrência aberta com prazo da ação corretiva anterior a hoje.</li>
            <li><b>Paralisação:</b> registrada pelo fiscal ou engenheiro em risco grave e iminente; entra no diário do dia como paralisação por segurança.</li>
            <li><b>Fonte:</b> ocorrências, inspeções, não conformidades e entregas de EPI registradas no sistema para esta obra.</li>
          </ul>
        </Secao>
        <RodapeRelatorio texto={`CiviObras · ${u.orgaoNome} · ${p.obra.codigo} · relatório de segurança · gerado em ${dataHora(new Date())}`} />
      </article>
    </div>
  );
}
