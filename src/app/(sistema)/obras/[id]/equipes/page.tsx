import type { Metadata } from "next";
import Link from "next/link";
import { Clock, FileSpreadsheet, FileText, LogOut, Truck, UserPlus } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { dataCurta, moeda, numero, unidadeMedida, resumir } from "@/lib/formato";
import { painelEquipes } from "@/servicos/equipes";
import { pode } from "@/servicos/permissoes";
import { acaoAlocarEquipamento, acaoAlocarPessoa, acaoApontarEquipamento, acaoApontarHoras, acaoEncerrarAlocacao } from "../../../equipes/acoes";
import { SituacaoHabilitacao } from "../../../equipes/Componentes";
import { CabecalhoObra } from "../CabecalhoObra";
import { carregarObra } from "../carregar";

export const metadata: Metadata = { title: "Equipes da obra" };
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

export default async function EquipesDaObra({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ator, obra } = await carregarObra(id);
  const cab = <CabecalhoObra obra={obra} aba="equipes" podeEditar={pode(ator, "obra.editar")} />;
  if (!pode(ator, "equipes.ver")) return <>{cab}<div className="cartao vazio"><b>Seu perfil não acessa as equipes</b></div></>;
  const p = await painelEquipes(ator, id);
  const ativas = p.pessoas.filter((x) => x.ativa);
  const eqAtivos = p.equipamentos.filter((x) => x.ativa);
  const realizado = p.totalMateriais + p.totalMaoDeObra + p.totalEquipamentos;
  const pendentes = ativas.filter((x) => x.pendencia).length;

  return (
    <>
      {cab}
      <div className="indicadores">
        <div className={`indicador${pendentes ? " indicador-destaque" : ""}`}><span>Pessoas na obra</span><b className="num">{ativas.length}</b><small>{pendentes ? `${pendentes} com habilitação vencida` : `${p.alertas} ${p.alertas === 1 ? "alerta" : "alertas"} de validade`}</small></div>
        <div className="indicador"><span>Equipamentos na obra</span><b className="num">{eqAtivos.length}</b><small>{eqAtivos.filter((q) => !q.disponivel).length} com manutenção vencida</small></div>
        <div className="indicador"><span>Horas no mês</span><b className="num">{numero(p.horasMes, 1)} h</b></div>
        <div className="indicador"><span>Custo realizado</span><b className="num">{moeda(realizado)}</b><small>material, mão de obra e equipamento</small></div>
      </div>

      <div className="barra-acoes" style={{ margin: "6px 0 12px" }}>
        <h2 className="cartao-titulo">Equipe alocada</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href={`/obras/${id}/equipes/relatorio`} className="botao botao-neutro botao-pequeno"><FileText /> Relatório</Link>
          <a href={`/obras/${id}/equipes/excel`} className="botao botao-neutro botao-pequeno"><FileSpreadsheet /> Excel</a>
        </div>
      </div>
      <div className="grade">
        {p.pessoas.length === 0 ? <div className="cartao vazio"><b>Nenhuma pessoa alocada</b></div> : (
          <div className="tabela-caixa">
            <table className="tabela tabela-compacta">
              <thead><tr><th>Pessoa</th><th>Função na obra</th><th>Empresa</th><th>Período</th><th className="dir">Horas no mês</th><th>ASO e treinamentos</th>{p.podeGerenciar && <th>Saída</th>}</tr></thead>
              <tbody>{p.pessoas.map((x) => (
                <tr key={x.id} className={x.ativa ? (x.pendencia ? "linha-vencida" : "") : "linha-apagada"}>
                  <td><Link href={`/equipes/pessoas/${x.pessoaId}`} className="forte">{x.nome}</Link></td>
                  <td>{x.funcao}</td>
                  <td>{x.empresa ?? "Equipe própria"}</td>
                  <td className="num sem-quebra">{dataCurta(x.inicio)}{x.fim ? ` a ${dataCurta(x.fim)}` : ""}</td>
                  <td className="dir num">{x.horasMes ? numero(x.horasMes, 1) : "—"}</td>
                  <td><SituacaoHabilitacao pendencia={x.pendencia} vencimento={x.vencimento} item={x.vencimentoItem} /></td>
                  {p.podeGerenciar && <td>{!x.fim && (
                    <FormAcao acao={acaoEncerrarAlocacao.bind(null, id, "pessoa", x.id)} className="form-minimo" mostrarOk={false} confirmar={`Registrar a saída de ${x.nome} da obra?`}>
                      <input name="fim" type="date" min={x.inicio} defaultValue={hoje()} className="entrada-texto" aria-label={`Saída de ${x.nome}`} required />
                      <BotaoEnviar className="botao botao-neutro botao-pequeno" ariaLabel="Registrar saída"><LogOut /></BotaoEnviar>
                    </FormAcao>)}</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {p.podeGerenciar && (
          <details className="detalhe-acao">
            <summary>Alocar pessoa</summary>
            <FormAcao acao={acaoAlocarPessoa.bind(null, id)} className="grade-form" style={{ marginTop: 10 }} limpar>
              <div className="campo c5"><label htmlFor="al-p">Pessoa</label>
                <select id="al-p" name="pessoaId" className="entrada-texto" required defaultValue="">
                  <option value="" disabled>Escolha</option>
                  {p.disponiveis.map((x) => <option key={x.id} value={x.id}>{x.nome} · {x.funcao}{x.empresa ? ` · ${x.empresa}` : ""}{x.pendencia ? ` (${x.pendencia})` : ""}</option>)}
                </select></div>
              <div className="campo c3"><label htmlFor="al-f">Função na obra</label><input id="al-f" name="funcao" className="entrada-texto" placeholder="A do cadastro" /></div>
              <div className="campo c2"><label htmlFor="al-i">Início</label><input id="al-i" name="inicio" type="date" defaultValue={hoje()} className="entrada-texto" required /></div>
              <div className="campo c2"><label htmlFor="al-fi">Fim previsto</label><input id="al-fi" name="fim" type="date" className="entrada-texto" /></div>
              <div className="c12 rodape-form"><BotaoEnviar enviando="Alocando…"><UserPlus /> Alocar</BotaoEnviar></div>
            </FormAcao>
          </details>
        )}

        {p.podeApontar && ativas.length > 0 && (
          <section className="cartao">
            <h2 className="cartao-titulo">Apontamento de horas</h2>
            <FormAcao acao={acaoApontarHoras.bind(null, id)} className="grade-form" style={{ marginTop: 10 }} limpar>
              <div className="campo c3"><label htmlFor="ap-d">Data</label><input id="ap-d" name="data" type="date" max={hoje()} defaultValue={hoje()} className="entrada-texto" required /></div>
              <div className="campo c9"><label htmlFor="ap-i">Item de serviço</label>
                <select id="ap-i" name="itemServicoId" className="entrada-texto" defaultValue="">
                  <option value="">Sem item (administração local)</option>
                  {p.itens.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 80)}</option>)}
                </select></div>
              <div className="c12 tabela-caixa"><table className="tabela tabela-compacta">
                <thead><tr><th>Pessoa</th><th>Função</th><th className="dir">Horas normais</th><th className="dir">Horas extras</th></tr></thead>
                <tbody>{ativas.map((x) => (
                  <tr key={x.id} className={x.pendencia ? "linha-vencida" : ""}>
                    <td>{x.nome}{!x.pendencia && <input type="hidden" name="pessoa" value={x.pessoaId} />}{x.pendencia && <div className="fraco">{x.pendencia.replace(/^./, (c) => c.toUpperCase())}</div>}</td>
                    <td>{x.funcao}</td>
                    {x.pendencia ? <td colSpan={2} className="dir fraco">Sem apontamento até regularizar</td> : <>
                    <td className="dir"><input name={`n_${x.pessoaId}`} inputMode="decimal" className="entrada-texto num entrada-curta" placeholder="8" aria-label={`Horas normais de ${x.nome}`} /></td>
                    <td className="dir"><input name={`x_${x.pessoaId}`} inputMode="decimal" className="entrada-texto num entrada-curta" aria-label={`Horas extras de ${x.nome}`} /></td></>}
                  </tr>
                ))}</tbody>
              </table></div>
              <div className="c12 rodape-form"><BotaoEnviar enviando="Apontando…"><Clock /> Apontar horas</BotaoEnviar></div>
            </FormAcao>
          </section>
        )}

        <section className="cartao">
          <h2 className="cartao-titulo">Equipamentos</h2>
          {p.equipamentos.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhum equipamento alocado.</p> : (
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Equipamento</th><th>Período</th><th>Próxima revisão</th><th className="dir">Horas no mês</th>{p.podeGerenciar && <th>Saída</th>}</tr></thead>
              <tbody>{p.equipamentos.map((q) => (
                <tr key={q.id} className={q.ativa ? (!q.disponivel ? "linha-vencida" : "") : "linha-apagada"}>
                  <td><Link href={`/equipes/equipamentos/${q.equipamentoId}`} className="forte">{q.descricao}</Link><div className="fraco">{q.identificacao ?? ""}</div></td>
                  <td className="num sem-quebra">{dataCurta(q.inicio)}{q.fim ? ` a ${dataCurta(q.fim)}` : ""}</td>
                  <td>{q.proximaRevisao ? <span className={`etiqueta ${q.disponivel ? "et-verde" : "et-vermelha"}`}>{dataCurta(q.proximaRevisao)}</span> : "—"}</td>
                  <td className="dir num">{q.horasMes ? numero(q.horasMes, 1) : "—"}</td>
                  {p.podeGerenciar && <td>{!q.fim && (
                    <FormAcao acao={acaoEncerrarAlocacao.bind(null, id, "equipamento", q.id)} className="form-minimo" mostrarOk={false}>
                      <input name="fim" type="date" min={q.inicio} defaultValue={hoje()} className="entrada-texto" aria-label={`Saída de ${q.descricao}`} required />
                      <BotaoEnviar className="botao botao-neutro botao-pequeno" ariaLabel="Registrar saída"><LogOut /></BotaoEnviar>
                    </FormAcao>)}</td>}
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <div className="diario-colunas" style={{ marginTop: 12 }}>
            {p.podeGerenciar && (
              <FormAcao acao={acaoAlocarEquipamento.bind(null, id)} className="grade-form" limpar>
                <div className="campo c12"><label htmlFor="ae-e">Alocar equipamento</label>
                  <select id="ae-e" name="equipamentoId" className="entrada-texto" required defaultValue="">
                    <option value="" disabled>Escolha</option>
                    {p.equipamentosLivres.map((q) => <option key={q.id} value={q.id}>{q.descricao}{q.identificacao ? ` · ${q.identificacao}` : ""}{q.disponivel ? "" : " (manutenção vencida)"}</option>)}
                  </select></div>
                <div className="campo c6"><label htmlFor="ae-i">Início</label><input id="ae-i" name="inicio" type="date" defaultValue={hoje()} className="entrada-texto" required /></div>
                <div className="campo c6"><label htmlFor="ae-f">Fim previsto</label><input id="ae-f" name="fim" type="date" className="entrada-texto" /></div>
                <div className="c12 rodape-form"><BotaoEnviar className="botao botao-neutro" enviando="Alocando…"><Truck /> Alocar</BotaoEnviar></div>
              </FormAcao>
            )}
            {p.podeApontar && eqAtivos.length > 0 && (
              <FormAcao acao={acaoApontarEquipamento.bind(null, id)} className="grade-form" limpar>
                <div className="campo c8"><label htmlFor="ah-e">Apontar horas de equipamento</label>
                  <select id="ah-e" name="equipamentoId" className="entrada-texto" required defaultValue="">
                    <option value="" disabled>Escolha</option>
                    {eqAtivos.map((q) => <option key={q.id} value={q.equipamentoId}>{q.descricao}</option>)}
                  </select></div>
                <div className="campo c4"><label htmlFor="ah-h">Horas</label><input id="ah-h" name="horas" inputMode="decimal" className="entrada-texto num" required /></div>
                <div className="campo c4"><label htmlFor="ah-d">Data</label><input id="ah-d" name="data" type="date" max={hoje()} defaultValue={hoje()} className="entrada-texto" required /></div>
                <div className="campo c8"><label htmlFor="ah-i">Item de serviço</label>
                  <select id="ah-i" name="itemServicoId" className="entrada-texto" defaultValue="">
                    <option value="">Sem item</option>
                    {p.itens.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 60)}</option>)}
                  </select></div>
                <div className="c12 rodape-form"><BotaoEnviar className="botao botao-neutro" enviando="Apontando…"><Clock /> Apontar</BotaoEnviar></div>
              </FormAcao>
            )}
          </div>
        </section>

        <section className="cartao">
          <h2 className="cartao-titulo">Custo realizado e produtividade por serviço</h2>
          {p.custos.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Sem material aplicado, horas ou medição nos serviços.</p> : (
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Item</th><th className="dir">Medido</th><th className="dir">Material</th><th className="dir">Mão de obra</th><th className="dir">Equipamento</th><th className="dir">Realizado</th><th className="dir">Horas por unidade</th><th className="dir">Previsto na composição</th></tr></thead>
              <tbody>{p.custos.map((l) => (
                <tr key={l.itemId}>
                  <td style={{ minWidth: 220 }}><b className="num">{l.numero}</b> {resumir(l.descricao, 60)}<div className="fraco">{numero(l.quantidadeMedida, 2)} {unidadeMedida(l.unidade)} medidos</div></td>
                  <td className="dir num">{moeda(l.medido)}</td>
                  <td className="dir num">{moeda(l.materiais)}</td>
                  <td className="dir num">{moeda(l.maoDeObra)}</td>
                  <td className="dir num">{moeda(l.equipamentos)}</td>
                  <td className="dir num forte">{moeda(l.realizado)}{l.medido > 0 && l.realizado > l.medido && <div><span className="etiqueta et-vermelha etiqueta-mini">Acima do medido</span></div>}</td>
                  <td className="dir num">{l.horasPorUnidade != null ? `${numero(l.horasPorUnidade, 2)} h/${unidadeMedida(l.unidade)}` : "—"}</td>
                  <td className="dir num">{l.previstoPorUnidade ? <>{numero(l.previstoPorUnidade, 2)} h/{unidadeMedida(l.unidade)}{l.indice != null && <div><span className={`etiqueta etiqueta-mini ${l.indice > 1.1 ? "et-vermelha" : l.indice < 0.9 ? "et-verde" : "et-neutra"}`}>{numero(l.indice * 100, 0)}% do previsto</span></div>}</> : "—"}</td>
                </tr>
              ))}
                <tr className="linha-total"><td>Total</td><td className="dir num">{moeda(p.custos.reduce((s, l) => s + l.medido, 0))}</td><td className="dir num">{moeda(p.totalMateriais)}</td><td className="dir num">{moeda(p.totalMaoDeObra)}</td><td className="dir num">{moeda(p.totalEquipamentos)}</td><td className="dir num">{moeda(realizado)}</td><td colSpan={2} /></tr>
              </tbody>
            </table></div>
          )}
        </section>

        {p.apontamentos.length > 0 && (
          <section className="cartao">
            <h2 className="cartao-titulo">Horas apontadas</h2>
            {p.apontamentos.length > 20 && <p className="cartao-sub">Últimos 20 lançamentos. A lista completa está no Excel.</p>}
            <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
              <thead><tr><th>Data</th><th>Pessoa</th><th>Item</th><th className="dir">Normais</th><th className="dir">Extras</th><th className="dir">Custo</th></tr></thead>
              <tbody>{p.apontamentos.slice(0, 20).map((x, i) => (
                <tr key={i}><td className="num">{dataCurta(x.data)}</td><td>{x.nome}<div className="fraco">{x.funcao}</div></td><td className="fraco">{x.item ?? "Administração local"}</td>
                  <td className="dir num">{numero(x.normais, 1)}</td><td className="dir num">{x.extras ? numero(x.extras, 1) : "—"}</td><td className="dir num">{moeda(x.custo)}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        )}
      </div>
    </>
  );
}
