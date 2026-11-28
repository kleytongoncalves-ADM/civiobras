import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { CabecalhoRelatorio, Indicadores, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { BarrasHorizontais, COR } from "@/componentes/relatorio/Graficos";
import { ErroDeRegra } from "@/lib/db";
import { dataCurta, dataHora, moeda, numero, quantidade, unidadeMedida, resumir } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { SemPermissao } from "@/servicos/permissoes";
import { painelSuprimentos, ROTULO_PEDIDO, ROTULO_REQUISICAO } from "@/servicos/suprimentos";

export const metadata: Metadata = { title: "Relatório de suprimentos" };

export default async function RelatorioSuprimentos({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await exigirUsuario();
  let p;
  try {
    p = await painelSuprimentos(comoAtor(u), id, true);
  } catch (e) {
    if (e instanceof ErroDeRegra || e instanceof SemPermissao) notFound();
    throw e;
  }
  const movimentados = p.estoque.filter((l) => l.recebido || l.requisitado || l.saldo);
  const validos = p.pedidos.filter((x) => x.situacao !== "cancelado");
  const comprado = validos.reduce((s, x) => s + x.total, 0);
  const acima = p.perdas.filter((x) => x.acima);
  const excedidos = p.estoque.filter((l) => l.previsto > 0 && l.requisitado > l.previsto * 1.0001);
  const maiores = [...p.estoque].filter((l) => l.valor > 0).sort((a, b) => b.valor - a.valor).slice(0, 8);
  const pontos: string[] = [];
  pontos.push(`${moeda(comprado)} em ${validos.length} ${validos.length === 1 ? "pedido de compra" : "pedidos de compra"}; ${moeda(p.consumoMateriais)} aplicados nos serviços.`);
  if (p.atrasados) pontos.push(`${p.atrasados} ${p.atrasados === 1 ? "pedido com entrega atrasada" : "pedidos com entrega atrasada"}.`);
  if (excedidos.length) pontos.push(`${excedidos.length} ${excedidos.length === 1 ? "material requisitado acima" : "materiais requisitados acima"} do previsto no orçamento, com justificativa registrada.`);
  if (acima.length) pontos.push(`${acima.length} ${acima.length === 1 ? "combinação de serviço e material com perda" : "combinações de serviço e material com perda"} acima da prevista.`);
  if (p.abaixoMinimo) pontos.push(`${p.abaixoMinimo} ${p.abaixoMinimo === 1 ? "material abaixo" : "materiais abaixo"} do estoque mínimo.`);
  let s = 0;
  const n = () => ++s;

  return (
    <div className="grade">
      <div className="barra-acoes nao-imprimir">
        <Link href={`/obras/${id}/suprimentos`} className="botao botao-neutro"><ArrowLeft /> Voltar</Link>
        <a href={`/obras/${id}/suprimentos/excel`} className="botao botao-neutro"><FileSpreadsheet /> Excel</a>
        <BotaoImprimir />
      </div>
      <article className="rel">
        <CabecalhoRelatorio orgao={u.orgaoNome} tipo="Relatório de suprimentos e estoque" titulo={`Suprimentos · ${p.obra.codigo}`} subtitulo={p.obra.nome}
          selo={{ texto: p.atrasados ? "Entrega atrasada" : p.abaixoMinimo ? "Estoque abaixo do mínimo" : "Em dia", cor: p.atrasados ? "vermelho" : p.abaixoMinimo ? "laranja" : "verde" }}
          dados={[["Obra", `${p.obra.codigo} · ${p.obra.nome}`], ["Posição em", dataHora(new Date())], ["Requisições", String(p.requisicoes.length)], ["Pedidos de compra", String(p.pedidos.length)]]} />

        <Secao numero={n()} titulo="Resumo executivo">
          <Indicadores itens={[
            { rotulo: "Valor em estoque", valor: moeda(p.valorEstoque), destaque: true },
            { rotulo: "Material aplicado", valor: moeda(p.consumoMateriais), detalhe: "saídas e perdas" },
            { rotulo: "Comprado", valor: moeda(comprado) },
            { rotulo: "Pedidos atrasados", valor: String(p.atrasados) },
            { rotulo: "Abaixo do mínimo", valor: String(p.abaixoMinimo) },
          ]} />
          <ul className="rel-pontos">{pontos.map((x) => <li key={x}>{x}</li>)}</ul>
        </Secao>

        <Secao numero={n()} titulo="Previsto, comprado e consumido" descricao="Quantidades por material. O previsto vem do orçamento aprovado (quantidade do serviço × coeficiente do insumo).">
          {movimentados.length === 0 ? <p className="fraco">Nenhuma movimentação de material.</p> : (
            <table className="rel-tabela">
              <thead><tr><th>Material</th><th>Un.</th><th className="dir">Previsto</th><th className="dir">Requisitado</th><th className="dir">Recebido</th><th className="dir">Consumido</th><th className="dir">Perdas</th><th className="dir">Saldo</th><th className="dir">Valor em estoque</th></tr></thead>
              <tbody>{movimentados.map((l) => (
                <tr key={l.materialId}><td>{l.descricao}{l.codigo && <div className="fraco">{l.codigo}</div>}</td><td>{unidadeMedida(l.unidade)}</td>
                  <td className="dir num">{l.previsto ? quantidade(l.previsto) : "—"}</td>
                  <td className="dir num">{quantidade(l.requisitado)}{l.previsto > 0 && l.requisitado > l.previsto * 1.0001 && <div className="fraco">acima do previsto</div>}</td>
                  <td className="dir num">{quantidade(l.recebido)}</td><td className="dir num">{quantidade(l.consumido)}</td>
                  <td className="dir num">{l.perdas ? quantidade(l.perdas) : "—"}</td><td className="dir num forte">{quantidade(l.saldo)}</td><td className="dir num">{moeda(l.valor)}</td></tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={8}>Valor total em estoque</td><td className="dir num">{moeda(p.valorEstoque)}</td></tr></tfoot>
            </table>
          )}
          {maiores.length > 1 && <BarrasHorizontais titulo="Maiores valores em estoque (R$)" unidade="" cor={COR.material} itens={maiores.map((l) => ({ rotulo: resumir(l.descricao, 40), valor: Math.round(l.valor) }))} />}
        </Secao>

        {p.perdas.length > 0 && (
          <Secao numero={n()} titulo="Perdas: real × teórico" descricao="Consumo teórico = quantidade medida do serviço × coeficiente do material na composição.">
            <table className="rel-tabela">
              <thead><tr><th>Serviço</th><th>Material</th><th className="dir">Teórico</th><th className="dir">Real</th><th className="dir">Perda real</th><th className="dir">Prevista</th></tr></thead>
              <tbody>{p.perdas.map((x, k) => (
                <tr key={k}><td><span className="num">{x.itemNumero}</span> {resumir(x.itemDescricao, 50)}</td><td>{x.material}</td>
                  <td className="dir num">{quantidade(x.teorico)} {unidadeMedida(x.unidade)}</td><td className="dir num">{quantidade(x.real)} {unidadeMedida(x.unidade)}</td>
                  <td className={`dir num${x.acima ? " forte" : ""}`}>{x.perda == null ? "—" : x.perda < 0 ? "abaixo do teórico" : `${numero(x.perda, 1)}%`}</td><td className="dir num">{numero(x.prevista, 1)}%</td></tr>
              ))}</tbody>
            </table>
          </Secao>
        )}

        {p.requisicoes.length > 0 && (
          <Secao numero={n()} titulo="Requisições">
            <table className="rel-tabela">
              <thead><tr><th>Nº</th><th>Data</th><th>Necessário em</th><th>Solicitante</th><th className="dir">Itens</th><th className="dir">Pedidos</th><th>Situação</th></tr></thead>
              <tbody>{p.requisicoes.map((r) => (
                <tr key={r.id}><td className="num">{r.numero}</td><td className="num">{dataCurta(r.data)}</td><td className="num">{dataCurta(r.necessidade)}</td><td>{r.criadoPor ?? "—"}</td>
                  <td className="dir num">{r.itens}</td><td className="dir num">{r.pedidos || "—"}</td><td>{ROTULO_REQUISICAO[r.situacao]}</td></tr>
              ))}</tbody>
            </table>
          </Secao>
        )}

        {p.pedidos.length > 0 && (
          <Secao numero={n()} titulo="Pedidos de compra">
            <table className="rel-tabela">
              <thead><tr><th>Nº</th><th>Emissão</th><th>Fornecedor</th><th>Requisição</th><th>Entrega até</th><th>Situação</th><th className="dir">Total</th></tr></thead>
              <tbody>{p.pedidos.map((x) => (
                <tr key={x.id}><td className="num">{x.numero}</td><td className="num">{dataCurta(x.data)}</td><td>{x.fornecedor}</td><td className="num">nº {x.requisicaoNumero}</td>
                  <td className="num">{dataCurta(x.prazoEntrega)}</td><td>{x.atrasado ? "Atrasado" : ROTULO_PEDIDO[x.situacao]}</td><td className="dir num">{moeda(x.total)}</td></tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={6}>Total comprado (sem cancelados)</td><td className="dir num">{moeda(comprado)}</td></tr></tfoot>
            </table>
          </Secao>
        )}

        <Secao numero={n()} titulo="Metodologia e fontes">
          <ul className="rel-metodologia">
            <li><b>Previsto:</b> soma, no orçamento aprovado, da quantidade de cada serviço multiplicada pelo coeficiente do material na composição.</li>
            <li><b>Saldo:</b> entradas por recebimento e transferências recebidas, menos saídas para serviço, perdas, ajustes e transferências enviadas.</li>
            <li><b>Custo médio:</b> média ponderada das entradas; saídas e perdas são valoradas por ele no momento do registro.</li>
            <li><b>Perda real:</b> (consumo real − consumo teórico) ÷ consumo teórico, por serviço e material. Consumo abaixo do teórico indica material aplicado sem saída registrada no estoque, como o fornecido pela contratada.</li>
            <li><b>Fonte:</b> requisições, cotações, pedidos, recebimentos e movimentos de estoque registrados no sistema para esta obra.</li>
          </ul>
        </Secao>
        <RodapeRelatorio texto={`CiviObras · ${u.orgaoNome} · ${p.obra.codigo} · relatório de suprimentos · gerado em ${dataHora(new Date())}`} />
      </article>
    </div>
  );
}
