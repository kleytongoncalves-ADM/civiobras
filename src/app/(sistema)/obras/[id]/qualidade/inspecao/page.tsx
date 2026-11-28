import { resumir } from "@/lib/formato";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { obterObra } from "@/servicos/obras";
import { pode } from "@/servicos/permissoes";
import { modelo, painelQualidade, ROTULO_RESPOSTA, type Resposta } from "@/servicos/qualidade";
import { acaoInspecao } from "../../../../qualidade/acoes";

export const metadata: Metadata = { title: "Nova inspeção" };
const hoje = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const RESPOSTAS: Resposta[] = ["conforme", "nao_conforme", "nao_aplica"];

export default async function NovaInspecao({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ modelo?: string }> }) {
  const { id } = await params;
  const m = modelo((await searchParams).modelo ?? "");
  const a = comoAtor(await exigirUsuario());
  if (!m || !pode(a, m.area === "seguranca" ? "seguranca.registrar" : "qualidade.registrar")) notFound();
  const obra = await obterObra(a, id).catch(() => notFound());
  const p = await painelQualidade(a, id, m.area);
  const volta = `/obras/${id}/${m.area}`;

  return (
    <div className="grade" style={{ maxWidth: 920 }}>
      <div className="cabecalho">
        <div style={{ minWidth: 0 }}>
          <div className="sobretitulo"><Link href="/obras">Obras</Link><span>/</span><Link href={volta} className="num">{obra.codigo}</Link><span>/</span><span>{m.area === "seguranca" ? "Segurança" : "Qualidade"}</span></div>
          <h1 className="titulo">Inspeção · {m.titulo}</h1>
          <p className="subtitulo">{obra.nome}</p>
        </div>
        <Link href={volta} className="botao botao-neutro"><ArrowLeft /> Voltar</Link>
      </div>
      <FormAcao acao={acaoInspecao.bind(null, id, m.chave)} className="grade">
        <section className="cartao grade-form">
          <div className="campo c4"><label htmlFor="in-d">Data</label><input id="in-d" name="data" type="date" max={hoje()} defaultValue={hoje()} className="entrada-texto" required /></div>
          <div className="campo c8"><label htmlFor="in-l">Local</label><input id="in-l" name="local" className="entrada-texto" placeholder="Bloco, pavimento, frente de serviço" /></div>
          {m.area === "qualidade" && (
            <div className="campo c12"><label htmlFor="in-i">Item da planilha</label>
              <select id="in-i" name="itemServicoId" className="entrada-texto" defaultValue=""><option value="">Sem item</option>
                {p.itens.map((i) => <option key={i.id} value={i.id}>{i.numero} {resumir(i.descricao, 80)}</option>)}</select></div>
          )}
        </section>
        <section className="cartao">
          <h2 className="cartao-titulo">Checklist</h2>
          <ol className="checklist" style={{ marginTop: 12 }}>
            {m.itens.map((q, i) => (
              <li key={q}>
                <span><b className="num">{i + 1}.</b> {q}</span>
                <span className="respostas" role="radiogroup" aria-label={q}>
                  {RESPOSTAS.map((r) => (
                    <label key={r}><input type="radio" name={`r${i}`} value={r} required defaultChecked={r === "conforme"} /> {ROTULO_RESPOSTA[r]}</label>
                  ))}
                </span>
                <input name={`o${i}`} className="entrada-texto obs" placeholder="Observação" aria-label={`Observação do item ${i + 1}`} />
              </li>
            ))}
          </ol>
        </section>
        <section className="cartao grade-form">
          <div className="campo c12"><label htmlFor="in-o">Observações gerais</label><textarea id="in-o" name="observacao" className="entrada-texto" rows={2} /></div>
          <div className="campo c6" style={{ justifyContent: "flex-end" }}><label className="opcao-check"><input type="checkbox" name="abrirNcs" value="sim" defaultChecked /> Abrir não conformidade para cada item não conforme</label></div>
          <div className="campo c6"><label htmlFor="in-r">Responsável pelas correções</label><input id="in-r" name="responsavel" className="entrada-texto" placeholder="Contratada, encarregado" /></div>
          <div className="c12 rodape-form"><BotaoEnviar enviando="Registrando…"><ClipboardCheck /> Registrar inspeção</BotaoEnviar></div>
        </section>
      </FormAcao>
    </div>
  );
}
