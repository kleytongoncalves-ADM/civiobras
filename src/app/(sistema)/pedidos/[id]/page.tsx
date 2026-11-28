import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, PackageCheck } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { CabecalhoRelatorio, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { ErroDeRegra } from "@/lib/db";
import { dataCurta, dataHora, moeda, quantidade, unidadeMedida, resumir } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { SemPermissao } from "@/servicos/permissoes";
import { obterPedido, ROTULO_PEDIDO } from "@/servicos/suprimentos";
import { acaoCancelarPedido, acaoRecebimento } from "../../suprimentos/acoes";

export const metadata: Metadata = { title: "Pedido de compra" };
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const cnpjFmt = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const SELO = { emitido: "neutro", parcial: "laranja", recebido: "verde", cancelado: "vermelho" } as const;

export default async function PaginaPedido({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await exigirUsuario();
  let p;
  try {
    p = await obterPedido(comoAtor(u), id);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) notFound();
    throw e;
  }
  const abertos = p.itens.filter((i) => i.saldo > 0);

  return (
    <div className="grade">
      <div className="barra-acoes nao-imprimir">
        <Link href={`/requisicoes/${p.requisicaoId}`} className="botao botao-neutro"><ArrowLeft /> Requisição nº {p.requisicaoNumero}</Link>
        <Link href={`/obras/${p.obraId}/suprimentos`} className="botao botao-neutro">Suprimentos da obra</Link>
        <BotaoImprimir />
      </div>

      {(p.podeReceber || p.podeCancelar) && (
        <div className="diario-colunas nao-imprimir">
          {p.podeReceber && abertos.length > 0 && (
            <section className="cartao">
              <h2 className="cartao-titulo">Registrar recebimento</h2>
              <FormAcao acao={acaoRecebimento.bind(null, id, p.obraId)} className="grade-form" style={{ marginTop: 10 }}>
                <div className="campo c4"><label htmlFor="rc-d">Data</label><input id="rc-d" name="data" type="date" max={hoje()} min={p.data} defaultValue={hoje()} className="entrada-texto" required /></div>
                <div className="campo c4"><label htmlFor="rc-n">Nota fiscal</label><input id="rc-n" name="notaFiscal" className="entrada-texto" required /></div>
                <div className="campo c2"><label htmlFor="rc-q">Qualidade</label>
                  <select id="rc-q" name="notaQualidade" className="entrada-texto" defaultValue="5">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
                <div className="campo c2"><label htmlFor="rc-a">Atendimento</label>
                  <select id="rc-a" name="notaAtendimento" className="entrada-texto" defaultValue="5">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
                <div className="c12 tabela-caixa"><table className="tabela tabela-compacta">
                  <thead><tr><th>Material</th><th className="dir">A receber</th><th className="dir">Conferido</th><th className="dir">Recusado</th><th>Motivo da recusa</th></tr></thead>
                  <tbody>{abertos.map((i) => (
                    <tr key={i.id}>
                      <td>{resumir(i.material, 50)}<input type="hidden" name="item" value={i.id} /></td>
                      <td className="dir num">{quantidade(i.saldo)} {unidadeMedida(i.unidade)}</td>
                      <td className="dir"><input name={`q_${i.id}`} inputMode="decimal" className="entrada-texto num entrada-curta" defaultValue={String(i.saldo).replace(".", ",")} aria-label={`Conferido de ${i.material}`} /></td>
                      <td className="dir"><input name={`r_${i.id}`} inputMode="decimal" className="entrada-texto num entrada-curta" aria-label={`Recusado de ${i.material}`} /></td>
                      <td><input name={`m_${i.id}`} className="entrada-texto" aria-label={`Motivo da recusa de ${i.material}`} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <div className="campo c12"><label htmlFor="rc-o">Observação</label><input id="rc-o" name="observacao" className="entrada-texto" /></div>
                <div className="c12 rodape-form"><BotaoEnviar enviando="Registrando…"><PackageCheck /> Registrar recebimento</BotaoEnviar></div>
              </FormAcao>
            </section>
          )}
          {p.podeCancelar && (
            <section className="cartao">
              <h2 className="cartao-titulo">Cancelar pedido</h2>
              <FormAcao acao={acaoCancelarPedido.bind(null, id, p.obraId)} className="form-linha" style={{ marginTop: 10 }} confirmar="Cancelar este pedido?">
                <input name="motivo" className="entrada-texto" style={{ flex: 1, minWidth: 180 }} required placeholder="Motivo" aria-label="Motivo do cancelamento" />
                <BotaoEnviar className="botao botao-neutro" enviando="Cancelando…"><Ban /> Cancelar</BotaoEnviar>
              </FormAcao>
            </section>
          )}
        </div>
      )}

      <article className="rel">
        <CabecalhoRelatorio
          orgao={u.orgaoNome}
          tipo="Pedido de compra"
          titulo={`Pedido nº ${p.numero} · ${p.fornecedor}`}
          subtitulo={`${p.obra.codigo} · ${p.obra.nome}`}
          selo={{ texto: p.atrasado ? "Entrega atrasada" : ROTULO_PEDIDO[p.situacao], cor: p.atrasado ? "vermelho" : SELO[p.situacao] }}
          dados={[
            ["Fornecedor", `${p.fornecedor} · CNPJ ${cnpjFmt(p.cnpj)}`],
            ["Contato", [p.responsavel, p.telefone, p.email].filter(Boolean).join(" · ") || "—"],
            ["Emissão", dataCurta(p.data)],
            ["Entrega até", dataCurta(p.prazoEntrega)],
            ["Pagamento", p.condicaoPagamento ?? "—"],
            ["Origem", `Requisição nº ${p.requisicaoNumero} · cotação de ${dataCurta(p.cotacaoData)}`],
            ["Local de entrega", `${p.obra.codigo} · ${p.obra.nome}`],
            ["Emitido por", p.criadoPor ?? "—"],
          ]}
        />
        {p.canceladoMotivo && <div className="rel-alerta">Pedido cancelado: {p.canceladoMotivo}</div>}

        <Secao numero={1} titulo="Materiais">
          <table className="rel-tabela">
            <thead><tr><th>Item</th><th>Material</th><th>Un.</th><th className="dir">Quantidade</th><th className="dir">Preço unitário</th><th className="dir">Total</th></tr></thead>
            <tbody>
              {p.itens.map((i, n) => (
                <tr key={i.id}><td className="num">{n + 1}</td><td>{i.material}{i.codigo && <div className="fraco">{i.codigo}</div>}</td><td>{unidadeMedida(i.unidade)}</td>
                  <td className="dir num">{quantidade(i.quantidade)}</td><td className="dir num">{moeda(i.preco)}</td><td className="dir num">{moeda(i.total)}</td></tr>
              ))}
              <tr><td colSpan={5}>Frete</td><td className="dir num">{moeda(p.frete)}</td></tr>
            </tbody>
            <tfoot><tr><td colSpan={5}>Total do pedido</td><td className="dir num">{moeda(p.total)}</td></tr></tfoot>
          </table>
          {p.justificativa && <p className="fraco" style={{ marginTop: 8 }}>Justificativa da escolha: {p.justificativa}</p>}
        </Secao>

        <Secao numero={2} titulo="Recebimento">
          {p.recebimentos.length === 0 ? <p className="fraco" style={{ fontSize: 13 }}>Nenhum recebimento registrado.</p> : (
            <table className="rel-tabela">
              <thead><tr><th>Data</th><th>Nota fiscal</th><th>Material</th><th className="dir">Conferido</th><th className="dir">Recusado</th><th>Prazo</th><th>Avaliação</th></tr></thead>
              <tbody>{p.recebimentos.flatMap((r) => r.itens.map((i, k) => (
                <tr key={`${r.id}-${k}`}>
                  <td className="num">{k === 0 ? dataCurta(r.data) : ""}</td><td>{k === 0 ? r.notaFiscal : ""}</td>
                  <td>{i.material}{i.motivo && <div className="fraco">Recusa: {i.motivo}</div>}</td>
                  <td className="dir num">{quantidade(i.quantidade)} {unidadeMedida(i.unidade)}</td><td className="dir num">{i.recusada ? quantidade(i.recusada) : "—"}</td>
                  <td>{k === 0 ? (r.noPrazo ? "No prazo" : "Atrasado") : ""}</td>
                  <td>{k === 0 ? `Qualidade ${r.notaQualidade} · atendimento ${r.notaAtendimento}` : ""}</td>
                </tr>
              )))}</tbody>
            </table>
          )}
          <table className="rel-tabela" style={{ marginTop: 12 }}>
            <thead><tr><th>Material</th><th className="dir">Pedido</th><th className="dir">Recebido</th><th className="dir">Recusado</th><th className="dir">Falta receber</th></tr></thead>
            <tbody>{p.itens.map((i) => (
              <tr key={i.id}><td>{i.material}</td><td className="dir num">{quantidade(i.quantidade)}</td><td className="dir num">{quantidade(i.recebido)}</td>
                <td className="dir num">{i.recusado ? quantidade(i.recusado) : "—"}</td><td className="dir num forte">{quantidade(i.saldo)}</td></tr>
            ))}</tbody>
          </table>
        </Secao>

        <Secao numero={3} titulo="Condições">
          <ul className="rel-metodologia">
            <li><b>Entrega:</b> no endereço da obra até {dataCurta(p.prazoEntrega)}, acompanhada da nota fiscal com o número deste pedido.</li>
            <li><b>Conferência:</b> o material é conferido no recebimento. Material fora da especificação ou danificado é recusado e não entra no pagamento.</li>
            <li><b>Preços:</b> conforme a cotação apresentada pelo fornecedor em {dataCurta(p.cotacaoData)}.</li>
          </ul>
        </Secao>

        <footer className="rel-assinaturas">
          <div><span className="rel-linha-assinatura" /><b>{p.criadoPor ?? "Comprador"}</b><span>{u.orgaoNome}</span></div>
          <div><span className="rel-linha-assinatura" /><b>{p.fornecedor}</b><span>Fornecedor · ciente</span></div>
        </footer>
        <RodapeRelatorio texto={`CiviObras · ${u.orgaoNome} · ${p.obra.codigo} · pedido de compra nº ${p.numero} · gerado em ${dataHora(new Date())}`} />
      </article>
    </div>
  );
}
