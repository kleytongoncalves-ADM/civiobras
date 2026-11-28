import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, FileSpreadsheet } from "lucide-react";
import { BotaoImprimir } from "@/componentes/BotaoImprimir";
import { CabecalhoRelatorio, Indicadores, RodapeRelatorio, Secao } from "@/componentes/relatorio/Estrutura";
import { dataHora, mesAno, moeda, percentual, quantidade, unidadeMedida, valor } from "@/lib/formato";
import { insumosDoOrcamento, ROTULO_SITUACAO_ORC, rotuloOrcamento, type OrcamentoCompleto } from "@/servicos/orcamentos";
import { analiticaDoOrcamento, peso, type ItemAnalitico } from "@/servicos/planilhas";
import { ROTULO_FONTE, ROTULO_REGIME, ROTULO_TIPO_INSUMO } from "@/servicos/precos";
import { carregarOrcamento } from "../carregar";
import { NavPassos } from "../ResumoOrcamento";
import { ImprimirAoAbrir } from "./ImprimirAoAbrir";

export const metadata: Metadata = { title: "Planilhas do orçamento" };

type Ver = "sintetica" | "analitica" | "ambas";

/** Bases do orçamento por extenso: "SINAPI RJ out/2026 (desonerado) + SICRO RJ jul/2026". */
function basesPorExtenso(o: OrcamentoCompleto) {
  const lista = o.bases.length ? o.bases : [{ fonte: o.fonte, mes: o.mes, regime: o.regime, principal: true }];
  return lista.map((b) => `${ROTULO_FONTE[b.fonte]} ${o.uf} ${mesAno(b.mes)}${b.fonte === "sinapi" ? ` (${ROTULO_REGIME[b.regime].toLowerCase()})` : ""}`).join(" + ");
}

export default async function Planilhas({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ver: Ver = sp.ver === "analitica" || sp.ver === "ambas" ? sp.ver : "sintetica";
  const { ator, usuario, orcamento: o } = await carregarOrcamento(id);
  const analitica = ver === "sintetica" ? [] : analiticaDoOrcamento(o, await insumosDoOrcamento(ator, id));
  const itens = o.etapas.flatMap((e) => e.itens);
  const base = `/orcamentos/${id}`;
  const titulo = ver === "analitica" ? "Planilha analítica" : ver === "ambas" ? "Planilhas sintética e analítica" : "Planilha sintética";

  return (
    <div className="grade">
      {sp.imprimir === "1" && <ImprimirAoAbrir />}
      <div className="planilhas-barra nao-imprimir">
        <nav className="planilhas-alternar" aria-label="Tipo de planilha">
          <Link href={`${base}/planilhas`} className={ver === "sintetica" ? "ativo" : ""} aria-current={ver === "sintetica" ? "page" : undefined}>
            <b>Sintética</b><small>Serviços, quantidades e preços</small>
          </Link>
          <Link href={`${base}/planilhas?ver=analitica`} className={ver === "analitica" ? "ativo" : ""} aria-current={ver === "analitica" ? "page" : undefined}>
            <b>Analítica</b><small>Composição de cada serviço</small>
          </Link>
        </nav>
        <div className="form-linha">
          <a href={`${base}/planilhas/excel?tipo=sintetica`} className="botao botao-neutro"><FileSpreadsheet /> Sintética (.xlsx)</a>
          <a href={`${base}/planilhas/excel?tipo=analitica`} className="botao botao-neutro"><FileSpreadsheet /> Analítica (.xlsx)</a>
          <BotaoImprimir rotulo="Imprimir ou salvar PDF" />
        </div>
      </div>

      {itens.length === 0 && (
        <div className="aviso aviso-info nao-imprimir"><CircleAlert /><span>O orçamento ainda não tem serviços. <Link href={`${base}/montar`} className="botao-texto">Incluir serviços</Link></span></div>
      )}
      {o.semPreco > 0 && (
        <div className="aviso aviso-erro nao-imprimir"><CircleAlert /><span>{o.semPreco === 1 ? "1 serviço está sem preço" : `${o.semPreco} serviços estão sem preço`} e fica fora dos totais. <Link href={base} className="botao-texto">Revisar</Link></span></div>
      )}

      <article className="rel">
        <CabecalhoRelatorio
          orgao={usuario.orgaoNome}
          tipo="Orçamento de obra"
          titulo={titulo}
          subtitulo={`${o.obraCodigo} · ${o.obraNome}`}
          selo={{ texto: ROTULO_SITUACAO_ORC[o.situacao], cor: o.situacao === "aprovado" ? "verde" : o.situacao === "rascunho" ? "laranja" : o.situacao === "cancelado" ? "vermelho" : "neutro" }}
          dados={[
            ["Orçamento", `${rotuloOrcamento(o)} · ${o.nome}`],
            ["Bases e data-base", basesPorExtenso(o)],
            ["BDI de obra", percentual(o.bdiObraPct)],
            ["Totais", `${o.arredondamento === "truncar" ? "Truncados" : "Arredondados"} em 2 casas`],
            ["Responsável técnico", o.responsavelTecnico ? `${o.responsavelTecnico}${o.registroProfissional ? ` · ${o.registroProfissional}` : ""}` : null],
            ["ART/RRT", o.art],
          ]}
        />

        {ver !== "analitica" && <Sintetica o={o} numero={1} />}
        {ver !== "sintetica" && <Analitica o={o} itens={analitica} numero={ver === "ambas" ? 2 : 1} quebra={ver === "ambas"} />}

        <RodapeRelatorio texto={`CiviObras · ${usuario.orgaoNome} · ${o.obraCodigo} ${rotuloOrcamento(o)} · gerada em ${dataHora(new Date())}`} />
      </article>

      <NavPassos voltar={base} />
    </div>
  );
}

function Sintetica({ o, numero }: { o: OrcamentoCompleto; numero: number }) {
  const multiBase = o.bases.length > 1;
  return (
    <Secao numero={numero} titulo="Planilha orçamentária sintética" descricao="Preço unitário com BDI = custo unitário × (1 + BDI). Peso = participação do item no valor global. Valores em reais.">
      <Indicadores itens={[
        { rotulo: "Custo direto", valor: moeda(o.totais.custo) },
        { rotulo: `BDI · ${percentual(o.bdiObraPct)}`, valor: moeda(o.totais.bdi) },
        { rotulo: "Valor global com BDI", valor: moeda(o.totais.total), destaque: true },
      ]} />
      <table className="rel-tabela rel-tabela-planilha rel-fixa planilha-sintetica">
        <colgroup>
          <col style={{ width: "5.5%" }} /><col style={{ width: "8.5%" }} /><col style={{ width: "8%" }} /><col /><col style={{ width: "5%" }} />
          <col style={{ width: "8%" }} /><col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "10.5%" }} /><col style={{ width: "6%" }} />
        </colgroup>
        <thead>
          <tr><th>Item</th><th>Código</th><th>Banco</th><th>Descrição</th><th>Und.</th><th className="dir">Quant.</th><th className="dir">Custo unit.</th><th className="dir">Preço c/ BDI</th><th className="dir">Total</th><th className="dir">Peso</th></tr>
        </thead>
        <tbody>
          {o.etapas.map((e) => [
            <tr key={e.id} className="rel-linha-etapa">
              <td className="num">{e.ordem}</td><td colSpan={7}>{e.nome}</td>
              <td className="dir num">{valor(e.totais.total)}</td><td className="dir num">{percentual(peso(o, e.totais.total), 1)}</td>
            </tr>,
            ...e.itens.map((i) => (
              <tr key={i.id}>
                <td className="num">{i.numero}</td>
                <td className="num">{i.fonte === "cotacao" ? "—" : i.codigo ?? "—"}</td>
                <td>{ROTULO_FONTE[i.fonte]}{(multiBase || (i.baseMes && i.baseMes !== o.mes)) && i.baseMes && <div className="rel-memoria">{mesAno(i.baseMes)}</div>}</td>
                <td>{i.descricao}{i.memoria && <div className="rel-memoria">{i.memoria}</div>}</td>
                <td>{unidadeMedida(i.unidade)}</td>
                <td className="dir num">{quantidade(i.quantidade)}</td>
                <td className="dir num">{i.semPreco ? "—" : valor(i.custoUnitario)}</td>
                <td className="dir num">{i.semPreco ? "—" : valor(i.precoUnitario)}</td>
                <td className="dir num forte">{i.semPreco ? "—" : valor(i.total)}</td>
                <td className="dir num">{i.semPreco ? "—" : percentual(peso(o, i.total), 2)}</td>
              </tr>
            )),
          ])}
        </tbody>
        <tfoot>
          <tr><td colSpan={8}>Custo direto (sem BDI)</td><td className="dir num">{valor(o.totais.custo)}</td><td /></tr>
          <tr><td colSpan={8}>BDI ({percentual(o.bdiObraPct)})</td><td className="dir num">{valor(o.totais.bdi)}</td><td /></tr>
          <tr><td colSpan={8}>Valor global com BDI</td><td className="dir num">{moeda(o.totais.total)}</td><td className="dir num">100%</td></tr>
        </tfoot>
      </table>
    </Secao>
  );
}

function Analitica({ o, itens, numero, quebra }: { o: OrcamentoCompleto; itens: ItemAnalitico[]; numero: number; quebra: boolean }) {
  return (
    <Secao numero={numero} titulo="Composições analíticas" quebra={quebra}
      descricao="Cada serviço aberto em insumos e composições auxiliares, com coeficientes e preços da base na data-base do item. Nas auxiliares, os insumos aparecem com o coeficiente da própria auxiliar.">
      {itens.length === 0 && <p className="cartao-sub">Sem serviços.</p>}
      {itens.map(({ item: i, linhas, soma }) => {
        const bdi = i.semPreco ? null : Number(i.precoUnitario) - Number(i.custoUnitario ?? 0);
        const diferenca = soma != null && i.custoUnitario != null ? Math.abs(soma - Number(i.custoUnitario)) : 0;
        return (
          <div key={i.id} className="rel-analitica planilha-analitica">
            <p>
              <b className="num">{i.numero}</b>
              <span>{i.descricao}</span>
              <small>{[i.fonte === "cotacao" || !i.codigo ? ROTULO_FONTE[i.fonte] : `${ROTULO_FONTE[i.fonte]} ${i.codigo}`, i.baseMes ? mesAno(i.baseMes) : mesAno(o.mes), unidadeMedida(i.unidade)].join(" · ")}</small>
            </p>
            {linhas.length > 0 ? (
              <table className="rel-tabela rel-fixa">
                <colgroup><col style={{ width: "10%" }} /><col style={{ width: "8%" }} /><col /><col style={{ width: "11%" }} /><col style={{ width: "6%" }} /><col style={{ width: "10%" }} /><col style={{ width: "10%" }} /><col style={{ width: "10%" }} /></colgroup>
                <thead><tr><th>Código</th><th>Banco</th><th>Descrição</th><th>Tipo</th><th>Und.</th><th className="dir">Coeficiente</th><th className="dir">Preço unit.</th><th className="dir">Parcial</th></tr></thead>
                <tbody>
                  {linhas.map((l, k) => (
                    <tr key={k} className={l.tipo === "auxiliar" ? "an-auxiliar" : l.nivel === 1 ? "an-filho" : ""}>
                      <td className="num">{l.codigo}</td>
                      <td>{l.fonte ? ROTULO_FONTE[l.fonte] : "—"}</td>
                      <td>{l.descricao}</td>
                      <td className="fraco">{l.tipo === "auxiliar" ? "Composição auxiliar" : l.tipoInsumo ? ROTULO_TIPO_INSUMO[l.tipoInsumo] : ""}</td>
                      <td>{unidadeMedida(l.unidade)}</td>
                      <td className="dir num">{valor(l.coeficiente, l.nivel === 1 ? 6 : 4)}</td>
                      <td className="dir num">{l.preco == null ? "—" : valor(l.preco)}</td>
                      <td className="dir num">{l.parcial == null ? "—" : l.nivel === 1 ? <span className="fraco">{valor(l.parcial)}</span> : valor(l.parcial)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={7}>Custo unitário (sem BDI)</td><td className="dir num">{i.semPreco ? "—" : valor(i.custoUnitario)}</td></tr>
                  <tr><td colSpan={7}>BDI ({percentual(i.tipoBdi === "fornecimento" ? o.bdiFornecimentoPct : o.bdiObraPct)}{i.tipoBdi === "fornecimento" ? ", fornecimento" : ""})</td><td className="dir num">{bdi == null ? "—" : valor(bdi)}</td></tr>
                  <tr><td colSpan={7}>Preço unitário com BDI × {quantidade(i.quantidade)} {unidadeMedida(i.unidade)} = total do item</td><td className="dir num">{i.semPreco ? "—" : `${valor(i.precoUnitario)} → ${valor(i.total)}`}</td></tr>
                </tfoot>
              </table>
            ) : (
              <p className="rel-memoria">{i.fonte === "cotacao" ? `Preço por cotação de mercado${i.criterioCotacao ? ` (${i.criterioCotacao})` : ""}: ${i.cotacoes.length} propostas registradas no item.` : "Item sem composição registrada."}</p>
            )}
            {diferenca >= 0.01 && <p className="rel-memoria">A soma das parcelas difere do custo unitário em {valor(diferenca)} por arredondamento das casas decimais.</p>}
          </div>
        );
      })}
    </Secao>
  );
}
