import Link from "next/link";
import { Calculator, CircleAlert, Plus } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { ErroDeRegra } from "@/lib/db";
import type { Regra } from "@/lib/decimal";
import { moeda, nomeLegivel, resumir, unidadeMedida } from "@/lib/formato";
import type { Ator } from "@/servicos/obras";
import { lerMedidas, sugerirPacote, type LinhaSugerida, type Pacote } from "@/servicos/pacotes";
import { ROTULO_FONTE, type Fonte } from "@/servicos/precos";
import { acaoIncluirPacote } from "../../acoes";

type Props = {
  ator: Ator; orcamentoId: string; pacote: Pacote; assuntoId: string; assuntoNome: string; regra: Regra;
  bases: { tabelaId: string; fonte: Fonte; principal: boolean }[];
  etapas: { id: string; ordem: number; nome: string }[];
  valores: Record<string, string | undefined>;
  acaoGet: string;
};

/**
 * "Montar pelo tamanho": o usuário informa as medidas e os serviços que andam juntos já vêm
 * marcados, com quantidade, memória de cálculo e a composição da base.
 */
export async function PacoteAssunto({ ator, orcamentoId, pacote, assuntoId, assuntoNome, regra, bases, etapas, valores, acaoGet }: Props) {
  const calcular = valores.calc === "1";
  let linhas: LinhaSugerida[] = [];
  let erro: string | null = null;
  if (calcular) {
    try {
      linhas = await sugerirPacote(ator, pacote, lerMedidas(pacote, Object.fromEntries(pacote.parametros.map((p) => [p.chave, valores[`m_${p.chave}`]]))), bases, regra);
    } catch (e) {
      if (e instanceof ErroDeRegra) erro = e.message; else throw e;
    }
  }
  const etapaDoAssunto = etapas.find((e) => e.nome.toLowerCase() === assuntoNome.toLowerCase());
  const estimado = linhas.filter((l) => l.marcado && l.escolhida?.custo).reduce((s, l) => s + Number(l.quantidade) * Number(l.escolhida!.custo), 0);

  return (
    <section className="pacote">
      <p className="cartao-sub">Informe as medidas. A lista abaixo mostra os serviços que costumam entrar juntos e a conta de cada quantidade. Confira, desmarque o que não for usar e só então inclua.</p>
      <form action={acaoGet} className="pacote-medidas">
        <input type="hidden" name="assunto" value={assuntoId} />
        <input type="hidden" name="calc" value="1" />
        {pacote.parametros.map((p) => (
          <div key={p.chave} className="campo">
            <label htmlFor={`m_${p.chave}`}>{p.rotulo}{p.unidade && <small> ({p.unidade})</small>}</label>
            <input id={`m_${p.chave}`} name={`m_${p.chave}`} className="entrada-texto num" inputMode="decimal" defaultValue={valores[`m_${p.chave}`] ?? p.padrao} />
          </div>
        ))}
        <button className="botao botao-neutro"><Calculator /> {calcular ? "Recalcular" : "Calcular serviços"}</button>
      </form>

      {erro && <div className="aviso aviso-erro"><CircleAlert /><span>{erro}</span></div>}

      {linhas.length > 0 && (
        <FormAcao acao={acaoIncluirPacote.bind(null, orcamentoId)} className="pacote-lista">
          <input type="hidden" name="linhas" value={linhas.length} />
          <input type="hidden" name="assuntoId" value={assuntoId} />
          <table className="tabela tabela-compacta">
            <thead><tr><th aria-label="Incluir" /><th>Serviço e composição da base</th><th className="dir">Quantidade</th><th className="dir">Custo unit.</th><th className="dir">Subtotal</th></tr></thead>
            <tbody>
              {linhas.map((l, i) => (
                <tr key={l.chave} className={l.escolhida ? "" : "pacote-sem"}>
                  <td><input type="checkbox" name={`usar_${i}`} defaultChecked={l.marcado} disabled={!l.escolhida} aria-label={`Incluir ${l.nome}`} /></td>
                  <td>
                    <b>{l.nome}</b>
                    {l.escolhida ? (
                      <select name={`ref_${i}`} className="entrada-texto pacote-opcao" defaultValue={`${l.escolhida.id}|${l.escolhida.tabelaId}`} aria-label={`Composição para ${l.nome}`}>
                        {l.alternativas.map((k) => (
                          <option key={`${k.id}|${k.tabelaId}`} value={`${k.id}|${k.tabelaId}`}>
                            {ROTULO_FONTE[k.fonte]} {k.codigo} · {resumir(nomeLegivel(k.descricao), 90)} · {k.custo ? moeda(k.custo) : "sem preço"}
                          </option>
                        ))}
                      </select>
                    ) : <small className="pacote-falta">Não encontrado nas bases escolhidas. Procure na busca abaixo ou inclua por cotação.</small>}
                    <small className="fraco">{l.memoria}</small>
                    <input type="hidden" name={`mem_${i}`} value={l.memoria} />
                  </td>
                  <td className="dir"><input name={`qtd_${i}`} className="entrada-texto num pacote-qtd" inputMode="decimal" defaultValue={l.quantidade.replace(".", ",")} aria-label={`Quantidade de ${l.nome}`} /> <small>{unidadeMedida(l.unidade)}</small></td>
                  <td className="dir num">{l.escolhida?.custo ? moeda(l.escolhida.custo) : "—"}</td>
                  <td className="dir num">{l.escolhida?.custo ? moeda(Number(l.quantidade) * Number(l.escolhida.custo)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pacote-rodape">
            <span className="cartao-sub">Custo direto estimado dos marcados: <b className="num">{moeda(estimado)}</b> (sem BDI). Trocar a composição ou a quantidade vale ao incluir.</span>
            <div className="form-linha">
              <select name="etapaId" className="entrada-texto" defaultValue={etapaDoAssunto?.id ?? "nova"} aria-label="Etapa" style={{ maxWidth: 240 }}>
                {etapas.map((e) => <option key={e.id} value={e.id}>{e.ordem}. {e.nome}</option>)}
                <option value="nova">Nova etapa: {assuntoNome}</option>
              </select>
              <input type="hidden" name="novaEtapa" value={assuntoNome} />
              <BotaoEnviar enviando="Incluindo…"><Plus /> Incluir os marcados</BotaoEnviar>
            </div>
          </div>
        </FormAcao>
      )}
      {calcular && !erro && linhas.length === 0 && <p className="cartao-sub">Nada a sugerir com essas medidas.</p>}
      {calcular && <Link href={`${acaoGet}?assunto=${assuntoId}`} className="botao botao-texto botao-pequeno">Limpar medidas</Link>}
    </section>
  );
}
