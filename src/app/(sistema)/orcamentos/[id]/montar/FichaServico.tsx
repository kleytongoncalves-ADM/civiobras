import Link from "next/link";
import { CircleAlert, ExternalLink, Plus, X } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { FotoOuIcone } from "@/componentes/IconeAssunto";
import { fotoDoServico } from "@/lib/fotos-obra";
import { mesAno, moeda, nomeLegivel, unidadeMedida } from "@/lib/formato";
import type { FichaDoServico } from "@/servicos/assistente";
import { ROTULO_FONTE, ROTULO_REGIME, ROTULO_TIPO_INSUMO, type Fonte, type Regime } from "@/servicos/precos";
import { acaoIncluirDoAssistente } from "../../acoes";

type Props = {
  orcamentoId: string; ficha: FichaDoServico; tabelaId: string; icone: string; fechar: string;
  base: { fonte: Fonte; mes: string; regime: Regime }; principal: { mes: string; regime: Regime };
  etapas: { id: string; ordem: number; nome: string }[]; etapaPadrao: string; nomeEtapaNova: string; assuntoId: string | null;
};

/** Ficha do serviço escolhido: o que é, de onde vem, quanto custa, do que é feito e onde incluir. */
export function FichaServico({ orcamentoId, ficha, tabelaId, icone, fechar, base, principal, etapas, etapaPadrao, nomeEtapaNova, assuntoId }: Props) {
  const total = Number(ficha.custo ?? 0) || 1;
  const parte = (v: string) => `${Math.round((Number(v) / total) * 100)}%`;
  return (
    <section className="cartao fs-ficha" aria-label="Serviço escolhido">
      <div className="fs-topo">
        <FotoOuIcone className="fs-icone" src={fotoDoServico(ficha.descricao, assuntoId)} icone={icone} alt="" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="fs-titulo">{nomeLegivel(ficha.descricao)}</h2>
          <p className="fs-origem num">{ROTULO_FONTE[ficha.fonte]} {ficha.codigo} · {mesAno(base.mes)} · {ROTULO_REGIME[base.regime]}{ficha.caminho.length > 0 && <> · {ficha.caminho.join(" › ")}</>}</p>
        </div>
        <Link href={fechar} className="botao botao-texto botao-pequeno" aria-label="Fechar"><X /></Link>
      </div>

      <div className="fs-numeros">
        <div className="fs-destaque"><span>Custo por {unidadeMedida(ficha.unidade)}</span><b className="num">{ficha.custo ? moeda(ficha.custo) : "Sem preço"}</b><small>sem BDI</small></div>
        <div><span>Material</span><b className="num">{moeda(ficha.material)}</b><small>{ficha.custo ? parte(ficha.material) : ""}</small></div>
        <div><span>Mão de obra</span><b className="num">{moeda(ficha.maoDeObra)}</b><small>{ficha.custo ? parte(ficha.maoDeObra) : ""}</small></div>
        <div><span>Equipamento</span><b className="num">{moeda(ficha.equipamento)}</b><small>{ficha.custo ? parte(ficha.equipamento) : ""}</small></div>
      </div>

      {base.mes !== principal.mes && <div className="aviso aviso-info"><CircleAlert /><span>Data-base {mesAno(base.mes)}, diferente da principal do orçamento ({mesAno(principal.mes)}). Fica registrado no item.</span></div>}
      {base.regime !== principal.regime && <div className="aviso aviso-info"><CircleAlert /><span>Regime {ROTULO_REGIME[base.regime].toLowerCase()}, diferente do principal ({ROTULO_REGIME[principal.regime].toLowerCase()}).</span></div>}
      {ficha.semPreco > 0 && <div className="aviso aviso-erro"><CircleAlert /><span>{ficha.semPreco === 1 ? "Um insumo está" : `${ficha.semPreco} insumos estão`} sem preço nesta base. O item entra sem preço até ser resolvido.</span></div>}

      <FormAcao acao={acaoIncluirDoAssistente.bind(null, orcamentoId)} className="fs-incluir" limpar>
        <input type="hidden" name="tipo" value="composicao" />
        <input type="hidden" name="refId" value={ficha.id} />
        <input type="hidden" name="tabelaId" value={tabelaId} />
        <input type="hidden" name="assuntoId" value={assuntoId ?? ""} />
        <input type="hidden" name="novaEtapa" value={nomeEtapaNova} />
        <div className="campo"><label htmlFor="quantidade">Quantidade ({unidadeMedida(ficha.unidade)})</label>
          <input id="quantidade" name="quantidade" className="entrada-texto num" inputMode="decimal" required autoFocus placeholder="0,00" />
        </div>
        <div className="campo"><label htmlFor="etapaId">Etapa</label>
          <select id="etapaId" name="etapaId" className="entrada-texto" defaultValue={etapaPadrao}>
            {etapas.map((e) => <option key={e.id} value={e.id}>{e.ordem}. {e.nome}</option>)}
            <option value="nova">Nova etapa: {nomeEtapaNova}</option>
          </select>
        </div>
        <div className="campo fs-memoria"><label htmlFor="memoria">Como chegou na quantidade <small>(opcional)</small></label>
          <input id="memoria" name="memoria" className="entrada-texto" placeholder="Ex.: 2 paredes × 12,5 m × 2,8 m" />
        </div>
        <BotaoEnviar enviando="Incluindo…"><Plus /> Incluir no orçamento</BotaoEnviar>
      </FormAcao>

      <details className="fs-composicao">
        <summary>Do que é feito ({ficha.linhas.length} {ficha.linhas.length === 1 ? "item" : "itens"} da composição)</summary>
        <p className="cartao-sub">Descrição oficial: {ficha.descricao}</p>
        <table className="tabela tabela-compacta">
          <thead><tr><th>Código</th><th>Descrição</th><th>Und.</th><th className="dir">Coeficiente</th><th className="dir">Preço unit.</th><th className="dir">Total</th></tr></thead>
          <tbody>
            {ficha.linhas.map((l) => (
              <tr key={l.id}>
                <td className="num fraco">{l.codigo}</td>
                <td>{nomeLegivel(l.descricao)} <span className="etiqueta">{l.tipoLinha === "composicao" ? "Composição auxiliar" : l.tipo ? ROTULO_TIPO_INSUMO[l.tipo] : ""}</span></td>
                <td>{unidadeMedida(l.unidade)}</td>
                <td className="dir num">{Number(l.coeficiente).toLocaleString("pt-BR", { maximumFractionDigits: 7 })}</td>
                <td className="dir num">{l.precoUnitario ? moeda(l.precoUnitario) : <span className="etiqueta et-vermelha">Sem preço</span>}</td>
                <td className="dir num">{l.total ? moeda(l.total) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Link href={`/precos/composicoes/${ficha.id}?tabela=${tabelaId}`} className="botao botao-texto botao-pequeno"><ExternalLink /> Abrir a composição completa</Link>
      </details>
    </section>
  );
}
