import type { Metadata } from "next";
import Link from "next/link";
import { FileSpreadsheet, FileText, FlaskConical } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { dataCurta, numero, unidadeMedida, resumir } from "@/lib/formato";
import { pode } from "@/servicos/permissoes";
import { painelQualidade, rotuloNc, TIPOS_ENSAIO } from "@/servicos/qualidade";
import { acaoEnsaio } from "../../../qualidade/acoes";
import { ListaInspecoes, NovaNc, TabelaNcs } from "../../../qualidade/Componentes";
import { CabecalhoObra } from "../CabecalhoObra";
import { carregarObra } from "../carregar";

export const metadata: Metadata = { title: "Qualidade da obra" };
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

export default async function QualidadeDaObra({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ator, obra } = await carregarObra(id);
  const cab = <CabecalhoObra obra={obra} aba="qualidade" podeEditar={pode(ator, "obra.editar")} />;
  if (!pode(ator, "qualidade.ver")) return <>{cab}<div className="cartao vazio"><b>Seu perfil não acessa a qualidade</b></div></>;
  const p = await painelQualidade(ator, id);
  const ativas = p.ncs.filter((n) => n.situacao === "aberta" || n.situacao === "corrigida");
  const fechadas = p.ncs.filter((n) => n.situacao === "encerrada" || n.situacao === "cancelada");

  return (
    <>
      {cab}
      <div className="indicadores">
        <div className={`indicador${p.abertas ? " indicador-destaque" : ""}`}><span>Não conformidades abertas</span><b className="num">{p.abertas}</b><small>{p.aguardando} aguardando verificação</small></div>
        <div className="indicador"><span>Prazo vencido</span><b className="num">{p.vencidas}</b><small>{p.impeditivas} travando medição</small></div>
        <div className="indicador"><span>Encerradas</span><b className="num">{p.encerradas}</b><small>{p.tempoMedio != null ? `${numero(p.tempoMedio, 1)} dias em média` : "—"}</small></div>
        <div className="indicador"><span>Conformidade nas inspeções</span><b className="num">{p.conformidade != null ? `${numero(p.conformidade, 0)}%` : "—"}</b><small>{p.inspecoes.length} inspeções · {p.ensaios.length} ensaios</small></div>
      </div>

      <div className="barra-acoes" style={{ marginBottom: 12 }}>
        <h2 className="cartao-titulo">Não conformidades</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/obras/${id}/qualidade/relatorio`} className="botao botao-neutro botao-pequeno"><FileText /> Relatório</Link>
          <a href={`/obras/${id}/qualidade/excel`} className="botao botao-neutro botao-pequeno"><FileSpreadsheet /> Excel</a>
        </div>
      </div>
      <div className="grade">
        <TabelaNcs ncs={ativas} />
        {p.podeRegistrar && <NovaNc obraId={id} area="qualidade" itens={p.itens} hoje={hoje()} />}
        {fechadas.length > 0 && (
          <details className="detalhe-acao"><summary>Encerradas e canceladas ({fechadas.length})</summary><div style={{ marginTop: 10 }}><TabelaNcs ncs={fechadas} /></div></details>
        )}

        <div className="diario-colunas">
          <ListaInspecoes inspecoes={p.inspecoes} obraId={id} area="qualidade" podeRegistrar={p.podeRegistrar} />

          <section className="cartao">
            <h2 className="cartao-titulo">Ensaios</h2>
            {p.ensaios.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhum ensaio.</p> : (
              <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
                <thead><tr><th>Nº</th><th>Ensaio</th><th className="dir">Especificado</th><th className="dir">Resultado</th><th>Situação</th></tr></thead>
                <tbody>
                  {p.ensaios.map((e) => (
                    <tr key={e.id}>
                      <td className="num forte">{e.numero}</td>
                      <td>{e.tipo}<div className="fraco">{[e.local, e.itemNumero ? `item ${e.itemNumero}` : null, dataCurta(e.dataResultado)].filter(Boolean).join(" · ")}</div></td>
                      <td className="dir num sem-quebra">{e.criterio === "minimo" ? "≥" : "≤"} {Number(e.especificado).toLocaleString("pt-BR")} {unidadeMedida(e.unidade)}</td>
                      <td className="dir num sem-quebra forte">{Number(e.resultado).toLocaleString("pt-BR")} {unidadeMedida(e.unidade)}</td>
                      <td>{e.aprovado ? <span className="etiqueta et-verde">Aprovado</span>
                        : <Link href={`/nao-conformidades/${e.ncId}`} className="etiqueta et-vermelha">Reprovado · {e.ncNumero ? rotuloNc({ numero: e.ncNumero }) : "NC"}</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
            {p.podeRegistrar && (
              <details className="detalhe-acao">
                <summary>Registrar ensaio</summary>
                <FormAcao acao={acaoEnsaio.bind(null, id)} className="grade-form" style={{ marginTop: 10 }} limpar>
                  <div className="campo c12"><label htmlFor="en-t">Ensaio</label><input id="en-t" name="tipo" list="tipos-ensaio" className="entrada-texto" required defaultValue={TIPOS_ENSAIO[0].tipo} />
                    <datalist id="tipos-ensaio">{TIPOS_ENSAIO.map((t) => <option key={t.tipo} value={t.tipo} />)}</datalist></div>
                  <div className="campo c6"><label htmlFor="en-i">Item da planilha</label>
                    <select id="en-i" name="itemServicoId" className="entrada-texto" defaultValue=""><option value="">Sem item</option>
                      {p.itens.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 60)}</option>)}</select></div>
                  <div className="campo c6"><label htmlFor="en-l">Local ou lote</label><input id="en-l" name="local" className="entrada-texto" placeholder="Pilares do térreo, lote 3" /></div>
                  <div className="campo c6"><label htmlFor="en-c">Coleta</label><input id="en-c" name="dataColeta" type="date" max={hoje()} className="entrada-texto" required /></div>
                  <div className="campo c6"><label htmlFor="en-r">Resultado em</label><input id="en-r" name="dataResultado" type="date" max={hoje()} className="entrada-texto" required defaultValue={hoje()} /></div>
                  <div className="campo c4"><label htmlFor="en-cr">Critério</label>
                    <select id="en-cr" name="criterio" className="entrada-texto" defaultValue="minimo"><option value="minimo">Mínimo (≥)</option><option value="maximo">Máximo (≤)</option></select></div>
                  <div className="campo c3"><label htmlFor="en-e">Especificado</label><input id="en-e" name="especificado" inputMode="decimal" className="entrada-texto num" required /></div>
                  <div className="campo c3"><label htmlFor="en-v">Resultado</label><input id="en-v" name="resultado" inputMode="decimal" className="entrada-texto num" required /></div>
                  <div className="campo c2"><label htmlFor="en-u">Unidade</label><input id="en-u" name="unidade" className="entrada-texto" required defaultValue="MPa" /></div>
                  <div className="campo c6"><label htmlFor="en-lab">Laboratório</label><input id="en-lab" name="laboratorio" className="entrada-texto" /></div>
                  <div className="campo c6"><label htmlFor="en-ld">Laudo</label><input id="en-ld" name="laudo" className="entrada-texto" placeholder="Número do laudo" /></div>
                  <div className="c12 rodape-form"><BotaoEnviar enviando="Registrando…"><FlaskConical /> Registrar ensaio</BotaoEnviar></div>
                </FormAcao>
              </details>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
