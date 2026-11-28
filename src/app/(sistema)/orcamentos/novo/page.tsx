import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ClipboardList } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { mesAno } from "@/lib/formato";
import { comoAtor, exigirUsuario } from "@/lib/sessao";
import { ROTULO_TIPO_BDI, TIPOS_OBRA_BDI } from "@/servicos/calculo";
import { listarObras } from "@/servicos/obras";
import { pode } from "@/servicos/permissoes";
import { listarTabelas, ROTULO_FONTE, ROTULO_REGIME, type Fonte } from "@/servicos/precos";
import { acaoCriarOrcamento } from "../acoes";

export const metadata: Metadata = { title: "Novo orçamento" };

const PASSOS: [string, string][] = [["Identificação", "Dados do orçamento"], ["Como montar", "Escolha o método"], ["Serviços", "Selecione os itens"], ["Revisão", "Confira e organize"], ["Planilhas", "Veja e baixe"]];
const ORDEM_FONTES: Fonte[] = ["sinapi", "sicro", "sco", "demonstracao"];

/** Passo 1 do assistente: obra, nome, base de preços principal e regras do BDI. */
export default async function NovoOrcamento({ searchParams }: { searchParams: Promise<{ obra?: string }> }) {
  const { obra } = await searchParams;
  const ator = comoAtor(await exigirUsuario());
  if (!pode(ator, "orcamento.editar")) {
    return <div className="cartao vazio"><b>Seu perfil não elabora orçamentos</b>Quem pode: direção e engenheiro responsável.</div>;
  }
  const [obras, tabelas] = await Promise.all([listarObras(ator), listarTabelas(ator, { somenteLiberadas: true })]);
  const abertas = obras.filter((o) => !["concluida", "recebida_provisoriamente", "recebida_definitivamente", "cancelada"].includes(o.situacao));
  const fontes = ORDEM_FONTES.filter((f) => tabelas.some((t) => t.fonte === f));
  // A base mais recente do SINAPI vem marcada; é a referência mais usada em obra pública.
  const sugerida = tabelas.filter((t) => t.fonte === "sinapi").sort((a, b) => b.mes.localeCompare(a.mes))[0] ?? tabelas[0];

  return (
    <>
      <div className="cabecalho">
        <div>
          <div className="sobretitulo"><Link href="/orcamentos">Orçamentos</Link><span>/</span><span>Novo</span></div>
          <h1 className="titulo">Novo orçamento</h1>
        </div>
      </div>
      <ol className="passos" aria-label="Passos do orçamento">
        {PASSOS.map(([p, sub], i) => (
          <li key={p} className={i === 0 ? "passo-ativo" : ""}>
            <span className="passo-link" aria-current={i === 0 ? "step" : undefined}><span className="passo-numero">{i + 1}</span><span className="passo-rotulo"><b>{p}</b><small>{sub}</small></span></span>
          </li>
        ))}
      </ol>
      {abertas.length === 0 ? (
        <div className="cartao vazio"><b>Nenhuma obra disponível</b><Link href="/obras/nova" className="botao botao-texto">Cadastrar obra</Link></div>
      ) : tabelas.length === 0 ? (
        <div className="cartao vazio"><b>Nenhuma base de preços liberada</b><Link href="/precos" className="botao botao-texto">Ver base de preços</Link></div>
      ) : (
        <FormAcao acao={acaoCriarOrcamento} className="cartao" style={{ maxWidth: 900 }}>
          <div className="passo-cabecalho">
            <span className="passo-icone"><ClipboardList /></span>
            <div><h2 className="cartao-titulo">Identificação do orçamento</h2><p className="cartao-sub">Diga de qual obra é o orçamento e em qual base de preços ele será feito. Tudo isso pode ser ajustado depois em BDI e dados.</p></div>
          </div>
          <div className="grade-form">
            <div className="campo c12">
              <label htmlFor="obraId">Obra</label>
              <select id="obraId" name="obraId" className="entrada-texto" defaultValue={obra} required>
                {abertas.map((o) => <option key={o.id} value={o.id}>{o.codigo} · {o.nome}</option>)}
              </select>
            </div>
            <div className="campo c12">
              <label htmlFor="nome">Nome do orçamento</label>
              <input id="nome" name="nome" className="entrada-texto" required defaultValue="Orçamento básico" />
              <small className="ajuda">Exemplo: Orçamento básico, Projeto executivo, Reforma da cobertura.</small>
            </div>
            <div className="campo c12">
              <label htmlFor="tabelaId">Base de preços principal e data-base</label>
              <select id="tabelaId" name="tabelaId" className="entrada-texto" required defaultValue={sugerida?.id}>
                {fontes.map((f) => (
                  <optgroup key={f} label={ROTULO_FONTE[f]}>
                    {tabelas.filter((t) => t.fonte === f).map((t) => (
                      <option key={t.id} value={t.id}>{ROTULO_FONTE[t.fonte]} {t.uf} {mesAno(t.mes)}{t.fonte === "sinapi" ? ` · ${ROTULO_REGIME[t.regime]}` : ""}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <small className="ajuda">O BDI e as etapas seguem esta base. No próximo passo você pode somar serviços do SICRO e do SCO-Rio; cada item guarda a base e a data-base de onde veio.</small>
            </div>
            <div className="campo c6">
              <label htmlFor="tipoObraBdi">Tipo de obra (para o BDI)</label>
              <select id="tipoObraBdi" name="tipoObraBdi" className="entrada-texto" defaultValue="">
                <option value="">Conforme o cadastro da obra</option>
                {TIPOS_OBRA_BDI.filter((t) => t !== "fornecimento").map((t) => <option key={t} value={t}>{ROTULO_TIPO_BDI[t]}</option>)}
              </select>
              <small className="ajuda">O BDI começa com os valores de referência do Acórdão TCU 2.622/2013 para o tipo escolhido.</small>
            </div>
            <div className="campo c6">
              <label htmlFor="arredondamento">Casas decimais dos totais</label>
              <select id="arredondamento" name="arredondamento" className="entrada-texto" defaultValue="">
                <option value="">Padrão do órgão</option><option value="arredondar">Arredondar em 2 casas</option><option value="truncar">Truncar em 2 casas</option>
              </select>
            </div>
          </div>
          <div className="nav-passos">
            <Link href="/orcamentos" className="botao botao-neutro">Cancelar</Link>
            <BotaoEnviar enviando="Criando…">Próximo passo <ArrowRight /></BotaoEnviar>
          </div>
        </FormAcao>
      )}
    </>
  );
}
