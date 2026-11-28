import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ban, CircleAlert, FileSpreadsheet, FileText, Plus, Save, Stamp, Trash2, Undo2, BadgeCheck } from "lucide-react";
import { EtiquetaMedicao, EtiquetaPagamento } from "@/componentes/Etiquetas";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { Galeria } from "@/componentes/Fotos";
import { ErroDeRegra } from "@/lib/db";
import { dataCurta, dataHora, moeda, paraCampo, percentual, quantidade, unidadeMedida, resumir } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { rotuloContrato } from "@/servicos/contratos";
import {
  obterMedicao, ROTULO_RETENCAO, ROTULO_TRAMITE, rotuloMedicao, SUGESTAO_RETENCAO, valorRetencaoSugerido, type TipoRetencao,
} from "@/servicos/medicoes";
import { evidenciasDoPeriodo } from "@/servicos/campo";
import { pode } from "@/servicos/permissoes";
import {
  acaoAprovar, acaoAtestar, acaoBoletim, acaoCancelar, acaoDevolver, acaoGlosa, acaoNotaFiscal, acaoPagamento, acaoRemoverGlosa,
  acaoRemoverRetencao, acaoRetencao,
} from "../acoes";

export const metadata: Metadata = { title: "Medição" };

export default async function FichaMedicao({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ator = comoAtor(await exigirUsuario());
  let m;
  try {
    m = await obterMedicao(ator, id);
  } catch (e) {
    if (e instanceof ErroDeRegra) notFound();
    throw e;
  }
  const ev = await evidenciasDoPeriodo(ator, m.obraId, m.periodoInicio, m.periodoFim).catch(() => null);
  const rascunho = m.situacao === "rascunho";
  const aberta = rascunho || m.situacao === "atestada";
  const aprovada = m.situacao === "aprovada";
  const editar = rascunho && pode(ator, "medicao.elaborar");
  const ajustar = aberta && pode(ator, "medicao.ajustar");
  const direta = m.regime === "direta";
  const pagar = aprovada && !direta && pode(ator, "pagamento.registrar");
  const podeDevolver = m.situacao === "atestada" && (pode(ator, "medicao.atestar") || pode(ator, "medicao.aprovar"));
  const podeCancelar = aberta && (pode(ator, "medicao.elaborar") || pode(ator, "medicao.aprovar"));
  const n = Number;
  const desvio = m.previstoPeriodo != null ? n(m.bruto) - m.previstoPeriodo : null;
  const baseNota = n(m.valorNota);
  const reajustado = n(m.reajuste) !== 0;
  const medidos = m.linhas.filter((l) => n(l.nesta) !== 0);

  return (
    <>
      <div className="cabecalho">
        <div style={{ minWidth: 0 }}>
          <div className="sobretitulo">
            <Link href="/medicoes">Medições</Link><span>/</span>
            <Link href={`/obras/${m.obraId}/medicoes`} className="num">{m.obraCodigo}</Link><span>/</span>
            <Link href={`/contratos/${m.contratoId}`}>{rotuloContrato({ numero: m.contratoNumero, regime: m.regime })}</Link>
          </div>
          <h1 className="titulo">{rotuloMedicao(m)}</h1>
          <p className="subtitulo" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <EtiquetaMedicao situacao={m.situacao} />
            {m.situacaoPagamento && <EtiquetaPagamento situacao={m.situacaoPagamento} />}
            <span className="num">{dataCurta(m.periodoInicio)} a {dataCurta(m.periodoFim)}</span>
            <span>· {m.empresaNome ?? "Equipe própria"}</span>
          </p>
        </div>
        <div className="barra-acoes">
          <Link href={`/medicoes/${id}/boletim`} className="botao botao-neutro"><FileText /> Boletim</Link>
          <a href={`/medicoes/${id}/excel`} className="botao botao-neutro"><FileSpreadsheet /> Planilha Excel</a>
        </div>
      </div>

      <div className="indicadores">
        <div className="indicador surgir" style={{ "--i": 0 } as React.CSSProperties}><span>Valor medido</span><b className="num">{moeda(m.bruto)}</b>
          <small className="num">{medidos.length} {medidos.length === 1 ? "item" : "itens"}{reajustado ? ` · reajuste de ${percentual(m.reajustePctAplicado, 2)}: ${moeda(m.reajuste)}` : ""}</small></div>
        <div className="indicador surgir" style={{ "--i": 1 } as React.CSSProperties}><span>Glosas e retenções</span><b className="num">{moeda(n(m.glosa) + n(m.retencao))}</b>
          <small className="num">Glosas {moeda(m.glosa)} · retenções {moeda(m.retencao)}</small></div>
        <div className="indicador indicador-destaque surgir" style={{ "--i": 2 } as React.CSSProperties}><span>{direta ? "Valor apropriado" : "Líquido a pagar"}</span><b className="num">{moeda(m.liquido)}</b>
          {aprovada && !direta && <small className="num">Pago {moeda(m.pago)} · falta {moeda(m.aPagar)}</small>}</div>
        <div className="indicador surgir" style={{ "--i": 3 } as React.CSSProperties}><span>Previsto no período</span>
          <b className="num">{m.previstoPeriodo != null ? moeda(m.previstoPeriodo) : "—"}</b>
          {desvio != null && <small className="num">{desvio >= 0 ? "Acima" : "Abaixo"} do previsto em {moeda(Math.abs(desvio))}</small>}
          {m.previstoPeriodo == null && <small>Sem linha de base no cronograma</small>}</div>
      </div>

      <div className="grade">
        {m.pendencias.length > 0 && <div className="aviso aviso-info surgir"><CircleAlert /><span>Para atestar: {m.pendencias.join(" ")}</span></div>}
        {m.ajuste && m.observacao && <div className="aviso aviso-info surgir"><CircleAlert /><span>Medição de ajuste: {m.observacao}</span></div>}

        <section className="surgir" style={{ minWidth: 0 }}>
            <FormAcao acao={acaoBoletim.bind(null, id)}>
              <div className="barra-acoes" style={{ marginBottom: 10 }}>
                <h2 className="cartao-titulo">Boletim de medição</h2>
                <span className="cartao-sub" style={{ marginLeft: "auto" }}>
                  Acumulado no contrato {moeda(m.acumuladoContrato)} · {percentual(m.acumuladoPct, 1)}
                </span>
              </div>
              {editar && (
                <div className="form-linha" style={{ marginBottom: 12 }}>
                  <div className="campo"><label htmlFor="periodoInicio">Início do período</label><input id="periodoInicio" name="periodoInicio" type="date" className="entrada-texto" required defaultValue={m.periodoInicio} /></div>
                  <div className="campo"><label htmlFor="periodoFim">Fim do período</label><input id="periodoFim" name="periodoFim" type="date" className="entrada-texto" required defaultValue={m.periodoFim} /></div>
                  <div className="campo" style={{ flex: 1, minWidth: 200 }}><label htmlFor="observacao">{m.ajuste ? "Motivo do ajuste" : "Observação"}</label>
                    <input id="observacao" name="observacao" className="entrada-texto" defaultValue={m.observacao ?? ""} required={m.ajuste} /></div>
                </div>
              )}
              <div className="tabela-caixa">
                <table className="tabela tabela-compacta tabela-boletim">
                  <thead>
                    <tr>
                      <th>Item</th><th>Descrição</th><th>Und.</th><th className="dir">Contratado</th><th className="dir">Anterior</th>
                      <th className="dir">Nesta medição</th><th className="dir">Acumulado</th><th className="dir">Saldo</th><th className="dir">Valor</th><th>Memória de cálculo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.etapas.map((e) => (
                      <Etapa key={e.nome} nome={e.nome} valor={e.valorNesta}>
                        {e.linhas.map((l) => {
                          const tem = n(l.nesta) !== 0;
                          if (!editar && !tem && !aprovada) return null;
                          return (
                            <tr key={l.itemServicoId} className={tem ? "" : "linha-apagada"}>
                              <td className="num">{l.numero}</td>
                              <td><span className="boletim-descricao" title={l.descricao}>{l.descricao}</span>{!l.medivel && <><br /><span className="fraco">Equipe própria</span></>}
                                {l.travadaPor && <><br /><Link href={`/nao-conformidades/${l.travadaPor.id}`} className="etiqueta et-vermelha etiqueta-mini">NC {String(l.travadaPor.numero).padStart(3, "0")} impeditiva</Link></>}</td>
                              <td>{unidadeMedida(l.unidade)}</td>
                              <td className="dir num">{quantidade(l.contratado)}</td>
                              <td className="dir num">{quantidade(l.anterior)}</td>
                              <td className="dir num">
                                {editar && l.medivel && !l.travadaPor ? (
                                  <>
                                    <input type="hidden" name="item" value={l.itemServicoId} />
                                    <input name={`q_${l.itemServicoId}`} className="entrada-texto entrada-qtd num" inputMode="decimal" defaultValue={tem ? paraCampo(l.nesta) : ""}
                                      aria-label={`Quantidade do item ${l.numero} nesta medição`} />
                                  </>
                                ) : <b>{tem ? quantidade(l.nesta) : "—"}</b>}
                              </td>
                              <td className="dir num">{quantidade(l.acumulado)}<br /><span className="fraco">{percentual(l.pctAcumulado, 1)}</span></td>
                              <td className="dir num">{quantidade(l.saldo)}</td>
                              <td className="dir num forte">{tem ? moeda(l.valorNesta) : "—"}</td>
                              <td>
                                {editar && l.medivel ? (
                                  <input name={`m_${l.itemServicoId}`} className="entrada-texto entrada-memoria" defaultValue={l.memoria ?? ""} placeholder="Ex.: 4,00 x 2,50 m"
                                    aria-label={`Memória de cálculo do item ${l.numero}`} />
                                ) : <span className="fraco">{l.memoria ?? ""}</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </Etapa>
                    ))}
                    <tr className="linha-total"><td colSpan={8}>Valor medido</td><td className="dir num">{moeda(m.bruto)}</td><td /></tr>
                  </tbody>
                </table>
              </div>
              {editar && <div className="rodape-form" style={{ marginTop: 12 }}><BotaoEnviar enviando="Salvando…"><Save /> Salvar boletim</BotaoEnviar></div>}
            </FormAcao>
        </section>

        {ev && (ev.diarios.length > 0 || ev.fotos.length > 0) && (
          <section className="cartao surgir">
            <div className="barra-acoes">
              <h2 className="cartao-titulo">Diário de obra no período</h2>
              <Link href={`/obras/${m.obraId}/diario/relatorio?de=${m.periodoInicio}&ate=${m.periodoFim}`} className="botao botao-neutro botao-pequeno" style={{ marginLeft: "auto" }}><FileText /> Relatório do período</Link>
            </div>
            <p className="cartao-sub" style={{ marginTop: 6 }}>
              {ev.diarios.length} {ev.diarios.length === 1 ? "diário" : "diários"} · {ev.diarios.filter((d) => d.situacao === "assinado").length} assinados · {ev.diarios.reduce((s, d) => s + d.fotos, 0)} fotos
              {ev.diarios.some((d) => d.horasParadas > 0) && ` · ${ev.diarios.reduce((s, d) => s + d.horasParadas, 0).toLocaleString("pt-BR")} h paradas`}
            </p>
            <div className="form-linha" style={{ marginTop: 8 }}>
              {ev.diarios.map((d) => <Link key={d.id} href={`/diario/${d.id}`} className={`etiqueta ${d.situacao === "assinado" ? "et-verde" : "et-laranja"} num`}>{dataCurta(d.data).slice(0, 5)}</Link>)}
            </div>
            <Galeria fotos={ev.fotos} />
          </section>
        )}

        <div className="medicao-cartoes">
            <section className="cartao surgir">
              <h2 className="cartao-titulo">Tramitação</h2>
              <dl className="dados" style={{ marginTop: 12 }}>
                <div><dt>Fiscal</dt><dd>{m.fiscalNome ?? "A designar"}</dd></div>
                <div><dt>Gestor</dt><dd>{m.gestorNome ?? "A designar"}</dd></div>
              </dl>
              {m.podeAtestar && (
                <FormAcao acao={acaoAtestar.bind(null, id)} className="grade" style={{ marginTop: 14 }} confirmar="Atestar a medição? O boletim fica fechado para edição." mostrarOk={false}>
                  <input name="observacao" className="entrada-texto" placeholder="Observação do fiscal" aria-label="Observação do fiscal" />
                  <BotaoEnviar enviando="Atestando…"><BadgeCheck /> Atestar medição</BotaoEnviar>
                </FormAcao>
              )}
              {m.podeAprovar && (
                <FormAcao acao={acaoAprovar.bind(null, id)} className="grade" style={{ marginTop: 14 }} confirmar="Aprovar a medição? Depois de aprovada, ela não muda mais." mostrarOk={false}>
                  <input name="observacao" className="entrada-texto" placeholder="Observação do gestor" aria-label="Observação do gestor" />
                  <BotaoEnviar enviando="Aprovando…"><Stamp /> Aprovar medição</BotaoEnviar>
                </FormAcao>
              )}
              {podeDevolver && (
                <FormAcao acao={acaoDevolver.bind(null, id)} className="form-linha" style={{ marginTop: 10 }} mostrarOk={false}>
                  <input name="motivo" className="entrada-texto" placeholder="Motivo da devolução" aria-label="Motivo da devolução" required style={{ flex: 1, minWidth: 140 }} />
                  <BotaoEnviar className="botao botao-neutro" enviando="…"><Undo2 /> Devolver</BotaoEnviar>
                </FormAcao>
              )}
              <ol className="tramite">
                {m.tramites.map((t, i) => (
                  <li key={i}>
                    <b>{ROTULO_TRAMITE[t.acao] ?? t.acao}</b>
                    <span className="cartao-sub num">{dataHora(new Date(t.em))}{t.por ? ` · ${t.por}` : ""}</span>
                    {t.observacao && <span>{t.observacao}</span>}
                  </li>
                ))}
              </ol>
              {podeCancelar && (
                <details className="detalhe-acao">
                  <summary>Cancelar medição</summary>
                  <FormAcao acao={acaoCancelar.bind(null, id)} className="form-linha" style={{ marginTop: 8 }} confirmar="Cancelar esta medição? O número fica registrado como cancelado." mostrarOk={false}>
                    <input name="motivo" className="entrada-texto" placeholder="Motivo" aria-label="Motivo do cancelamento" required style={{ flex: 1, minWidth: 140 }} />
                    <BotaoEnviar className="botao botao-texto" enviando="…"><Ban /> Cancelar</BotaoEnviar>
                  </FormAcao>
                </details>
              )}
            </section>

          <section className="cartao surgir">
            <h2 className="cartao-titulo">Glosas</h2>
            {m.glosas.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhuma glosa.</p> : (
              <table className="tabela tabela-compacta" style={{ marginTop: 10 }}>
                <tbody>
                  {m.glosas.map((g) => (
                    <tr key={g.id}>
                      <td>{g.motivo}{g.itemNumero && <span className="fraco"> · item {g.itemNumero}</span>}<br /><span className="fraco">{g.por}</span></td>
                      <td className="dir num forte">{moeda(g.valor)}</td>
                      {ajustar && <td className="dir"><FormAcao acao={acaoRemoverGlosa.bind(null, id, g.id)} mostrarOk={false} confirmar="Remover esta glosa?">
                        <BotaoEnviar className="botao botao-texto botao-pequeno" ariaLabel="Remover glosa"><Trash2 /></BotaoEnviar></FormAcao></td>}
                    </tr>
                  ))}
                  <tr className="linha-total"><td>Total</td><td className="dir num">{moeda(m.glosa)}</td>{ajustar && <td />}</tr>
                </tbody>
              </table>
            )}
            {ajustar && (
              <FormAcao acao={acaoGlosa.bind(null, id)} className="grade-form" style={{ marginTop: 14 }} limpar>
                <div className="campo c8"><label htmlFor="g-motivo">Motivo</label><input id="g-motivo" name="motivo" className="entrada-texto" required /></div>
                <div className="campo c4"><label htmlFor="g-valor">Valor (R$)</label><input id="g-valor" name="valor" className="entrada-texto num" inputMode="decimal" required /></div>
                <div className="campo c8"><label htmlFor="g-item">Item</label>
                  <select id="g-item" name="itemServicoId" className="entrada-texto" defaultValue="">
                    <option value="">Medição inteira</option>
                    {medidos.map((l) => <option key={l.itemServicoId} value={l.itemServicoId}>{l.numero} · {resumir(l.descricao, 60)}</option>)}
                  </select>
                </div>
                <div className="c4 rodape-form"><BotaoEnviar className="botao botao-neutro" enviando="…"><Plus /> Glosar</BotaoEnviar></div>
              </FormAcao>
            )}
          </section>

          {!direta && (
            <section className="cartao surgir">
              <h2 className="cartao-titulo">Retenções</h2>
              {m.retencoes.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhuma retenção.</p> : (
                <table className="tabela tabela-compacta" style={{ marginTop: 10 }}>
                  <thead><tr><th>Tipo</th><th className="dir">Base</th><th className="dir">Alíquota</th><th className="dir">Valor</th>{ajustar && <th />}</tr></thead>
                  <tbody>
                    {m.retencoes.map((r) => (
                      <tr key={r.id}>
                        <td>{ROTULO_RETENCAO[r.tipo]}{r.descricao && <span className="fraco"> · {r.descricao}</span>}</td>
                        <td className="dir num">{moeda(r.base)}</td><td className="dir num">{percentual(r.aliquota)}</td><td className="dir num forte">{moeda(r.valor)}</td>
                        {ajustar && <td className="dir"><FormAcao acao={acaoRemoverRetencao.bind(null, id, r.id)} mostrarOk={false} confirmar="Remover esta retenção?">
                          <BotaoEnviar className="botao botao-texto botao-pequeno" ariaLabel="Remover retenção"><Trash2 /></BotaoEnviar></FormAcao></td>}
                      </tr>
                    ))}
                    <tr className="linha-total"><td colSpan={3}>Total</td><td className="dir num">{moeda(m.retencao)}</td>{ajustar && <td />}</tr>
                  </tbody>
                </table>
              )}
              {ajustar && n(m.bruto) > 0 && (
                <FormAcao acao={acaoRetencao.bind(null, id)} className="grade-form" style={{ marginTop: 14 }} limpar>
                  <div className="campo c4"><label htmlFor="r-tipo">Tipo</label>
                    <select id="r-tipo" name="tipo" className="entrada-texto" defaultValue="iss">
                      {(Object.keys(ROTULO_RETENCAO) as TipoRetencao[]).map((x) => (
                        <option key={x} value={x}>{ROTULO_RETENCAO[x]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="campo c4"><label htmlFor="r-base">Base (R$)</label><input id="r-base" name="base" className="entrada-texto num" inputMode="decimal" required defaultValue={paraCampo(valorRetencaoSugerido(String(n(m.bruto) + n(m.reajuste)), "iss"))} /></div>
                  <div className="campo c4"><label htmlFor="r-aliquota">Alíquota (%)</label><input id="r-aliquota" name="aliquota" className="entrada-texto num" inputMode="decimal" required defaultValue="5" /></div>
                  <div className="campo c8"><label htmlFor="r-descricao">Descrição</label><input id="r-descricao" name="descricao" className="entrada-texto" placeholder="Obrigatória para o tipo Outra" /></div>
                  <p className="c12 cartao-sub">Referência: {(Object.keys(SUGESTAO_RETENCAO) as TipoRetencao[]).filter((x) => x !== "outra").map((x) => `${ROTULO_RETENCAO[x]} ${SUGESTAO_RETENCAO[x].aliquota.toLocaleString("pt-BR")}% sobre ${SUGESTAO_RETENCAO[x].basePct}% do valor`).join(" · ")}. Confira a legislação do contrato.</p>
                  <div className="c4 rodape-form"><BotaoEnviar className="botao botao-neutro" enviando="…"><Plus /> Reter</BotaoEnviar></div>
                </FormAcao>
              )}
            </section>
          )}
        </div>

        {aprovada && !direta && (
          <section className="cartao surgir">
            <h2 className="cartao-titulo">Nota fiscal e pagamentos</h2>
            <div className="grade" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginTop: 12 }}>
              <div>
                <h3 className="cartao-sub forte">Notas fiscais</h3>
                {m.notas.length === 0 ? <p className="cartao-sub">Nenhuma nota fiscal.</p> : (
                  <ul className="lista-simples">{m.notas.map((x) => <li key={x.id} className="num">NF {x.numero} · {dataCurta(x.data)} · {moeda(x.valor)}</li>)}</ul>
                )}
                {pagar && m.notas.length === 0 && (
                  <FormAcao acao={acaoNotaFiscal.bind(null, id)} className="grade-form" style={{ marginTop: 12 }} limpar confirmar="Registrar a nota fiscal? Confira número, data e valor antes de continuar.">
                    <div className="campo c4"><label htmlFor="nf-numero">Número</label><input id="nf-numero" name="numero" className="entrada-texto" required /></div>
                    <div className="campo c4"><label htmlFor="nf-data">Data</label><input id="nf-data" name="data" type="date" className="entrada-texto" required defaultValue={m.hoje} /></div>
                    <div className="campo c4"><label htmlFor="nf-valor">Valor (R$)</label><input id="nf-valor" name="valor" className="entrada-texto num" inputMode="decimal" required defaultValue={paraCampo(String(baseNota.toFixed(2)))} /></div>
                    <div className="c12 rodape-form"><BotaoEnviar className="botao botao-neutro" enviando="…"><Plus /> Registrar nota fiscal</BotaoEnviar></div>
                  </FormAcao>
                )}
              </div>
              <div>
                <h3 className="cartao-sub forte">Pagamentos</h3>
                {m.pagamentos.length === 0 ? <p className="cartao-sub">Nenhum pagamento.</p> : (
                  <table className="tabela tabela-compacta">
                    <thead><tr><th>Data</th><th>Empenho</th><th>Ordem bancária</th><th className="dir">Valor</th></tr></thead>
                    <tbody>
                      {m.pagamentos.map((p) => <tr key={p.id}><td className="num">{dataCurta(p.data)}</td><td>{p.empenho}</td><td>{p.ordemBancaria ?? "—"}</td><td className="dir num forte">{moeda(p.valor)}</td></tr>)}
                      <tr className="linha-total"><td colSpan={3}>Pago</td><td className="dir num">{moeda(m.pago)}</td></tr>
                    </tbody>
                  </table>
                )}
                {pagar && m.notas.length > 0 && n(m.aPagar) > 0 && (
                  <FormAcao acao={acaoPagamento.bind(null, id)} className="grade-form" style={{ marginTop: 12 }} limpar confirmar="Registrar o pagamento? Confira data e valor antes de continuar.">
                    <div className="campo c4"><label htmlFor="p-data">Data</label><input id="p-data" name="data" type="date" className="entrada-texto" required defaultValue={m.hoje} max={m.hoje} /></div>
                    <div className="campo c4"><label htmlFor="p-valor">Valor (R$)</label><input id="p-valor" name="valor" className="entrada-texto num" inputMode="decimal" required defaultValue={paraCampo(m.aPagar)} /></div>
                    <div className="campo c4"><label htmlFor="p-empenho">Empenho</label><input id="p-empenho" name="empenho" className="entrada-texto" required /></div>
                    <div className="campo c6"><label htmlFor="p-liquidacao">Liquidação</label><input id="p-liquidacao" name="liquidacao" className="entrada-texto" /></div>
                    <div className="campo c6"><label htmlFor="p-ob">Ordem bancária</label><input id="p-ob" name="ordemBancaria" className="entrada-texto" /></div>
                    <div className="c12 rodape-form"><BotaoEnviar className="botao botao-primario" enviando="Registrando…"><Plus /> Registrar pagamento</BotaoEnviar></div>
                  </FormAcao>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function Etapa({ nome, valor, children }: { nome: string; valor: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="linha-grupo"><td colSpan={8}>{nome}</td><td className="dir num">{Number(valor) ? moeda(valor) : ""}</td><td /></tr>
      {children}
    </>
  );
}
