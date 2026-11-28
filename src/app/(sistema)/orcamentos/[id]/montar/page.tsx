import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Calculator, ChevronRight, CircleCheck, LayoutGrid, Package, Plus, Search, SearchCode, Zap } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { FotoOuIcone } from "@/componentes/IconeAssunto";
import { fotoDoAssunto, fotoDoServico, fotoTela } from "@/lib/fotos-obra";
import { mesAno, moeda, nomeLegivel, resumir, unidadeMedida } from "@/lib/formato";
import { buscarMateriais, buscarServicos, fichaDoServico, gruposDoAssunto, listarAssuntos, type ServicoComCusto } from "@/servicos/assistente";
import { basesDisponiveis } from "@/servicos/orcamentos";
import { pacoteDoAssunto } from "@/servicos/pacotes";
import { ROTULO_FONTE, ROTULO_REGIME, ROTULO_TIPO_INSUMO, type TipoInsumo } from "@/servicos/precos";
import { acaoIncluirDoAssistente, acaoMontagem } from "../../acoes";
import { carregarOrcamento } from "../carregar";
import { NavPassos, ResumoOrcamento } from "../ResumoOrcamento";
import { FichaServico } from "./FichaServico";
import { PacoteAssunto } from "./PacoteAssunto";

export const metadata: Metadata = { title: "Montar orçamento" };

type Busca = { calc?: string; escolher?: string; assunto?: string; grupo?: string; busca?: string; servico?: string; tabela?: string; ver?: string; tipo?: string; medidas?: string };

export default async function Montar({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Busca> }) {
  const { id } = await params;
  const q = await searchParams;
  const { ator, orcamento: o, editavel } = await carregarOrcamento(id);
  const base = `/orcamentos/${id}/montar`;

  if (!editavel) {
    return <div className="cartao vazio"><b>Orçamento fechado</b>Este orçamento não está em elaboração. Para alterar, crie uma nova versão.</div>;
  }

  const bases = await basesDisponiveis(ator, id);
  const escolhidas = bases.filter((b) => b.escolhida);
  const tabelaIds = escolhidas.map((b) => b.tabelaId);

  // Passo 2: como montar e quais bases usar.
  if (!o.modoMontagem || q.escolher) {
    return (
      <div className="assistente">
        <FormAcao acao={acaoMontagem.bind(null, id)} className="assistente-principal" mostrarOk={false}>
          <section className="cartao">
            <div className="passo-cabecalho">
              <span className="passo-icone"><LayoutGrid /></span>
              <div><h2 className="cartao-titulo">Como montar o orçamento</h2><p className="cartao-sub">Escolha a forma que for mais fácil para você. As duas geram as mesmas planilhas.</p></div>
            </div>
            <div className="montar-modos">
              <label className="modo-cartao">
                <input type="radio" name="modo" value="assunto" defaultChecked={o.modoMontagem !== "livre"} required />
                <FotoOuIcone className="modo-foto" src={fotoTela("modo-assunto")} icone="House" alt="Edificação em construção" />
                <span className="modo-texto">
                  <b>Por assunto</b>
                  <span>Você escolhe a parte da obra (alvenaria, pintura, instalações…) e vê só os serviços dela, organizados por tipo.</span>
                  <em><CircleCheck /> Ideal para obras completas</em>
                </span>
              </label>
              <label className="modo-cartao">
                <input type="radio" name="modo" value="livre" defaultChecked={o.modoMontagem === "livre"} />
                <FotoOuIcone className="modo-foto" src={fotoTela("modo-livre")} icone="ClipboardList" alt="Projeto com lupa e capacete" />
                <span className="modo-texto">
                  <b>Livre</b>
                  <span>Você procura qualquer serviço ou material pelo nome ou pelo código, misturando assuntos.</span>
                  <em><Zap /> Ideal para orçamentos pontuais</em>
                </span>
              </label>
            </div>
          </section>
          <section className="cartao">
            <h2 className="cartao-titulo">Bases de preços</h2>
            <p className="cartao-sub">A base principal define a data-base. Marque outras para usar serviços que a principal não tem.</p>
            <div className="montar-bases">
              {bases.map((b) => (
                <label key={b.tabelaId} className="base-opcao">
                  <input type="checkbox" name="base" value={b.tabelaId} defaultChecked={b.escolhida} disabled={b.principal} />
                  <span><b>{ROTULO_FONTE[b.fonte]}</b> {mesAno(b.mes)} · {ROTULO_REGIME[b.regime]}{b.principal && <em className="etiqueta et-azul">Principal</em>}</span>
                  {!b.principal && b.mes !== o.mes && <small>Data-base diferente da principal ({mesAno(o.mes)}).</small>}
                  {!b.principal && b.regime !== o.regime && <small>Regime diferente do principal.</small>}
                </label>
              ))}
              {bases.length === 1 && <p className="cartao-sub">Nenhuma outra base liberada para {o.uf}.</p>}
            </div>
          </section>
          <div className="nav-passos">
            <Link href={`/orcamentos/${id}/dados`} className="botao botao-neutro"><ArrowLeft /> Voltar</Link>
            <BotaoEnviar enviando="Salvando…">Próximo passo <ArrowRight /></BotaoEnviar>
          </div>
        </FormAcao>
        <ResumoOrcamento o={o} />
      </div>
    );
  }

  // Passo 3: serviços.
  const porAssunto = o.modoMontagem === "assunto";
  const assuntos = porAssunto ? await listarAssuntos(ator, tabelaIds) : [];
  const comServicos = assuntos.filter((s) => s.servicos > 0);
  const assunto = comServicos.find((s) => s.id === q.assunto) ?? null;
  const grupos = assunto ? await gruposDoAssunto(ator, assunto.id, tabelaIds) : [];
  const grupo = grupos.find((g) => g.chave === q.grupo) ?? null;
  const pacote = pacoteDoAssunto(assunto?.id);
  const verMateriais = !porAssunto && q.ver === "materiais";
  const termo = q.busca?.trim() ?? "";
  // Por assunto: os cartões aparecem ao escolher o tipo de serviço ou ao procurar. Assunto com um tipo só já mostra os serviços.
  const listarServicos = porAssunto ? !!assunto && (!!grupo || !!termo || grupos.length <= 1) : !!termo && !verMateriais;
  const servicos: ServicoComCusto[] = listarServicos
    ? await buscarServicos(ator, { tabelaIds, assuntoId: assunto?.id, grupo: grupo?.chave, busca: termo, regra: o.arredondamento, limite: 48 })
    : [];
  const materiais = verMateriais && termo ? await buscarMateriais(ator, { tabelaIds, busca: termo, tipo: (q.tipo || "") as TipoInsumo | "", limite: 48 }) : [];
  const ficha = q.servico && q.tabela && tabelaIds.includes(q.tabela) ? await fichaDoServico(ator, q.servico, q.tabela).catch(() => null) : null;
  const baseFicha = ficha ? escolhidas.find((b) => b.tabelaId === q.tabela) ?? null : null;

  const link = (mudar: Partial<Busca>) => {
    const p = new URLSearchParams();
    const v: Partial<Busca> = { assunto: q.assunto, grupo: q.grupo, busca: q.busca, ver: q.ver, tipo: q.tipo, ...mudar };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const linkFicha = (k: { id: string; tabelaId: string }) => { const l = link({}); return `${l}${l.includes("?") ? "&" : "?"}servico=${k.id}&tabela=${k.tabelaId}`; };
  const nomeEtapa = ficha?.assunto?.nome ?? assunto?.nome ?? "Serviços";
  const etapaDoNome = o.etapas.find((e) => e.nome.toLowerCase() === nomeEtapa.toLowerCase());
  const etapaPadrao = etapaDoNome?.id ?? (!porAssunto && o.etapas.length ? o.etapas.at(-1)!.id : "nova");
  const icone = (assuntoId: string | null | undefined) => assuntos.find((s) => s.id === assuntoId)?.icone ?? "Layers";

  return (
    <div className="assistente">
      <div className="assistente-principal">
        {ficha && baseFicha && (
          <FichaServico orcamentoId={id} ficha={ficha} tabelaId={q.tabela!} icone={icone(ficha.assunto?.id ?? assunto?.id)} fechar={link({})}
            base={baseFicha} principal={{ mes: o.mes, regime: o.regime }} etapas={o.etapas} etapaPadrao={etapaPadrao}
            nomeEtapaNova={nomeEtapa} assuntoId={ficha.assunto?.id ?? assunto?.id ?? null} />
        )}

        <section className="cartao servicos-quadro">
          <div className="passo-cabecalho">
            <span className="passo-icone"><Package /></span>
            <div style={{ flex: 1 }}>
              <h2 className="cartao-titulo">Selecione os serviços</h2>
              <p className="cartao-sub">{porAssunto ? "Escolha o assunto à esquerda, depois o tipo de serviço. Clique em Selecionar para ver a ficha e informar a quantidade." : "Procure pelo nome ou pelo código. Clique em Selecionar para ver a ficha e informar a quantidade."}</p>
            </div>
            <Link href={`${base}?escolher=1`} className="botao botao-texto botao-pequeno">Trocar forma ou bases</Link>
          </div>

          <div className={porAssunto ? "servicos-colunas" : ""}>
            {porAssunto && (
              <nav className="assuntos-coluna" aria-label="Assuntos">
                <form action={base} className="busca-campo">
                  <Search />
                  {assunto && <input type="hidden" name="assunto" value={assunto.id} />}
                  <input name="busca" type="search" defaultValue={q.busca} placeholder={assunto ? `Buscar em ${assunto.nome.toLowerCase()}` : "Buscar por descrição ou código"} aria-label="Buscar" />
                </form>
                <ul>
                  {comServicos.map((s) => (
                    <li key={s.id}>
                      <Link href={link({ assunto: s.id, grupo: undefined, busca: undefined, calc: undefined })} className={s.id === assunto?.id ? "assunto-ativo" : ""} aria-current={s.id === assunto?.id ? "true" : undefined}>
                        <FotoOuIcone className="assunto-miniatura" src={fotoDoAssunto(s.id)} icone={s.icone} alt="" />
                        <span>{s.nome}</span>
                        <small className="num">{s.servicos.toLocaleString("pt-BR")}</small>
                      </Link>
                    </li>
                  ))}
                </ul>
                {comServicos.length === 0 && <p className="cartao-sub">As bases escolhidas ainda não têm serviços ligados aos assuntos.</p>}
              </nav>
            )}

            <div className="servicos-area">
              {porAssunto && !assunto && !termo && (
                <div className="vazio-guia">
                  <LayoutGrid />
                  <b>Comece escolhendo um assunto</b>
                  <span>Os assuntos seguem a ordem da obra: do canteiro à limpeza final. Cada um mostra só os serviços daquela parte.</span>
                </div>
              )}

              {porAssunto && !assunto && termo && (
                <p className="cartao-sub">Escolha um assunto à esquerda para procurar dentro dele, ou use a montagem livre para procurar em tudo.</p>
              )}

              {assunto && (
                <>
                  <div className="assunto-cabecalho">
                    <FotoOuIcone className="assunto-foto" src={fotoDoAssunto(assunto.id)} icone={assunto.icone} alt={assunto.nome} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h3>{assunto.nome}</h3>
                      <p className="cartao-sub">{assunto.resumo}</p>
                    </div>
                  </div>

                  {pacote && (
                    <details className="pacote-caixa" open={q.calc === "1" || q.medidas === "1"}>
                      <summary><Calculator /> Calcular pelas medidas <small>{pacote.resumo}</small></summary>
                      <PacoteAssunto ator={ator} orcamentoId={id} pacote={pacote} assuntoId={assunto.id} assuntoNome={assunto.nome} regra={o.arredondamento}
                        bases={escolhidas} etapas={o.etapas} valores={q as Record<string, string | undefined>} acaoGet={base} />
                    </details>
                  )}
                  {assunto.id === "alvenaria" && (
                    <p className="cartao-sub">Muro de divisa? O <Link href={`/orcamentos/${id}/muro`} className="botao-texto">assistente de muro</Link> calcula fundação, pilaretes, alvenaria e revestimento juntos.</p>
                  )}

                  {(grupo || termo) && grupos.length > 1 && (
                    <div className="trilha">
                      <Link href={link({ grupo: undefined, busca: undefined })}>{assunto.nome}</Link>
                      <ChevronRight />
                      <span>{grupo ? grupo.nome : `Busca: “${termo}”`}</span>
                    </div>
                  )}

                  {!grupo && !termo && grupos.length > 1 && (
                    <>
                      <h4 className="lista-titulo">Tipos de serviço</h4>
                      <div className="tipos-grade">
                        {grupos.map((g) => (
                          <Link key={g.chave} href={link({ grupo: g.chave })} className="tipo-cartao">
                            <FotoOuIcone className="tipo-foto" src={fotoDoServico(g.nome, assunto.id)} icone={assunto.icone} alt="" />
                            <b>{g.nome}</b>
                            <small>{ROTULO_FONTE[g.fonte]}{g.caminho ? ` · ${resumir(g.caminho, 60)}` : ""}</small>
                            <span className="num">{g.servicos.toLocaleString("pt-BR")} {g.servicos === 1 ? "serviço" : "serviços"} <ChevronRight /></span>
                          </Link>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}

              {!porAssunto && (
                <>
                  <div className="chips" style={{ marginBottom: 12 }}>
                    <Link href={link({ ver: undefined, tipo: undefined })} className={`chip ${!verMateriais ? "chip-ativo" : ""}`}>Serviços</Link>
                    <Link href={link({ ver: "materiais" })} className={`chip ${verMateriais ? "chip-ativo" : ""}`}>Materiais e insumos</Link>
                    <Link href={`/orcamentos/${id}?incluir=cotacao`} className="chip">Item por cotação</Link>
                  </div>
                  <form className="form-linha" action={base}>
                    {q.ver && <input type="hidden" name="ver" value={q.ver} />}
                    <div className="busca-campo">
                      <Search />
                      <input name="busca" type="search" defaultValue={q.busca} autoFocus={!ficha} placeholder={verMateriais ? "Nome ou código do material" : "Nome ou código do serviço"} aria-label="Procurar" />
                    </div>
                    {verMateriais && (
                      <select name="tipo" className="entrada-texto" defaultValue={q.tipo ?? ""} aria-label="Tipo" style={{ width: 170 }}>
                        <option value="">Todos os tipos</option>
                        {(Object.keys(ROTULO_TIPO_INSUMO) as TipoInsumo[]).map((t) => <option key={t} value={t}>{ROTULO_TIPO_INSUMO[t]}</option>)}
                      </select>
                    )}
                    <button className="botao botao-neutro">Procurar</button>
                  </form>
                  {!termo && <div className="vazio-guia"><SearchCode /><b>Procure o que precisa</b><span>Ex.: “alvenaria bloco cerâmico”, “pintura acrílica” ou o código 103328. A busca olha todas as bases escolhidas.</span></div>}
                </>
              )}

              {listarServicos && (servicos.length === 0
                ? <p className="cartao-sub" style={{ marginTop: 12 }}>Nenhum serviço encontrado{termo ? ` para “${termo}”` : ""}.</p>
                : (
                  <div className="cartoes-servico">
                    {servicos.map((k) => {
                      const ativo = q.servico === k.id && q.tabela === k.tabelaId;
                      return (
                        <article key={`${k.id}-${k.tabelaId}`} className={`servico-cartao ${ativo ? "servico-ativo" : ""}`}>
                          <FotoOuIcone className="servico-foto" src={fotoDoServico(k.descricao, k.assuntoId ?? assunto?.id)} icone={icone(k.assuntoId ?? assunto?.id)} alt="" />
                          <b className="servico-nome" title={k.descricao}>{nomeLegivel(k.descricao)}</b>
                          <span className="servico-origem num">{ROTULO_FONTE[k.fonte]} | {k.codigo}<em>{unidadeMedida(k.unidade)}</em></span>
                          <span className="servico-valor num">{k.custo ? <>{moeda(k.custo)}<small> /{unidadeMedida(k.unidade)}</small></> : <span className="etiqueta et-vermelha">Sem preço</span>}</span>
                          <Link href={linkFicha(k)} className="botao botao-neutro botao-pequeno servico-selecionar"><Plus /> {ativo ? "Selecionado" : "Selecionar"}</Link>
                        </article>
                      );
                    })}
                  </div>
                ))}
              {listarServicos && servicos.length === 48 && <p className="cartao-sub">Mostrando os 48 primeiros. Refine a busca para ver outros.</p>}

              {verMateriais && termo && (materiais.length === 0 ? <p className="cartao-sub" style={{ marginTop: 12 }}>Nenhum material encontrado.</p> : (
                <div className="lista-resultados">
                  {materiais.map((i) => (
                    <div key={`${i.id}-${i.tabelaId}`} className="resultado">
                      <div className="resultado-texto">
                        <span className="forte">{nomeLegivel(i.descricao)}</span>
                        <span className="fraco num">{ROTULO_FONTE[i.fonte]} {i.codigo} · {mesAno(i.mes)} · {unidadeMedida(i.unidade)} · {ROTULO_TIPO_INSUMO[i.tipo]}</span>
                      </div>
                      <b className="num resultado-preco">{i.preco ? moeda(i.preco) : <span className="etiqueta et-vermelha">Sem preço</span>}</b>
                      <FormAcao acao={acaoIncluirDoAssistente.bind(null, id)} className="form-linha" mostrarOk={false}>
                        <input type="hidden" name="tipo" value="insumo" />
                        <input type="hidden" name="refId" value={i.id} />
                        <input type="hidden" name="tabelaId" value={i.tabelaId} />
                        <input type="hidden" name="novaEtapa" value="Materiais" />
                        <select name="etapaId" className="entrada-texto" defaultValue={o.etapas.at(-1)?.id ?? "nova"} aria-label="Etapa" style={{ height: 36, fontSize: 13, maxWidth: 180 }}>
                          {o.etapas.map((e) => <option key={e.id} value={e.id}>{e.ordem}. {e.nome}</option>)}
                          <option value="nova">Nova etapa: Materiais</option>
                        </select>
                        <input name="quantidade" className="entrada-texto num" inputMode="decimal" placeholder={`Qtd. (${unidadeMedida(i.unidade)})`} aria-label="Quantidade" required style={{ width: 110, height: 36 }} />
                        <BotaoEnviar className="botao botao-primario botao-pequeno" enviando="…" ariaLabel={`Incluir ${i.codigo}`}><Plus /></BotaoEnviar>
                      </FormAcao>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
        <NavPassos voltar={`${base}?escolher=1`} proximo={`/orcamentos/${id}`} rotuloProximo="Revisar" />
      </div>
      <ResumoOrcamento o={o} />
    </div>
  );
}
