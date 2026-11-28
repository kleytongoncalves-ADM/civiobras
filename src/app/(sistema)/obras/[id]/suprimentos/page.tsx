import type { Metadata } from "next";
import Link from "next/link";
import { Check, ArrowRightLeft, FileSpreadsheet, FileText, PackagePlus, Plus } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { dataCurta, moeda, numero, quantidade, unidadeMedida, resumir } from "@/lib/formato";
import { pode } from "@/servicos/permissoes";
import { MOVIMENTOS_MANUAIS, painelSuprimentos, ROTULO_MOVIMENTO, saidaDoEstoque } from "@/servicos/suprimentos";
import { acaoImportarMateriais, acaoMinimo, acaoMovimento, acaoNovaRequisicao } from "../../../suprimentos/acoes";
import { EtiquetaPedido, EtiquetaRequisicao } from "../../../suprimentos/Componentes";
import { CabecalhoObra } from "../CabecalhoObra";
import { carregarObra } from "../carregar";

export const metadata: Metadata = { title: "Suprimentos da obra" };
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const somar = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 864e5).toISOString().slice(0, 10);

export default async function SuprimentosDaObra({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ator, obra } = await carregarObra(id);
  const cab = <CabecalhoObra obra={obra} aba="suprimentos" podeEditar={pode(ator, "obra.editar")} />;
  if (!pode(ator, "suprimentos.ver")) return <>{cab}<div className="cartao vazio"><b>Seu perfil não acessa os suprimentos</b></div></>;
  const p = await painelSuprimentos(ator, id);
  const comSaldo = p.estoque.filter((l) => l.saldo > 0);
  const perdasAcima = p.perdas.filter((l) => l.acima).length;

  return (
    <>
      {cab}
      <div className="indicadores">
        <div className="indicador"><span>Valor em estoque</span><b className="num">{moeda(p.valorEstoque)}</b><small>{comSaldo.length} {comSaldo.length === 1 ? "material" : "materiais"} com saldo</small></div>
        <div className="indicador"><span>Material aplicado</span><b className="num">{moeda(p.consumoMateriais)}</b><small>saídas e perdas, pelo custo médio</small></div>
        <div className={`indicador${p.aguardando ? " indicador-destaque" : ""}`}><span>Requisições aguardando aprovação</span><b className="num">{p.aguardando}</b></div>
        <div className={`indicador${p.atrasados || p.abaixoMinimo ? " indicador-destaque" : ""}`}><span>Pedidos atrasados</span><b className="num">{p.atrasados}</b><small>{p.abaixoMinimo} abaixo do estoque mínimo</small></div>
      </div>

      {p.semCatalogo > 0 && p.podeRequisitar && (
        <section className="cartao faixa-acao">
          <div><b>Lista de compras do orçamento</b><p className="cartao-sub">{p.semCatalogo} {p.semCatalogo === 1 ? "material do orçamento aprovado ainda não está" : "materiais do orçamento aprovado ainda não estão"} no catálogo.</p></div>
          <FormAcao acao={acaoImportarMateriais.bind(null, id)}><BotaoEnviar enviando="Incluindo…"><PackagePlus /> Trazer para o catálogo</BotaoEnviar></FormAcao>
        </section>
      )}
      {!p.temOrcamento && <div className="cartao" style={{ marginBottom: 16 }}><p className="cartao-sub">A obra não tem orçamento aprovado. Toda requisição pedirá justificativa.</p></div>}

      <div className="barra-acoes" style={{ margin: "6px 0 12px" }}>
        <h2 className="cartao-titulo">Estoque e consumo</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/obras/${id}/suprimentos/relatorio`} className="botao botao-neutro botao-pequeno"><FileText /> Relatório</Link>
          <a href={`/obras/${id}/suprimentos/excel`} className="botao botao-neutro botao-pequeno"><FileSpreadsheet /> Excel</a>
        </div>
      </div>
      <div className="grade">
        {p.estoque.length === 0 ? <div className="cartao vazio"><b>Nenhum material nesta obra</b></div> : (
          <div className="tabela-caixa">
            <table className="tabela tabela-compacta">
              <thead><tr><th>Material</th><th className="dir">Previsto</th><th className="dir">Requisitado</th><th className="dir">Recebido</th><th className="dir">Aplicado</th><th className="dir">Perdas</th><th className="dir">Saldo</th><th className="dir">Custo médio</th><th className="dir">Valor</th><th className="dir">Mínimo</th></tr></thead>
              <tbody>
                {p.estoque.map((l) => {
                  const acima = l.previsto > 0 && l.consumido + l.perdas > l.previsto;
                  return (
                    <tr key={l.materialId} className={l.abaixoMinimo ? "linha-vencida" : ""}>
                      <td style={{ minWidth: 220 }}><b>{l.descricao}</b><div className="fraco">{[l.codigo, unidadeMedida(l.unidade)].filter(Boolean).join(" · ")}</div>
                        {l.abaixoMinimo && <span className="etiqueta et-vermelha etiqueta-mini">Repor</span>}{acima && <span className="etiqueta et-laranja etiqueta-mini">Acima do previsto</span>}</td>
                      <td className="dir num">{l.previsto ? quantidade(l.previsto) : "—"}</td>
                      <td className="dir num">{quantidade(l.requisitado)}</td>
                      <td className="dir num">{quantidade(l.recebido)}</td>
                      <td className="dir num">{quantidade(l.consumido)}</td>
                      <td className="dir num">{l.perdas ? quantidade(l.perdas) : "—"}</td>
                      <td className="dir num forte">{quantidade(l.saldo)}</td>
                      <td className="dir num">{l.custoMedio ? moeda(l.custoMedio) : "—"}</td>
                      <td className="dir num">{moeda(l.valor)}</td>
                      <td className="dir">
                        {p.podeEstoque ? (
                          <FormAcao acao={acaoMinimo.bind(null, id, l.materialId)} className="form-minimo" mostrarOk={false}>
                            <input name="minimo" inputMode="decimal" className="entrada-texto num" defaultValue={l.minimo != null ? String(l.minimo).replace(".", ",") : ""} aria-label={`Estoque mínimo de ${l.descricao}`} />
                            <BotaoEnviar className="botao botao-neutro botao-pequeno" ariaLabel="Gravar mínimo"><Check /></BotaoEnviar>
                          </FormAcao>
                        ) : <span className="num">{l.minimo != null ? quantidade(l.minimo) : "—"}</span>}
                      </td>
                    </tr>
                  );
                })}
                <tr className="linha-total"><td>Total</td><td colSpan={7} /><td className="dir num">{moeda(p.valorEstoque)}</td><td /></tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="diario-colunas">
          <section className="cartao">
            <h2 className="cartao-titulo">Requisições</h2>
            {p.podeRequisitar && (
              <FormAcao acao={acaoNovaRequisicao.bind(null, id)} className="form-linha form-base" style={{ marginTop: 10 }}>
                <div className="campo"><label htmlFor="rq-n">Necessário em</label><input id="rq-n" name="necessidade" type="date" min={hoje()} defaultValue={somar(hoje(), 7)} className="entrada-texto" required /></div>
                <div className="campo" style={{ flex: 1, minWidth: 160 }}><label htmlFor="rq-o">Observação</label><input id="rq-o" name="observacao" className="entrada-texto" placeholder="Frente, etapa, urgência" /></div>
                <BotaoEnviar enviando="Criando…"><Plus /> Nova requisição</BotaoEnviar>
              </FormAcao>
            )}
            {p.requisicoes.length === 0 ? <p className="cartao-sub" style={{ marginTop: 10 }}>Nenhuma requisição.</p> : (
              <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
                <thead><tr><th>Nº</th><th>Necessário em</th><th className="dir">Itens</th><th>Situação</th></tr></thead>
                <tbody>{p.requisicoes.slice(0, 20).map((r) => (
                  <tr key={r.id} className={r.atrasada ? "linha-vencida" : ""}>
                    <td><Link href={`/requisicoes/${r.id}`} className="forte num">{r.numero}</Link><div className="fraco">{r.criadoPor ?? ""}</div></td>
                    <td className="num sem-quebra">{dataCurta(r.necessidade)}</td>
                    <td className="dir num">{r.itens}</td>
                    <td><EtiquetaRequisicao situacao={r.situacao} />{r.pedidos > 0 && <div className="fraco">{r.pedidos} {r.pedidos === 1 ? "pedido" : "pedidos"}</div>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section className="cartao">
            <h2 className="cartao-titulo">Pedidos de compra</h2>
            {p.pedidos.length === 0 ? <p className="cartao-sub" style={{ marginTop: 10 }}>Nenhum pedido.</p> : (
              <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
                <thead><tr><th>Nº</th><th>Fornecedor</th><th>Entrega</th><th className="dir">Total</th><th>Situação</th></tr></thead>
                <tbody>{p.pedidos.slice(0, 20).map((x) => (
                  <tr key={x.id} className={x.atrasado ? "linha-vencida" : ""}>
                    <td><Link href={`/pedidos/${x.id}`} className="forte num">{x.numero}</Link></td>
                    <td>{x.fornecedor}<div className="fraco">Requisição {x.requisicaoNumero}</div></td>
                    <td className="num sem-quebra">{dataCurta(x.prazoEntrega)}{x.atrasado && <div><span className="etiqueta et-vermelha etiqueta-mini">Atrasado</span></div>}</td>
                    <td className="dir num">{moeda(x.total)}</td>
                    <td><EtiquetaPedido situacao={x.situacao} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </div>

        {p.podeEstoque && (
          <section className="cartao">
            <h2 className="cartao-titulo">Movimentar estoque</h2>
            <FormAcao acao={acaoMovimento.bind(null, id)} className="grade-form" style={{ marginTop: 10 }} limpar>
              <div className="campo c3"><label htmlFor="mv-t">Movimento</label>
                <select id="mv-t" name="tipo" className="entrada-texto" defaultValue="saida">{MOVIMENTOS_MANUAIS.map((t) => <option key={t} value={t}>{ROTULO_MOVIMENTO[t]}</option>)}</select></div>
              <div className="campo c5"><label htmlFor="mv-m">Material</label>
                <select id="mv-m" name="materialId" className="entrada-texto" required defaultValue="">
                  <option value="" disabled>Escolha</option>
                  {p.estoque.map((l) => <option key={l.materialId} value={l.materialId}>{resumir(l.descricao, 60)} ({quantidade(l.saldo)} {unidadeMedida(l.unidade)})</option>)}
                </select></div>
              <div className="campo c2"><label htmlFor="mv-q">Quantidade</label><input id="mv-q" name="quantidade" inputMode="decimal" className="entrada-texto num" required /></div>
              <div className="campo c2"><label htmlFor="mv-d">Data</label><input id="mv-d" name="data" type="date" max={hoje()} defaultValue={hoje()} className="entrada-texto" required /></div>
              <div className="campo c6"><label htmlFor="mv-i">Item de serviço (saída)</label>
                <select id="mv-i" name="itemServicoId" className="entrada-texto" defaultValue="">
                  <option value="">—</option>
                  {p.itens.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 70)}</option>)}
                </select></div>
              <div className="campo c4"><label htmlFor="mv-o">Obra de destino (transferência)</label>
                <select id="mv-o" name="obraDestinoId" className="entrada-texto" defaultValue="">
                  <option value="">—</option>
                  {p.destinos.map((o) => <option key={o.id} value={o.id}>{o.codigo} · {resumir(o.nome, 40)}</option>)}
                </select></div>
              <div className="campo c2"><label htmlFor="mv-c">Custo unitário (ajuste +)</label><input id="mv-c" name="custoUnitario" inputMode="decimal" className="entrada-texto num" placeholder="Custo médio" /></div>
              <div className="campo c12"><label htmlFor="mv-j">Justificativa</label><input id="mv-j" name="observacao" className="entrada-texto" /></div>
              <div className="c12 rodape-form"><BotaoEnviar enviando="Registrando…"><ArrowRightLeft /> Registrar movimento</BotaoEnviar></div>
            </FormAcao>
          </section>
        )}

        {p.perdas.length > 0 && (
          <section className="cartao">
            <h2 className="cartao-titulo">Consumo real e teórico por serviço</h2>
            <p className="cartao-sub">Teórico = quantidade medida × consumo da composição.{perdasAcima ? ` ${perdasAcima} ${perdasAcima === 1 ? "linha acima" : "linhas acima"} da perda prevista.` : ""}</p>
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Item</th><th>Material</th><th className="dir">Aplicado</th><th className="dir">Teórico</th><th className="dir">Perda</th><th className="dir">Prevista</th></tr></thead>
              <tbody>{p.perdas.map((l, i) => (
                <tr key={i} className={l.acima ? "linha-vencida" : ""}>
                  <td><b className="num">{l.itemNumero}</b> {resumir(l.itemDescricao, 60)}</td>
                  <td>{l.material}</td>
                  <td className="dir num">{quantidade(l.real)} {unidadeMedida(l.unidade)}</td>
                  <td className="dir num">{l.teorico ? `${quantidade(l.teorico)} ${unidadeMedida(l.unidade)}` : "sem medição"}</td>
                  <td className="dir num">{l.perda == null ? "—" : l.perda < 0 ? <span className="etiqueta et-neutra" title="Consumo registrado no estoque abaixo do teórico">Abaixo do teórico</span> : <span className={`etiqueta ${l.acima ? "et-vermelha" : "et-verde"}`}>{numero(l.perda, 1)}%</span>}</td>
                  <td className="dir num">{numero(l.prevista, 1)}%</td>
                </tr>
              ))}</tbody>
            </table></div>
          </section>
        )}

        <section className="cartao">
          <h2 className="cartao-titulo">Movimentos</h2>
          {p.movimentos.length === 0 ? <p className="cartao-sub" style={{ marginTop: 10 }}>Nenhum movimento.</p> : (
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Data</th><th>Movimento</th><th>Material</th><th className="dir">Quantidade</th><th className="dir">Custo</th><th>Destino</th></tr></thead>
              <tbody>{p.movimentos.map((m) => (
                <tr key={m.id}>
                  <td className="num sem-quebra">{dataCurta(m.data)}</td>
                  <td><span className={`etiqueta ${saidaDoEstoque(m.tipo) ? (m.tipo === "perda" ? "et-vermelha" : "et-laranja") : "et-verde"}`}>{ROTULO_MOVIMENTO[m.tipo]}</span><div className="fraco">{m.por ?? ""}</div></td>
                  <td>{m.material}</td>
                  <td className="dir num sem-quebra">{saidaDoEstoque(m.tipo) ? "−" : "+"}{quantidade(m.quantidade)} {unidadeMedida(m.unidade)}</td>
                  <td className="dir num">{moeda(m.valor)}</td>
                  <td style={{ minWidth: 180 }}>{m.item ?? m.destino ?? ""}{m.observacao && <div className="fraco">{m.observacao}</div>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </div>
    </>
  );
}
