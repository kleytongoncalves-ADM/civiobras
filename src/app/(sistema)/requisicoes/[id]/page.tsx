import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, Check, Plus, Send, ShoppingCart, Trash2, X } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { ErroDeRegra } from "@/lib/db";
import { dataCurta, dataHora, moeda, quantidade, unidadeMedida, resumir } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { SemPermissao } from "@/servicos/permissoes";
import { obterRequisicao } from "@/servicos/suprimentos";
import { acaoCotacao, acaoEmitirPedido, acaoItemRequisicao, acaoRemoverItemRequisicao, acaoTramiteRequisicao } from "../../suprimentos/acoes";
import { EtiquetaPedido, EtiquetaRequisicao } from "../../suprimentos/Componentes";

export const metadata: Metadata = { title: "Requisição de material" };

export default async function PaginaRequisicao({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = comoAtor(await exigirUsuario());
  let r;
  try {
    r = await obterRequisicao(a, id);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) notFound();
    throw e;
  }
  const tramite = acaoTramiteRequisicao.bind(null, id, r.obraId);
  const total = r.itens.reduce((s, i) => s + (i.referencia ?? 0) * i.quantidade, 0);
  const pendentes = r.itens.filter((i) => !i.pedidoId);

  return (
    <>
      <div className="cabecalho">
        <div style={{ minWidth: 0 }}>
          <div className="sobretitulo"><Link href={`/obras/${r.obraId}/suprimentos`}>{r.obra.codigo}</Link><span>/</span><span>Suprimentos</span></div>
          <h1 className="titulo">Requisição nº {r.numero}</h1>
          <p className="subtitulo" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <EtiquetaRequisicao situacao={r.situacao} />
            <span>Necessário em {dataCurta(r.necessidade)}</span><span>· {r.obra.nome}</span>
          </p>
        </div>
        <Link href={`/obras/${r.obraId}/suprimentos`} className="botao botao-neutro"><ArrowLeft /> Suprimentos da obra</Link>
      </div>

      <div className="grade">
        <section className="cartao">
          <h2 className="cartao-titulo">Materiais</h2>
          {r.itens.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhum material incluído.</p> : (
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Material</th><th className="dir">Quantidade</th><th className="dir">Previsto na obra</th><th className="dir">Requisitado na obra</th><th>Item de serviço</th><th className="dir">Preço de referência</th><th>Pedido</th>{r.podeEditar && <th />}</tr></thead>
              <tbody>{r.itens.map((i) => {
                const acima = i.requisitadoTotal > i.previsto;
                return (
                  <tr key={i.id}>
                    <td style={{ minWidth: 200 }}><b>{i.descricao}</b><div className="fraco">{[i.codigo, unidadeMedida(i.unidade)].filter(Boolean).join(" · ")}</div>
                      {i.justificativa && <div className="fraco">Justificativa: {i.justificativa}</div>}</td>
                    <td className="dir num forte">{quantidade(i.quantidade)}</td>
                    <td className="dir num">{i.previsto ? quantidade(i.previsto) : "—"}</td>
                    <td className="dir num">{quantidade(i.requisitadoTotal)}{acima && <div><span className="etiqueta et-laranja etiqueta-mini">Acima do previsto</span></div>}</td>
                    <td className="fraco">{i.itemServico ?? "—"}</td>
                    <td className="dir num">{i.referencia != null ? moeda(i.referencia) : "—"}</td>
                    <td>{i.pedidoId ? <Link href={`/pedidos/${i.pedidoId}`} className="num">nº {i.pedidoNumero}</Link> : "—"}</td>
                    {r.podeEditar && <td className="dir">
                      <FormAcao acao={acaoRemoverItemRequisicao.bind(null, id, i.id)} mostrarOk={false}>
                        <BotaoEnviar className="botao botao-texto botao-pequeno" ariaLabel="Remover"><Trash2 /></BotaoEnviar>
                      </FormAcao></td>}
                  </tr>
                );
              })}
                {total > 0 && <tr className="linha-total"><td>Estimativa pelo orçamento</td><td colSpan={4} /><td className="dir num">{moeda(total)}</td><td colSpan={r.podeEditar ? 2 : 1} /></tr>}
              </tbody>
            </table></div>
          )}
          {r.podeEditar && (
            <FormAcao acao={acaoItemRequisicao.bind(null, id)} className="grade-form" style={{ marginTop: 14 }} limpar mostrarOk={false}>
              <div className="campo c5"><label htmlFor="ri-m">Material</label>
                <select id="ri-m" name="materialId" className="entrada-texto" required defaultValue="">
                  <option value="" disabled>Escolha</option>
                  {r.materiais.map((m) => <option key={m.id} value={m.id}>{resumir(m.descricao, 70)} ({unidadeMedida(m.unidade)})</option>)}
                </select></div>
              <div className="campo c2"><label htmlFor="ri-q">Quantidade</label><input id="ri-q" name="quantidade" inputMode="decimal" className="entrada-texto num" required /></div>
              <div className="campo c5"><label htmlFor="ri-i">Item de serviço</label>
                <select id="ri-i" name="itemServicoId" className="entrada-texto" defaultValue="">
                  <option value="">—</option>
                  {r.itensObra.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 60)}</option>)}
                </select></div>
              <div className="campo c9"><label htmlFor="ri-j">Justificativa (acima do previsto)</label><input id="ri-j" name="justificativa" className="entrada-texto" /></div>
              <div className="c3 rodape-form" style={{ alignSelf: "end" }}><BotaoEnviar className="botao botao-neutro" enviando="Incluindo…"><Plus /> Incluir</BotaoEnviar></div>
            </FormAcao>
          )}
        </section>

        {(r.podeEditar || r.podeDecidir || r.podeCancelar) && (
          <section className="cartao">
            <h2 className="cartao-titulo">Trâmite</h2>
            <div className="form-linha" style={{ marginTop: 10, alignItems: "flex-start" }}>
              {r.podeEditar && (
                <FormAcao acao={tramite}><input type="hidden" name="passo" value="enviar" />
                  <BotaoEnviar enviando="Enviando…"><Send /> Enviar para aprovação</BotaoEnviar></FormAcao>
              )}
              {r.podeDecidir && <>
                <FormAcao acao={tramite}><input type="hidden" name="passo" value="aprovar" />
                  <BotaoEnviar enviando="Aprovando…"><Check /> Aprovar</BotaoEnviar></FormAcao>
                <FormAcao acao={tramite} className="form-linha"><input type="hidden" name="passo" value="recusar" />
                  <input name="motivo" className="entrada-texto" placeholder="Motivo da recusa" aria-label="Motivo da recusa" required style={{ minWidth: 200 }} />
                  <BotaoEnviar className="botao botao-neutro" enviando="Recusando…"><X /> Recusar</BotaoEnviar></FormAcao>
              </>}
              {r.podeCancelar && (
                <FormAcao acao={tramite} className="form-linha" confirmar="Cancelar esta requisição?"><input type="hidden" name="passo" value="cancelar" />
                  <input name="motivo" className="entrada-texto" placeholder="Motivo do cancelamento" aria-label="Motivo do cancelamento" required style={{ minWidth: 200 }} />
                  <BotaoEnviar className="botao botao-neutro" enviando="Cancelando…"><Ban /> Cancelar</BotaoEnviar></FormAcao>
              )}
            </div>
          </section>
        )}

        {(r.situacao === "aprovada" || r.cotacoes.length > 0) && (
          <section className="cartao">
            <h2 className="cartao-titulo">Mapa de cotações</h2>
            {r.cotacoes.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhuma cotação registrada.</p> : (
              <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta mapa-cotacao">
                <thead>
                  <tr><th>Material</th><th className="dir">Qtd.</th><th className="dir">Referência</th>
                    {r.cotacoes.map((c) => <th key={c.id} className="dir">{c.fornecedor}{c.vencida && <div><span className="etiqueta et-vermelha etiqueta-mini">Vencida</span></div>}</th>)}</tr>
                </thead>
                <tbody>
                  {r.itens.map((i) => (
                    <tr key={i.id}>
                      <td>{resumir(i.descricao, 60)}<div className="fraco">{unidadeMedida(i.unidade)}</div></td>
                      <td className="dir num">{quantidade(i.quantidade)}</td>
                      <td className="dir num fraco">{i.referencia != null ? moeda(i.referencia) : "—"}</td>
                      {r.cotacoes.map((c) => {
                        const pr = c.precos[i.id];
                        const menor = pr != null && r.menor[i.id] === pr && !c.vencida;
                        const caro = pr != null && i.referencia != null && pr > i.referencia;
                        return <td key={c.id} className={`dir num${menor ? " celula-menor" : ""}`}>{pr != null ? <>{moeda(pr)}<div className="fraco">{moeda(pr * i.quantidade)}</div>{caro && <span className="etiqueta et-laranja etiqueta-mini">Acima da referência</span>}</> : "—"}</td>;
                      })}
                    </tr>
                  ))}
                  <tr><td>Frete</td><td /><td />{r.cotacoes.map((c) => <td key={c.id} className="dir num">{moeda(c.frete)}</td>)}</tr>
                  <tr className="linha-total"><td>Total cotado</td><td /><td />{r.cotacoes.map((c) => <td key={c.id} className="dir num">{moeda(c.total)}<div className="fraco">{c.itensCotados} de {r.itens.length} itens</div></td>)}</tr>
                  <tr><td>Prazo de entrega</td><td /><td />{r.cotacoes.map((c) => <td key={c.id} className="dir">{c.prazoEntrega != null ? `${c.prazoEntrega} dias` : "—"}</td>)}</tr>
                  <tr><td>Pagamento e validade</td><td /><td />{r.cotacoes.map((c) => <td key={c.id} className="dir fraco">{c.condicaoPagamento ?? "—"}{c.validade ? ` · até ${dataCurta(c.validade)}` : ""}</td>)}</tr>
                </tbody>
              </table></div>
            )}

            {r.podeCotar && pendentes.length > 0 && r.cotacoes.filter((c) => !c.vencida).length > 0 && (
              <div className="pedidos-cotacao">
                {r.cotacoes.filter((c) => !c.vencida).map((c) => {
                  const cotados = pendentes.filter((i) => c.precos[i.id] != null);
                  if (!cotados.length) return null;
                  return (
                    <FormAcao key={c.id} acao={acaoEmitirPedido.bind(null, id, c.id, r.obraId)} className="cartao-interno">
                      <b>{c.fornecedor}</b>
                      <div className="opcoes-epi" style={{ marginTop: 8 }}>
                        {cotados.map((i) => (
                          <label key={i.id} className="opcao-check"><input type="checkbox" name="item" value={i.id} defaultChecked={r.menor[i.id] === c.precos[i.id]} /> {resumir(i.descricao, 40)}</label>
                        ))}
                      </div>
                      <div className="form-linha" style={{ marginTop: 8 }}>
                        <input name="justificativa" className="entrada-texto" style={{ flex: 1, minWidth: 180 }} placeholder="Justificativa (se não for o menor preço)" aria-label="Justificativa" />
                        <BotaoEnviar className="botao botao-neutro" enviando="Emitindo…"><ShoppingCart /> Emitir pedido</BotaoEnviar>
                      </div>
                    </FormAcao>
                  );
                })}
              </div>
            )}

            {r.podeCotar && (
              <details className="detalhe-acao">
                <summary>Registrar cotação</summary>
                <FormAcao acao={acaoCotacao.bind(null, id)} className="grade-form" style={{ marginTop: 10 }} limpar>
                  <div className="campo c6"><label htmlFor="ct-f">Fornecedor</label>
                    <select id="ct-f" name="empresaId" className="entrada-texto" required defaultValue="">
                      <option value="" disabled>Escolha</option>
                      {r.fornecedores.map((f) => <option key={f.id} value={f.id}>{f.razaoSocial}</option>)}
                    </select></div>
                  <div className="campo c2"><label htmlFor="ct-p">Prazo (dias)</label><input id="ct-p" name="prazoEntrega" type="number" min={0} max={365} className="entrada-texto num" /></div>
                  <div className="campo c2"><label htmlFor="ct-v">Validade</label><input id="ct-v" name="validade" type="date" className="entrada-texto" /></div>
                  <div className="campo c2"><label htmlFor="ct-fr">Frete</label><input id="ct-fr" name="frete" inputMode="decimal" className="entrada-texto num" /></div>
                  <div className="campo c6"><label htmlFor="ct-c">Condição de pagamento</label><input id="ct-c" name="condicaoPagamento" className="entrada-texto" placeholder="30 dias após a entrega" /></div>
                  <div className="campo c6"><label htmlFor="ct-o">Observação</label><input id="ct-o" name="observacao" className="entrada-texto" /></div>
                  <div className="c12 lista-precos">
                    {r.itens.map((i) => (
                      <div key={i.id} className="campo">
                        <label htmlFor={`pc-${i.id}`}>{resumir(i.descricao, 50)} <span className="fraco">({quantidade(i.quantidade)} {unidadeMedida(i.unidade)})</span></label>
                        <input id={`pc-${i.id}`} name={`preco_${i.id}`} inputMode="decimal" className="entrada-texto num" placeholder="Preço unitário" />
                      </div>
                    ))}
                  </div>
                  <div className="c12 rodape-form"><BotaoEnviar enviando="Registrando…"><Plus /> Registrar cotação</BotaoEnviar></div>
                </FormAcao>
              </details>
            )}
          </section>
        )}

        {r.pedidos.length > 0 && (
          <section className="cartao">
            <h2 className="cartao-titulo">Pedidos</h2>
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Nº</th><th>Fornecedor</th><th>Entrega</th><th className="dir">Total</th><th>Situação</th></tr></thead>
              <tbody>{r.pedidos.map((x) => (
                <tr key={x.id}><td><Link href={`/pedidos/${x.id}`} className="forte num">{x.numero}</Link></td><td>{x.fornecedor}</td>
                  <td className="num">{dataCurta(x.prazoEntrega)}</td><td className="dir num">{moeda(x.total)}</td><td><EtiquetaPedido situacao={x.situacao} /></td></tr>
              ))}</tbody>
            </table></div>
          </section>
        )}

        <section className="cartao">
          <h2 className="cartao-titulo">Histórico</h2>
          <ol className="tramite" style={{ marginTop: 10 }}>
            <li><b>Criada</b><span>{dataHora(r.criadoEm)}{r.criadoPor ? ` · ${r.criadoPor}` : ""}</span></li>
            {r.enviadaEm && <li><b>Enviada para aprovação</b><span>{dataHora(r.enviadaEm)}</span></li>}
            {r.decididaEm && <li><b>{r.situacao === "recusada" ? "Recusada" : "Aprovada"}</b><span>{dataHora(r.decididaEm)}{r.decididaPor ? ` · ${r.decididaPor}` : ""}</span></li>}
            {r.motivo && <li><b>Motivo</b><span>{r.motivo}</span></li>}
            {r.observacao && <li><b>Observação</b><span>{r.observacao}</span></li>}
          </ol>
        </section>
      </div>
    </>
  );
}
