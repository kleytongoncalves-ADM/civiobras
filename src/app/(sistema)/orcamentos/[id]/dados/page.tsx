import type { Metadata } from "next";
import { RefreshCw } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { mesAno, moeda, paraCampo, percentual } from "@/lib/formato";
import { compararRegimes } from "@/servicos/orcamentos";
import { listarTabelas, ROTULO_FONTE, ROTULO_REGIME } from "@/servicos/precos";
import { acaoDadosGerais, acaoTrocarBase } from "../../acoes";
import { carregarOrcamento } from "../carregar";
import { FormDados } from "./FormDados";
import { NavPassos } from "../ResumoOrcamento";

export const metadata: Metadata = { title: "BDI e dados do orçamento" };

export default async function Dados({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ator, orcamento: o, editavel } = await carregarOrcamento(id);
  const [regimes, tabelas] = await Promise.all([compararRegimes(ator, id), editavel ? listarTabelas(ator, { somenteLiberadas: true }) : Promise.resolve([])]);
  const outras = tabelas.filter((t) => t.fonte === o.fonte && t.id !== o.tabelaId);

  return (
    <div className="grade">
      <FormDados
        acao={acaoDadosGerais.bind(null, id)}
        editavel={editavel}
        iniciais={{
          nome: o.nome, arredondamento: o.arredondamento, tipoObraBdi: o.tipoObraBdi, bdiObra: o.bdiObra, bdiFornecimento: o.bdiFornecimento,
          encargosHorista: paraCampo(o.encargosHorista), encargosMensalista: paraCampo(o.encargosMensalista),
          responsavelTecnico: o.responsavelTecnico ?? "", registroProfissional: o.registroProfissional ?? "", art: o.art ?? "",
        }}
      />

      <section className="cartao">
        <h3 className="cartao-titulo">Data-base e regime</h3>
        <p className="cartao-sub" style={{ marginBottom: 14 }}>{ROTULO_FONTE[o.fonte]} {o.uf} {mesAno(o.mes)} · {ROTULO_REGIME[o.regime]}</p>
        {regimes ? (
          <div className="comparacao">
            <div><span>{ROTULO_REGIME[regimes.atual.regime]} (atual)</span><b className="num">{moeda(regimes.atual.total)}</b><small>BDI {percentual(regimes.atual.bdi)}</small></div>
            <div><span>{ROTULO_REGIME[regimes.outro.regime]}</span><b className="num">{moeda(regimes.outro.total)}</b><small>BDI {percentual(regimes.outro.bdi)}{regimes.outro.semPreco ? ` · ${regimes.outro.semPreco} sem preço` : ""}</small></div>
            <div><span>Diferença</span><b className={`num ${Number(regimes.diferenca) < 0 ? "verde" : "vermelho"}`}>{moeda(regimes.diferenca)}</b><small>{Number(regimes.diferenca) < 0 ? `O ${ROTULO_REGIME[regimes.outro.regime].toLowerCase()} sai mais barato.` : `O ${ROTULO_REGIME[regimes.atual.regime].toLowerCase()} sai mais barato.`}</small></div>
          </div>
        ) : <p className="cartao-sub">Sem tabela do outro regime para esta data-base.</p>}
        {editavel && outras.length > 0 && (
          <FormAcao acao={acaoTrocarBase.bind(null, id)} className="form-linha" style={{ marginTop: 16 }} confirmar="Os preços dos itens serão recalculados com a nova base. Continuar?">
            <select name="tabelaId" className="entrada-texto" aria-label="Nova base de preços" style={{ maxWidth: 360 }} defaultValue={regimes?.outro.tabelaId}>
              {outras.map((t) => <option key={t.id} value={t.id}>{ROTULO_FONTE[t.fonte]} {t.uf} {mesAno(t.mes)} · {ROTULO_REGIME[t.regime]}</option>)}
            </select>
            <BotaoEnviar className="botao botao-neutro" enviando="Atualizando…"><RefreshCw /> Trocar base</BotaoEnviar>
          </FormAcao>
        )}
      </section>
      {o.situacao === "rascunho" && <NavPassos proximo={`/orcamentos/${id}/montar${o.modoMontagem ? "" : "?escolher=1"}`} rotuloProximo={o.modoMontagem ? "Ir para os serviços" : "Próximo passo"} />}
    </div>
  );
}
