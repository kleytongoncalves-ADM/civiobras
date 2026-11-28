import Link from "next/link";
import { ClipboardCheck, Plus } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { dataCurta, resumir } from "@/lib/formato";
import {
  MODELOS, PRAZO_PADRAO, ROTULO_GRAVIDADE, ROTULO_ORIGEM_NC, ROTULO_SITUACAO_NC, rotuloNc,
  type Area, type Gravidade, type Inspecao, type ItemObra, type NaoConformidade, type SituacaoNc,
} from "@/servicos/qualidade";
import { acaoAbrirNc } from "./acoes";

const COR_SITUACAO: Record<SituacaoNc, string> = { aberta: "et-vermelha", corrigida: "et-laranja", encerrada: "et-verde", cancelada: "et-neutra" };
const COR_GRAVIDADE: Record<Gravidade, string> = { leve: "et-neutra", moderada: "et-laranja", grave: "et-vermelha" };

export function EtiquetaNc({ situacao }: { situacao: SituacaoNc }) {
  return <span className={`etiqueta ${COR_SITUACAO[situacao]}`}>{ROTULO_SITUACAO_NC[situacao]}</span>;
}
export function EtiquetaGravidade({ g }: { g: Gravidade }) {
  return <span className={`etiqueta ${COR_GRAVIDADE[g]}`}>{ROTULO_GRAVIDADE[g]}</span>;
}

export function TabelaNcs({ ncs, obra }: { ncs: (NaoConformidade & { obraCodigo?: string; obraNome?: string })[]; obra?: boolean }) {
  if (!ncs.length) return <div className="cartao vazio"><b>Nenhuma não conformidade</b></div>;
  return (
    <div className="tabela-caixa">
      <table className="tabela tabela-compacta">
        <thead><tr><th>NC</th>{obra && <th>Obra</th>}<th>Descrição</th><th>Gravidade</th><th>Situação</th><th>Responsável</th><th>Prazo</th><th>Origem</th></tr></thead>
        <tbody>
          {ncs.map((n) => (
            <tr key={n.id} className={`${n.vencida ? "linha-vencida" : ""} ${n.situacao === "cancelada" ? "linha-apagada" : ""}`}>
              <td><Link href={`/nao-conformidades/${n.id}`} className="forte sem-quebra num">{rotuloNc(n)}</Link></td>
              {obra && <td><Link href={`/obras/${n.obraId}/${n.area}`}>{n.obraNome}</Link><div className="fraco num">{n.obraCodigo}</div></td>}
              <td style={{ minWidth: 220 }}>
                <b>{n.titulo}</b>
                <div className="fraco">{[n.local, n.itemNumero ? `item ${n.itemNumero}` : null].filter(Boolean).join(" · ")}</div>
                {n.impeditiva && (n.situacao === "aberta" || n.situacao === "corrigida") && <span className="etiqueta et-vermelha etiqueta-mini">Trava a medição</span>}
              </td>
              <td><EtiquetaGravidade g={n.gravidade} /></td>
              <td><EtiquetaNc situacao={n.situacao} /></td>
              <td>{n.responsavel}</td>
              <td className="num sem-quebra">{dataCurta(n.prazo)}{n.vencida && <div><span className="etiqueta et-vermelha etiqueta-mini">Vencido</span></div>}</td>
              <td className="fraco">{ROTULO_ORIGEM_NC[n.origem]}{n.inspecaoNumero ? ` nº ${n.inspecaoNumero}` : n.ensaioNumero ? ` nº ${n.ensaioNumero}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NovaNc({ obraId, area, itens, hoje }: { obraId: string; area: Area; itens: ItemObra[]; hoje: string }) {
  return (
    <details className="detalhe-acao">
      <summary>Abrir não conformidade</summary>
      <FormAcao acao={acaoAbrirNc.bind(null, obraId, area)} className="grade-form" style={{ marginTop: 10 }}>
        <div className="campo c8"><label htmlFor="nc-t">Título</label><input id="nc-t" name="titulo" className="entrada-texto" required /></div>
        <div className="campo c4"><label htmlFor="nc-g">Gravidade</label>
          <select id="nc-g" name="gravidade" className="entrada-texto" defaultValue="moderada">
            {(["leve", "moderada", "grave"] as Gravidade[]).map((g) => <option key={g} value={g}>{ROTULO_GRAVIDADE[g]} · prazo de {PRAZO_PADRAO[g]} dias</option>)}
          </select></div>
        <div className="campo c12"><label htmlFor="nc-d">Descrição</label><textarea id="nc-d" name="descricao" className="entrada-texto" rows={3} required /></div>
        <div className="campo c6"><label htmlFor="nc-l">Local</label><input id="nc-l" name="local" className="entrada-texto" placeholder="Bloco, pavimento, eixo, estaca" /></div>
        <div className="campo c6"><label htmlFor="nc-i">Item da planilha</label>
          <select id="nc-i" name="itemServicoId" className="entrada-texto" defaultValue="">
            <option value="">Sem item</option>
            {itens.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 70)}</option>)}
          </select></div>
        <div className="campo c6"><label htmlFor="nc-r">Responsável pela correção</label><input id="nc-r" name="responsavel" className="entrada-texto" required /></div>
        <div className="campo c3"><label htmlFor="nc-p">Prazo</label><input id="nc-p" name="prazo" type="date" min={hoje} className="entrada-texto" /></div>
        <div className="campo c3" style={{ justifyContent: "flex-end" }}>
          <label className="opcao-check"><input type="checkbox" name="impeditiva" value="sim" /> Impeditiva (trava a medição do item)</label>
        </div>
        <div className="c12 rodape-form"><BotaoEnviar enviando="Abrindo…"><Plus /> Abrir não conformidade</BotaoEnviar></div>
      </FormAcao>
    </details>
  );
}

export function ListaInspecoes({ inspecoes, obraId, area, podeRegistrar }: { inspecoes: Inspecao[]; obraId: string; area: Area; podeRegistrar: boolean }) {
  const modelos = MODELOS.filter((m) => m.area === area);
  return (
    <section className="cartao">
      <h2 className="cartao-titulo">Inspeções por checklist</h2>
      {podeRegistrar && (
        <div className="form-linha" style={{ marginTop: 10 }}>
          {modelos.map((m) => <Link key={m.chave} href={`/obras/${obraId}/qualidade/inspecao?modelo=${m.chave}`} className="botao botao-neutro botao-pequeno"><ClipboardCheck /> {m.titulo}</Link>)}
        </div>
      )}
      {inspecoes.length === 0 ? <p className="cartao-sub" style={{ marginTop: 10 }}>Nenhuma inspeção.</p> : (
        <div className="tabela-caixa" style={{ marginTop: 10 }}><table className="tabela tabela-compacta">
          <thead><tr><th>Nº</th><th>Checklist</th><th>Data</th><th className="dir">Conformidade</th><th className="dir">NCs</th></tr></thead>
          <tbody>
            {inspecoes.map((i) => {
              const tot = i.conformes + i.naoConformes;
              return (
                <tr key={i.id}>
                  <td><Link href={`/inspecoes/${i.id}`} className="forte num">{i.numero}</Link></td>
                  <td>{i.titulo}<div className="fraco">{i.local ?? ""}</div></td>
                  <td className="num">{dataCurta(i.data)}</td>
                  <td className="dir num"><span className={`etiqueta ${i.naoConformes ? "et-laranja" : "et-verde"}`}>{tot ? Math.round((i.conformes / tot) * 100) : 100}%</span></td>
                  <td className="dir num">{i.ncs || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
