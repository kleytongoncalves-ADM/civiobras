import type { Metadata } from "next";
import { FileSpreadsheet } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { dataHoraCurta, difPct } from "@/componentes/cotacao/Pecas";
import { ApuracaoPorItem } from "@/componentes/cotacao/ApuracaoPorItem";
import { ComparacaoAutomatica, NotasCustoBeneficio, textoPesos } from "@/componentes/cotacao/Comparacao";
import { Classificacao, fraseEconomia, ItensApurados } from "@/componentes/cotacao/Resultado";
import { BarrasHorizontais, COR } from "@/componentes/relatorio/Graficos";
import { CabecalhoRelatorio, Indicadores, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { dataHora, dataLonga, mesAno, moeda, percentual, quantidade, valor, resumir } from "@/lib/formato";
import { formatarCnpj } from "@/servicos/contratos";
import { FATORES, LIMITES_PADRAO, mediaMediana, totaisMediaMediana, ROTULO_CRITERIO_APURACAO, ROTULO_FATOR } from "@/servicos/cotacao-calculo";
import { protocolo, ROTULO_CONVITE, ROTULO_SITUACAO_COTACAO } from "@/servicos/cotacoes";
import { ROTULO_FONTE, ROTULO_REGIME, type Fonte, type Regime } from "@/servicos/precos";
import { carregarSolicitacao } from "../carregar";
import { Fechada } from "../Fechada";
import { unidade } from "@/lib/unidade";

export const metadata: Metadata = { title: "Relatório da cotação" };

const fatias = <T,>(v: T[], n: number) => Array.from({ length: Math.ceil(v.length / n) }, (_, i) => v.slice(i * n, i * n + n));

export default async function RelatorioDaCotacao({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { usuario, s } = await carregarSolicitacao(id);
  const m = s.mapa;
  if (!s.precosVisiveis || !m) return <Fechada s={s} titulo="Relatório indisponível" />;
  const ap = s.situacao === "apurada" ? s.apuracoes[0] ?? null : null;
  const r = ap?.resultado ?? null;
  const numero = String(s.numero).padStart(3, "0");
  const fonte = `${ROTULO_FONTE[s.fonte as Fonte] ?? s.fonte} ${s.uf} ${mesAno(s.mes)}`;
  const propostas = new Map(s.propostas.map((p) => [p.conviteId, p]));
  const totais = new Map((s.mapaTodos ?? m).fornecedores.map((f) => [f.conviteId, f]));
  const naComparacao = new Set(s.comparadas.map((p) => p.conviteId));
  const foraDaComparacao = s.propostas.filter((p) => !naComparacao.has(p.conviteId));
  const semRef = s.materiais.filter((x) => x.precoReferencia == null || x.semSinapi).length;
  const mudancas = s.eventos.filter((e) => ["prorrogacao", "reabertura", "cancelamento", "encerramento"].includes(e.tipo)).reverse();
  const anteriores = s.apuracoes.slice(ap ? 1 : 0);
  const vencedores = r ? new Set(r.itens.filter((i) => i.conviteId).map((i) => i.conviteId)).size : 0;
  const economias = r ? r.itens.filter((i) => i.economia != null && Number(i.economia) !== 0).sort((a, b) => Number(b.economia) - Number(a.economia)).slice(0, 10) : [];

  // Resumo executivo: só fatos tirados dos números da cotação.
  const resumo: string[] = [];
  resumo.push(`${s.convites.length} ${s.convites.length === 1 ? "fornecedor convidado" : "fornecedores convidados"}; ${s.respondidas} ${s.respondidas === 1 ? "enviou proposta" : "enviaram proposta"}, ${s.declinaram} ${s.declinaram === 1 ? "declinou" : "declinaram"} e ${s.pendentes} não ${s.pendentes === 1 ? "respondeu" : "responderam"}.`);
  if (foraDaComparacao.length) resumo.push(`Comparação feita com ${s.comparadas.length} das ${s.propostas.length} propostas recebidas, por escolha da equipe.`);
  resumo.push(`${m.itensCotados} de ${m.linhas.length} materiais receberam preço válido; ${m.itensComTres} com três preços ou mais.`);
  if (m.menorGlobal) resumo.push(`Menor proposta com todos os itens: ${m.menorGlobal.fornecedor}, ${moeda(m.menorGlobal.total)}${m.economiaGlobalPct != null ? ` (${difPct(-m.economiaGlobalPct)} em relação à referência)` : ""}.`);
  else if (s.propostas.length) resumo.push("Nenhum fornecedor cotou todos os itens.");
  if (m.itensCotados) resumo.push(`Soma do menor preço de cada item: ${moeda(m.somaMenores)}${m.economiaPorItemPct != null ? `, ${percentual(Math.abs(m.economiaPorItemPct), 1)} ${m.economiaPorItemPct >= 0 ? "abaixo" : "acima"} da referência dos itens cotados (${moeda(m.refDosMenores)})` : ""}.`);
  if (m.custoConcentrar && Number(m.custoConcentrar) > 0) resumo.push(`Comprar tudo do fornecedor de menor total custa ${moeda(m.custoConcentrar)} a mais que dividir a compra pelo menor preço de cada item.`);
  if (m.discrepantes) resumo.push(`${m.discrepantes} ${m.discrepantes === 1 ? "preço ficou" : "preços ficaram"} fora do padrão (mais de ${LIMITES_PADRAO.abaixo}% abaixo ou ${LIMITES_PADRAO.acima}% acima da mediana ou da referência).`);
  if (r) resumo.push(`Resultado homologado pelo critério de ${ROTULO_CRITERIO_APURACAO[r.criterio].toLowerCase()}: ${r.vencedor ? r.vencedor.fornecedor : `${vencedores} ${vencedores === 1 ? "fornecedor" : "fornecedores"}`}, ${moeda(r.totalResultado)}. ${fraseEconomia(r)}`);
  else resumo.push(s.situacao === "cancelada" ? "Cotação cancelada sem resultado em vigor." : "Apuração ainda não homologada.");
  if (semRef) resumo.push(`${semRef} ${semRef === 1 ? "material não tem" : "materiais não têm"} preço de referência e ${semRef === 1 ? "fica" : "ficam"} fora do cálculo de economia.`);
  const { media: totalMedia, mediana: totalMediana } = totaisMediaMediana(m);
  const c = s.comparacao;
  let n = 0;

  return (
    <div className="grade">
      <div className="barra-acoes nao-imprimir">
        <BotaoImprimir />
        <a href={`/cotacoes/${id}/excel`} className="botao botao-neutro"><FileSpreadsheet /> Planilha Excel</a>
      </div>

      <article className="rel" style={{ minWidth: 0 }}>
        <CabecalhoRelatorio
          orgao={usuario.orgaoNome}
          tipo="Relatório de cotação de materiais"
          titulo={`Cotação nº ${numero}`}
          subtitulo={`${s.titulo} · ${s.obraCodigo} · ${s.obraNome}`}
          selo={{ texto: ROTULO_SITUACAO_COTACAO[s.situacao], cor: s.situacao === "apurada" ? "verde" : s.situacao === "cancelada" ? "vermelho" : s.situacao === "encerrada" ? "laranja" : "neutro" }}
          dados={[
            ["Orçamento", `Nº ${s.orcamentoNumero} v${s.orcamentoVersao} · ${s.orcamentoNome}`],
            ["Referência de preços", `${fonte} · ${ROTULO_REGIME[s.regime as Regime] ?? s.regime}`],
            ["Critério", ROTULO_CRITERIO_APURACAO[s.criterio]],
            ["Totais", `${s.arredondamento === "truncar" ? "Truncados" : "Arredondados"} em 2 casas`],
            ["Envio", s.enviadaEm ? `${dataHoraCurta(s.enviadaEm)}${s.enviadaPor ? ` · ${s.enviadaPor}` : ""}` : null],
            ["Prazo de resposta", dataHoraCurta(s.prazo)],
            ["Encerramento", s.encerradaEm ? dataHoraCurta(s.encerradaEm) : "Em andamento"],
            ["Homologação", ap ? `${dataHoraCurta(ap.homologadaEm)}${ap.homologadaPor ? ` · ${ap.homologadaPor}` : ""}` : "Pendente"],
          ]}
        />

        {s.fonte === "demonstracao" && <p className="rel-alerta">Preços de referência da base de demonstração, ilustrativos. Não usar para contratação.</p>}
        {s.situacao === "cancelada" && s.canceladaMotivo && <p className="rel-alerta">Cotação cancelada: {s.canceladaMotivo}</p>}

        <Secao numero={++n} titulo="Resumo executivo">
          <Indicadores itens={[
            { rotulo: r ? "Resultado homologado" : "Soma dos menores preços", valor: moeda(r ? r.totalResultado : m.somaMenores), destaque: true },
            { rotulo: "Referência do orçamento", valor: moeda(s.totalReferencia), detalhe: `${s.materiais.length} ${s.materiais.length === 1 ? "material" : "materiais"}` },
            { rotulo: r ? "Economia homologada" : "Economia possível", valor: moeda((r ? r.economia : m.economiaPorItem) ?? 0), detalhe: (r ? r.economiaPct : m.economiaPorItemPct) != null ? `${percentual((r ? r.economiaPct : m.economiaPorItemPct)!, 1)} sobre a referência` : undefined },
            { rotulo: "Propostas", valor: `${s.respondidas} de ${s.convites.length}`, detalhe: `${s.declinaram} ${s.declinaram === 1 ? "declinou" : "declinaram"} · ${s.pendentes} sem resposta` },
          ]} />
          <ul className="rel-pontos">{resumo.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Secao>

        <Secao numero={++n} titulo="Materiais solicitados" descricao={`Quantidades e preços de referência do orçamento nº ${s.orcamentoNumero} v${s.orcamentoVersao}, fixados no envio da solicitação.`}>
          <div className="rel-rolagem"><table className="rel-tabela">
            <thead><tr><th>Item</th><th>Código</th><th>Descrição</th><th>Und.</th><th className="dir">Quantidade</th><th className="dir">Preço de referência (R$)</th><th className="dir">Total de referência (R$)</th></tr></thead>
            <tbody>{m.linhas.map((l, i) => (
              <tr key={l.material.id}>
                <td className="num">{i + 1}</td><td className="num">{l.material.semSinapi ? "—" : l.material.codigo}</td><td>{l.material.descricao}</td><td>{unidade(l.material.unidade)}</td>
                <td className="dir num">{quantidade(l.material.quantidade)}</td><td className="dir num">{l.material.precoReferencia == null ? "—" : valor(l.material.precoReferencia)}</td>
                <td className="dir num">{l.refTotal == null ? "—" : valor(l.refTotal)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={6}>Total de referência</td><td className="dir num">{valor(m.totalReferencia)}</td></tr></tfoot>
          </table></div>
          <dl className="rel-identificacao" style={{ marginTop: 14 }}>
            <div><dt>Local de entrega</dt><dd>{s.localEntrega ?? "—"}</dd></div>
            <div><dt>Frete</dt><dd>{s.freteIncluso ? "Incluso no preço" : "Informado à parte"}</dd></div>
            <div><dt>Validade mínima da proposta</dt><dd>{s.validadeMinima ? `${s.validadeMinima} dias` : "Não exigida"}</dd></div>
            <div><dt>Propostas</dt><dd>{s.sigilo ? "Fechadas até o prazo" : "Visíveis ao chegar"}</dd></div>
          </dl>
        </Secao>

        <Secao numero={++n} titulo="Fornecedores consultados">
          <div className="rel-rolagem"><table className="rel-tabela">
            <thead><tr><th>Fornecedor</th><th>CNPJ</th><th>Situação</th><th>Proposta recebida</th><th>Responsável</th><th className="dir">Entrega</th><th className="dir">Pagamento</th><th className="dir">Validade</th><th className="dir">Itens cotados</th><th className="dir">Total (R$)</th></tr></thead>
            <tbody>{s.convites.map((c) => {
              const p = propostas.get(c.id);
              const t = totais.get(c.id);
              return (
                <tr key={c.id}>
                  <td className="forte">{c.razaoSocial}</td><td className="num">{formatarCnpj(c.cnpj)}</td>
                  <td>{ROTULO_CONVITE[c.situacao]}{c.declinouMotivo ? `: ${c.declinouMotivo}` : ""}{p && !naComparacao.has(c.id) ? <><br />Fora da comparação</> : null}</td>
                  <td className="num">{p ? <>{dataHoraCurta(p.enviadaEm)} · v{p.versao}{p.origem === "equipe" ? <><br />lançada pela equipe{p.documento ? ` · ${p.documento}` : ""}</> : null}<br />{protocolo(p.resumo, p.versao)}</> : "—"}</td>
                  <td>{p ? p.responsavelNome : "—"}</td>
                  <td className="dir num">{p?.prazoEntrega != null ? `${p.prazoEntrega} dias` : "—"}</td>
                  <td className="dir num">{p?.pagamentoDias != null ? `${p.pagamentoDias} dias` : "—"}</td>
                  <td className="dir num">{p?.validadeDias != null ? `${p.validadeDias} dias` : "—"}</td>
                  <td className="dir num">{t ? `${t.itensCotados} de ${t.itens}` : "—"}</td>
                  <td className="dir num forte">{t ? valor(t.total) : "—"}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {foraDaComparacao.length > 0 && <p className="rel-nota-formula">Fora da comparação por escolha da equipe: {foraDaComparacao.map((p) => p.fornecedor).join("; ")}. As propostas continuam registradas e não entram no mapa, na média, na mediana nem na apuração.</p>}
          {s.justificativaMinimo && <p className="rel-nota-formula">Menos de três fornecedores convidados. Justificativa: {s.justificativaMinimo}</p>}
        </Secao>

        {m.fornecedores.length > 0 && (
          <Secao numero={++n} titulo="Mapa comparativo de preços" descricao="Preço unitário em R$: referência do orçamento, propostas lado a lado, média e mediana dos preços válidos de cada item. O menor preço está em negrito, com ▼. O percentual compara com a referência. Quando o fornecedor cobra frete à parte, ele já está rateado nos preços.">
            {fatias(m.fornecedores, m.fornecedores.length <= 4 ? 4 : Math.ceil(m.fornecedores.length / Math.ceil(m.fornecedores.length / 4))).map((grupo, g) => (
              <div className="rel-rolagem" key={g} style={g ? { marginTop: 18 } : undefined}><table className="rel-tabela">
                <thead><tr><th>Item</th><th>Material</th><th>Und.</th><th className="dir">Quant.</th><th className="dir">Referência</th>{grupo.map((f) => <th key={f.conviteId} className="dir" style={{ whiteSpace: "normal" }}>{f.fornecedor}</th>)}<th className="dir">Média</th><th className="dir">Mediana</th></tr></thead>
                <tbody>{m.linhas.map((l, i) => (
                  <tr key={l.material.id}>
                    <td className="num">{i + 1}</td><td>{l.material.descricao}</td><td>{unidade(l.material.unidade)}</td><td className="dir num">{quantidade(l.material.quantidade)}</td>
                    <td className="dir num">{l.material.precoReferencia == null ? "—" : valor(l.material.precoReferencia)}</td>
                    {grupo.map((f) => {
                      const o = l.ofertas.find((x) => x.conviteId === f.conviteId);
                      if (!o || o.preco == null) return <td key={f.conviteId} className="dir">Indisponível</td>;
                      return (
                        <td key={f.conviteId} className="dir num" style={o.excluida ? { textDecoration: "line-through", opacity: 0.6 } : o.menor ? { fontWeight: 750 } : undefined}>
                          {o.menor ? "▼ " : ""}{valor(o.preco)}{o.discrepante ? " *" : ""}
                          <br /><span style={{ fontWeight: 400, whiteSpace: "normal" }}>{[o.difSinapi != null ? difPct(o.difSinapi) : null, o.marca, o.modelo].filter(Boolean).join(" · ")}</span>
                        </td>
                      );
                    })}
                    {(() => { const e = mediaMediana(l); return <><td className="dir num">{e.media == null ? "—" : valor(e.media)}</td><td className="dir num">{e.mediana == null ? "—" : valor(e.mediana)}</td></>; })()}
                  </tr>
                ))}</tbody>
                <tfoot>
                  <tr><td colSpan={4}>Total dos itens cotados</td><td className="dir num">{valor(m.totalReferencia)}</td>{grupo.map((f) => <td key={f.conviteId} className="dir num">{valor(f.total)}{f.difSinapi != null ? <><br /><span style={{ fontWeight: 400 }}>{difPct(f.difSinapi)}</span></> : null}</td>)}<td className="dir num">{totalMedia == null ? "—" : valor(totalMedia)}</td><td className="dir num">{totalMediana == null ? "—" : valor(totalMediana)}</td></tr>
                  <tr><td colSpan={5}>Itens cotados</td>{grupo.map((f) => <td key={f.conviteId} className="dir num">{f.itensCotados} de {f.itens}</td>)}<td /><td /></tr>
                </tfoot>
              </table></div>
            ))}
            <p className="rel-nota-formula">
              {m.discrepantes > 0 ? `* Preço fora do padrão: mais de ${LIMITES_PADRAO.abaixo}% abaixo ou ${LIMITES_PADRAO.acima}% acima da mediana do item (com três preços ou mais) ou da referência. ` : ""}
              Preço riscado: retirado da disputa por avaliação técnica. No total, o percentual usa a referência apenas dos itens que o fornecedor cotou.
            </p>
            <div style={{ breakInside: "avoid" }}>
              <h4 className="rel-sub" style={{ marginTop: 18 }}>Apuração por item</h4>
              <p className="rel-nota-formula" style={{ marginTop: 0 }}>Para cada material: preço de referência, número de preços recebidos, menor e maior preço, média e mediana, em R$ por unidade. O percentual compara cada valor com a referência.</p>
              <div className="rel-rolagem"><ApuracaoPorItem m={m} rel /></div>
            </div>
            {c && (
              <>
                <h4 className="rel-sub" style={{ marginTop: 18 }}>Comparação automática</h4>
                <ComparacaoAutomatica c={c} rel />
                {c.classificacao.length > 0 && <div className="rel-rolagem" style={{ marginTop: 12 }}><NotasCustoBeneficio c={c} rel /></div>}
                <p className="rel-nota-formula">Custo-benefício: nota de 0 a 100 por fator, ponderada pelos pesos {c.pesosDaSolicitacao ? "fixados no envio da solicitação" : "padrão do sistema"} ({textoPesos(c)}), entre as propostas que cotaram todos os itens. A marca não pontua. {c.pesosDaSolicitacao ? "" : `A comparação é informativa: o critério desta cotação é ${ROTULO_CRITERIO_APURACAO[s.criterio].toLowerCase()}.`}</p>
              </>
            )}
            <BarrasHorizontais titulo="Total dos itens cotados por fornecedor (R$)" unidade="" casas={2} itens={[
              { rotulo: "Referência do orçamento", valor: Number(m.totalReferencia), cor: COR.maoDeObra },
              ...m.fornecedores.map((f) => ({ rotulo: `${f.fornecedor}${f.completa ? "" : ` (${f.itensCotados} de ${f.itens} itens)`}`, valor: Number(f.total), cor: m.menorGlobal?.conviteId === f.conviteId ? "#2a9d63" : COR.bdi })),
            ]} />
          </Secao>
        )}

        {r && ap && (
          <Secao numero={++n} titulo="Homologação e resultado" descricao={`Apuração nº ${ap.numero}, pelo critério de ${ROTULO_CRITERIO_APURACAO[r.criterio].toLowerCase()}.`}>
            <h4 className="rel-sub">Classificação</h4>
            <div className="rel-rolagem"><Classificacao a={r} rel /></div>
            <h4 className="rel-sub" style={{ marginTop: 18 }}>Resultado por item</h4>
            <div className="rel-rolagem"><ItensApurados a={r} rel /></div>
            {economias.length > 1 && (
              <BarrasHorizontais titulo="Maiores economias por item em relação à referência (R$)" unidade="" casas={2} cor={COR.material}
                itens={economias.filter((i) => Number(i.economia) > 0).map((i) => ({ rotulo: i.descricao.length > 46 ? resumir(i.descricao, 46) : i.descricao, valor: Number(i.economia) }))} />
            )}
          </Secao>
        )}

        {(ap?.justificativa || s.avaliacoes.length > 0 || mudancas.length > 0 || anteriores.length > 0) && (
          <Secao numero={++n} titulo="Justificativas e ocorrências">
            {ap?.justificativa && (
              <>
                <h4 className="rel-sub">Justificativa da homologação</h4>
                <p className="rel-memoria" style={{ whiteSpace: "pre-wrap" }}>{ap.justificativa}</p>
                {ap.vencedorConviteId && ap.escolhidoConviteId && ap.vencedorConviteId !== ap.escolhidoConviteId && (
                  <p className="rel-nota-formula">O fornecedor homologado é diferente do primeiro classificado pelo cálculo ({s.convites.find((c) => c.id === ap.vencedorConviteId)?.razaoSocial ?? "—"}).</p>
                )}
              </>
            )}
            {(r?.desconsiderados.length ?? 0) > 0 && (
              <>
                <h4 className="rel-sub" style={{ marginTop: 16 }}>Preços retirados da disputa</h4>
                <div className="rel-rolagem"><table className="rel-tabela">
                  <thead><tr><th>Fornecedor</th><th>Material</th><th className="dir">Preço (R$)</th><th>Motivo</th><th>Justificativa</th></tr></thead>
                  <tbody>{r!.desconsiderados.map((d) => (
                    <tr key={`${d.conviteId}|${d.materialId}`}><td className="forte">{d.fornecedor}</td><td>{d.descricao}</td><td className="dir num">{d.preco ? valor(d.preco) : "—"}</td>
                      <td>{d.tipo === "nao_atende" ? "Não atende à especificação" : "Preço desconsiderado"}</td><td>{d.justificativa}</td></tr>
                  ))}</tbody>
                </table></div>
              </>
            )}
            {mudancas.length > 0 && (
              <>
                <h4 className="rel-sub" style={{ marginTop: 16 }}>Prazos e situação</h4>
                <div className="rel-rolagem"><table className="rel-tabela">
                  <thead><tr><th>Data</th><th>Ocorrência</th><th>Responsável</th><th>Justificativa</th></tr></thead>
                  <tbody>{mudancas.map((e) => (
                    <tr key={e.id}><td className="num">{dataHoraCurta(e.em)}</td><td>{e.resumo}</td><td>{e.usuario ?? "Automático"}</td>
                      <td>{typeof e.detalhe?.justificativa === "string" ? e.detalhe.justificativa : typeof e.detalhe?.motivo === "string" ? e.detalhe.motivo : "—"}</td></tr>
                  ))}</tbody>
                </table></div>
              </>
            )}
            {anteriores.length > 0 && <p className="rel-nota-formula">Apurações anteriores substituídas: {anteriores.map((a) => `nº ${a.numero}, de ${dataHoraCurta(a.homologadaEm)} (${moeda(a.totalResultado)})`).join("; ")}.</p>}
          </Secao>
        )}

        <Secao numero={++n} titulo="Metodologia e fontes">
          <ul className="rel-metodologia">
            <li>Materiais, quantidades e preços de referência vêm do orçamento nº {s.orcamentoNumero} v{s.orcamentoVersao}, base {fonte}, e ficam fixos a partir do envio da solicitação.</li>
            <li>Propostas recebidas por link exclusivo de cada fornecedor, com confirmação do CNPJ, ou lançadas pela equipe com a referência do documento de origem. Vale a última versão recebida dentro do prazo; as anteriores ficam no histórico.</li>
            <li>Total do item = quantidade × preço unitário, {s.arredondamento === "truncar" ? "truncado" : "arredondado"} em 2 casas. A diferença percentual compara o preço unitário com o de referência; até {LIMITES_PADRAO.tolerancia}% conta como igual.</li>
            <li>
              {s.criterio === "item" ? "Critério: menor preço unitário válido em cada item."
                : s.criterio === "global" ? "Critério: menor total entre as propostas que cotaram todos os itens."
                : `Critério: nota de 0 a 100 por fator, ponderada pelos pesos fixados no envio (${FATORES.filter((k) => s.pesos[k] > 0).map((k) => `${ROTULO_FATOR[k].toLowerCase()} ${s.pesos[k]}`).join(", ")}), entre as propostas que cotaram todos os itens. A marca não pontua.`}
              {" "}Desempate: menor prazo de entrega; persistindo, a proposta enviada primeiro.
            </li>
            <li>Média e mediana usam só os preços informados de cada item; item indisponível ou sem valor não entra na conta. O total de cada uma é a soma de quantidade × valor do item.</li>
            {foraDaComparacao.length > 0 && <li>A equipe escolheu {s.comparadas.length} das {s.propostas.length} propostas recebidas para a comparação. As demais continuam registradas e não entram no mapa, na média, na mediana nem na apuração.</li>}
            <li>A economia considera apenas os itens com preço de referência. O resultado da cotação não altera o orçamento.</li>
            {ap && <li>Código de conferência da apuração: <span className="num">{ap.codigo.slice(0, 32).toUpperCase()}</span>.</li>}
          </ul>
        </Secao>

        <footer className="rel-assinaturas">
          <div><span className="rel-linha-assinatura" /><b>{s.criadoPor ?? "Responsável"}</b><span>Responsável pela cotação</span></div>
          <div><span className="rel-linha-assinatura" /><b>{ap?.homologadaPor ?? "Autoridade competente"}</b><span>Homologação</span></div>
        </footer>
        <RodapeRelatorio texto={`Cotação nº ${numero} · ${s.obraCodigo} · emitido em ${dataLonga(new Date())} às ${dataHora(new Date()).slice(-5)} por ${usuario.nome}`} />
      </article>
    </div>
  );
}
