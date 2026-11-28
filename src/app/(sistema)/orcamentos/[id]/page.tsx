import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, BrickWall, Check, CircleAlert, LayoutGrid, ListChecks, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { FotoOuIcone } from "@/componentes/IconeAssunto";
import { fotoDoServico } from "@/lib/fotos-obra";
import { pool } from "@/lib/db";
import { NavPassos, ResumoOrcamento } from "./ResumoOrcamento";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { mesAno, moeda, nomeLegivel, quantidade, unidadeMedida } from "@/lib/formato";
import { buscarComposicoes, buscarInsumos, ROTULO_FONTE, ROTULO_TIPO_INSUMO, type TipoInsumo } from "@/servicos/precos";
import { acaoAdicionarItem, acaoEtapa, acaoLinhaItem, acaoMoverEtapa, acaoMoverItem, acaoNovaEtapa } from "../acoes";
import { carregarOrcamento } from "./carregar";

export const metadata: Metadata = { title: "Orçamento" };

type Busca = { incluir?: string; busca?: string; etapa?: string; tipo?: string };

export default async function Planilha({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Busca> }) {
  const { id } = await params;
  const q = await searchParams;
  const { ator, orcamento: o, editavel } = await carregarOrcamento(id);
  const incluir = editavel && o.etapas.length ? (q.incluir as "composicao" | "insumo" | "cotacao" | undefined) : undefined;
  const etapaPadrao = q.etapa && o.etapas.some((e) => e.id === q.etapa) ? q.etapa : o.etapas.at(-1)?.id;

  const resultadosComp = incluir === "composicao" && q.busca ? await buscarComposicoes(ator, { tabelaId: o.tabelaId, busca: q.busca, regra: o.arredondamento }) : [];
  const resultadosIns = incluir === "insumo" && q.busca ? await buscarInsumos(ator, { tabelaId: o.tabelaId, busca: q.busca, tipo: (q.tipo || "") as TipoInsumo | "" }) : [];
  const linkIncluir = (modo: string) => `/orcamentos/${id}?incluir=${modo}${etapaPadrao ? `&etapa=${etapaPadrao}` : ""}`;

  const seletorEtapa = (
    <select name="etapaId" className="entrada-texto" defaultValue={etapaPadrao} aria-label="Etapa" style={{ height: 36, fontSize: 13 }}>
      {o.etapas.map((e) => <option key={e.id} value={e.id}>{e.ordem}. {e.nome}</option>)}
    </select>
  );

  const icones = await iconesDosAssuntos();
  return (
    <div className="assistente">
    <div className="assistente-principal">
      {o.pendencias.length > 0 && o.situacao === "rascunho" && (
        <div className="aviso aviso-info surgir"><CircleAlert /><span>Para aprovar: {o.pendencias.join(" ")}</span></div>
      )}

      {editavel && (
        <div className="barra-acoes surgir">
          {o.etapas.length > 0 && (
            <>
              <Link href={`/orcamentos/${id}/montar`} className="botao botao-primario"><LayoutGrid /> Incluir serviços</Link>
              <Link href={linkIncluir("composicao")} className="botao botao-neutro"><Search /> Busca rápida</Link>
              <Link href={`/orcamentos/${id}/muro`} className="botao botao-neutro"><BrickWall /> Assistente de muro</Link>
            </>
          )}
          <FormAcao acao={acaoNovaEtapa.bind(null, id)} className="form-linha" mostrarOk={false} limpar>
            <input name="nome" className="entrada-texto" placeholder={o.etapas.length ? "Nova etapa" : "Nome da primeira etapa"} aria-label="Nome da etapa" required style={{ height: 42, width: 220 }} />
            <BotaoEnviar className="botao botao-neutro" enviando="Criando…"><Plus /> Etapa</BotaoEnviar>
          </FormAcao>
        </div>
      )}

      {incluir && (
        <section className="cartao surgir">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            <h2 className="cartao-titulo">Incluir item</h2>
            <div className="chips">
              <Link href={linkIncluir("composicao")} className={`chip ${incluir === "composicao" ? "chip-ativo" : ""}`}>Por serviço</Link>
              <Link href={linkIncluir("insumo")} className={`chip ${incluir === "insumo" ? "chip-ativo" : ""}`}>Por material</Link>
              <Link href={linkIncluir("cotacao")} className={`chip ${incluir === "cotacao" ? "chip-ativo" : ""}`}>Por cotação</Link>
              <Link href={`/orcamentos/${id}`} className="chip">Fechar</Link>
            </div>
          </div>

          {incluir !== "cotacao" && (
            <form className="form-linha" action={`/orcamentos/${id}`}>
              <input type="hidden" name="incluir" value={incluir} />
              {etapaPadrao && <input type="hidden" name="etapa" value={etapaPadrao} />}
              <div className="busca-campo">
                <Search />
                <input name="busca" type="search" defaultValue={q.busca} autoFocus placeholder={incluir === "composicao" ? "Código ou descrição do serviço" : "Código ou descrição do material"} aria-label="Buscar" />
              </div>
              {incluir === "insumo" && (
                <select name="tipo" className="entrada-texto" defaultValue={q.tipo ?? ""} aria-label="Tipo" style={{ width: 170 }}>
                  <option value="">Todos os tipos</option>
                  {(Object.keys(ROTULO_TIPO_INSUMO) as TipoInsumo[]).map((t) => <option key={t} value={t}>{ROTULO_TIPO_INSUMO[t]}</option>)}
                </select>
              )}
              <button className="botao botao-neutro">Buscar</button>
            </form>
          )}

          {incluir === "composicao" && q.busca && (
            resultadosComp.length === 0 ? <p className="cartao-sub" style={{ marginTop: 12 }}>Nenhum serviço encontrado.</p> : (
              <div className="lista-resultados">
                {resultadosComp.map((k) => (
                  <div key={k.id} className="resultado">
                    <div className="resultado-texto">
                      <span className="fraco num">{ROTULO_FONTE[k.fonte]} {k.codigo} · {unidadeMedida(k.unidade)}{!k.aprovada && " · aguardando aprovação"}</span>
                      <Link href={`/precos/composicoes/${k.id}?tabela=${o.tabelaId}`} className="forte">{k.descricao}</Link>
                    </div>
                    <b className="num resultado-preco">{k.custo ? moeda(k.custo) : <span className="etiqueta et-vermelha">Sem preço</span>}</b>
                    <FormAcao acao={acaoAdicionarItem.bind(null, id)} className="form-linha" mostrarOk={false}>
                      <input type="hidden" name="tipo" value="composicao" />
                      <input type="hidden" name="refId" value={k.id} />
                      {seletorEtapa}
                      <input name="quantidade" className="entrada-texto num" inputMode="decimal" placeholder={`Qtd. (${unidadeMedida(k.unidade)})`} aria-label="Quantidade" required style={{ width: 110, height: 36 }} />
                      <BotaoEnviar className="botao botao-primario botao-pequeno" enviando="…" ariaLabel={`Incluir ${k.codigo}`}><Plus /></BotaoEnviar>
                    </FormAcao>
                  </div>
                ))}
              </div>
            )
          )}

          {incluir === "insumo" && q.busca && (
            resultadosIns.length === 0 ? <p className="cartao-sub" style={{ marginTop: 12 }}>Nenhum material encontrado.</p> : (
              <div className="lista-resultados">
                {resultadosIns.map((i) => (
                  <div key={i.id} className="resultado">
                    <div className="resultado-texto">
                      <span className="fraco num">{ROTULO_FONTE[i.fonte]} {i.codigo} · {unidadeMedida(i.unidade)} · {ROTULO_TIPO_INSUMO[i.tipo]}</span>
                      <Link href={`/precos/insumos/${i.id}`} className="forte">{i.descricao}</Link>
                    </div>
                    <b className="num resultado-preco">{i.preco ? moeda(i.preco) : <span className="etiqueta et-vermelha">Sem preço</span>}</b>
                    <FormAcao acao={acaoAdicionarItem.bind(null, id)} className="form-linha" mostrarOk={false}>
                      <input type="hidden" name="tipo" value="insumo" />
                      <input type="hidden" name="refId" value={i.id} />
                      {seletorEtapa}
                      <input name="quantidade" className="entrada-texto num" inputMode="decimal" placeholder={`Qtd. (${unidadeMedida(i.unidade)})`} aria-label="Quantidade" required style={{ width: 110, height: 36 }} />
                      <BotaoEnviar className="botao botao-primario botao-pequeno" enviando="…" ariaLabel={`Incluir ${i.codigo}`}><Plus /></BotaoEnviar>
                    </FormAcao>
                  </div>
                ))}
              </div>
            )
          )}

          {incluir === "cotacao" && (
            <FormAcao acao={acaoAdicionarItem.bind(null, id)} className="grade-form" limpar>
              <input type="hidden" name="tipo" value="cotacao" />
              <div className="campo c8"><label htmlFor="descricao">Descrição</label><input id="descricao" name="descricao" className="entrada-texto" required /></div>
              <div className="campo c2"><label htmlFor="unidade">Unidade</label><input id="unidade" name="unidade" className="entrada-texto" required placeholder="UN" /></div>
              <div className="campo c2"><label htmlFor="qtdc">Quantidade</label><input id="qtdc" name="quantidade" className="entrada-texto num" inputMode="decimal" required /></div>
              <div className="campo c4"><label htmlFor="etapac">Etapa</label>
                <select id="etapac" name="etapaId" className="entrada-texto" defaultValue={etapaPadrao}>{o.etapas.map((e) => <option key={e.id} value={e.id}>{e.ordem}. {e.nome}</option>)}</select>
              </div>
              <div className="campo c4"><label htmlFor="tipoInsumo">Tipo</label>
                <select id="tipoInsumo" name="tipoInsumo" className="entrada-texto" defaultValue="material">
                  {(Object.keys(ROTULO_TIPO_INSUMO) as TipoInsumo[]).map((t) => <option key={t} value={t}>{ROTULO_TIPO_INSUMO[t]}</option>)}
                </select>
              </div>
              <div className="campo c4"><label htmlFor="criterio">Preço adotado</label>
                <select id="criterio" name="criterio" className="entrada-texto" defaultValue="mediana">
                  <option value="mediana">Mediana das cotações</option><option value="media">Média das cotações</option><option value="menor">Menor cotação</option>
                </select>
              </div>
              <div className="campo c12"><label htmlFor="justificativa">Justificativa</label><input id="justificativa" name="justificativa" className="entrada-texto" required placeholder="Motivo de o item não estar na base oficial" /></div>
              <div className="c12"><BotaoEnviar enviando="Incluindo…"><Plus /> Incluir e registrar cotações</BotaoEnviar></div>
            </FormAcao>
          )}
        </section>
      )}

      {o.etapas.length === 0 ? (
        <div className="cartao vazio"><b>Nenhum serviço ainda</b>{editavel ? <>Use <Link href={`/orcamentos/${id}/montar`} className="botao-texto">Incluir serviços</Link> para escolher pelo assunto ou pela busca.</> : null}</div>
      ) : (
        <section className="cartao revisao">
          <div className="passo-cabecalho">
            <span className="passo-icone"><ListChecks /></span>
            <div style={{ flex: 1 }}>
              <h2 className="cartao-titulo">Revisão do orçamento</h2>
              <p className="cartao-sub">Confira os serviços por etapa, ajuste as quantidades e organize a ordem. O preço já inclui o BDI.</p>
            </div>
          </div>
          {o.etapas.map((e, n) => (
            <details key={e.id} className="rev-etapa" open>
              <summary className="rev-etapa-cabecalho">
                <span className="etapa-numero num">{e.ordem}</span>
                <b className="rev-etapa-nome">{e.nome}</b>
                <span className="fraco num">{e.itens.length} {e.itens.length === 1 ? "serviço" : "serviços"}</span>
                <span className="rev-etapa-total num">{moeda(e.totais.total)}</span>
              </summary>
              {editavel && (
                <div className="rev-etapa-acoes">
                  <FormAcao acao={acaoEtapa.bind(null, id, e.id)} className="form-linha" mostrarOk={false}>
                    <input name="nome" defaultValue={e.nome} className="entrada-texto" aria-label="Nome da etapa" required style={{ height: 32, width: 240, fontSize: 13 }} />
                    <BotaoEnviar className="botao botao-texto botao-pequeno" enviando="…" title="Renomear etapa"><Pencil /> Renomear</BotaoEnviar>
                    {e.itens.length === 0 && <BotaoEnviar className="botao botao-texto botao-pequeno" name="acao" value="remover" title="Excluir etapa" confirmar="Excluir esta etapa vazia?"><Trash2 /> Excluir etapa</BotaoEnviar>}
                  </FormAcao>
                  {o.etapas.length > 1 && (
                    <span className="mover">
                      {n > 0 && <FormAcao acao={acaoMoverEtapa.bind(null, id, e.id)} mostrarOk={false}><input type="hidden" name="sentido" value="subir" /><BotaoEnviar className="botao botao-texto botao-pequeno" title="Subir etapa"><ArrowUp /> Subir</BotaoEnviar></FormAcao>}
                      {n < o.etapas.length - 1 && <FormAcao acao={acaoMoverEtapa.bind(null, id, e.id)} mostrarOk={false}><input type="hidden" name="sentido" value="descer" /><BotaoEnviar className="botao botao-texto botao-pequeno" title="Descer etapa"><ArrowDown /> Descer</BotaoEnviar></FormAcao>}
                    </span>
                  )}
                </div>
              )}
              {e.itens.length === 0 ? (
                <p className="cartao-sub" style={{ padding: "4px 14px 12px" }}>Etapa sem serviços.</p>
              ) : e.itens.map((i, k) => (
                <div key={i.id} id={`item-${i.id}`} className="rev-item">
                  <FotoOuIcone className="rev-icone" src={fotoDoServico(i.descricao, i.assuntoId)} icone={(i.assuntoId && icones.get(i.assuntoId)) || "Layers"} alt="" />
                  <div className="rev-texto">
                    <Link href={`/orcamentos/${id}/itens/${i.id}`} className="rev-nome" title={i.descricao}>{i.numero} · {nomeLegivel(i.descricao)}</Link>
                    <span className="fraco num">
                      {i.fonte === "cotacao" ? "Cotação" : `${ROTULO_FONTE[i.fonte]} | ${i.codigo}`}
                      {i.baseMes && i.baseMes !== o.mes && ` · data-base ${mesAno(i.baseMes)}`} · Unidade: {unidadeMedida(i.unidade)}
                    </span>
                    <span>
                      {i.semPreco && <span className="etiqueta et-vermelha">Sem preço</span>}
                      {i.tipoBdi === "fornecimento" && <span className="etiqueta et-roxa">BDI fornecimento</span>}
                      {i.memoria && <span className="fraco rev-memoria">{i.memoria}</span>}
                    </span>
                  </div>
                  {editavel ? (
                    <FormAcao acao={acaoLinhaItem.bind(null, id, i.id)} className="rev-qtd" mostrarOk={false}>
                      <label htmlFor={`q-${i.id}`}>Quantidade</label>
                      <span className="form-linha">
                        <input id={`q-${i.id}`} name="quantidade" className="entrada-texto num" inputMode="decimal" defaultValue={quantidade(i.quantidade)} required />
                        <BotaoEnviar className="botao botao-texto botao-pequeno" enviando="…" title="Salvar quantidade" ariaLabel={`Salvar quantidade do item ${i.numero}`}><Check /></BotaoEnviar>
                        <BotaoEnviar className="botao botao-texto botao-pequeno rev-excluir" name="acao" value="remover" title="Excluir item" ariaLabel={`Excluir item ${i.numero}`} confirmar="Excluir este item do orçamento?"><Trash2 /></BotaoEnviar>
                      </span>
                    </FormAcao>
                  ) : (
                    <div className="rev-qtd"><label>Quantidade</label><b className="num">{quantidade(i.quantidade)}</b></div>
                  )}
                  <div className="rev-valor"><label>Valor unitário (com BDI)</label><b className="num">{i.semPreco ? "—" : moeda(i.precoUnitario)}</b></div>
                  <div className="rev-valor"><label>Total</label><b className="num rev-total">{i.semPreco ? "—" : moeda(i.total)}</b></div>
                  {editavel && (e.itens.length > 1 || o.etapas.length > 1) && (
                    <div className="rev-organizar">
                      {k > 0 && <FormAcao acao={acaoMoverItem.bind(null, id, i.id)} mostrarOk={false}><input type="hidden" name="sentido" value="subir" /><BotaoEnviar className="botao botao-texto botao-pequeno" ariaLabel={`Subir item ${i.numero}`} title="Subir"><ArrowUp /></BotaoEnviar></FormAcao>}
                      {k < e.itens.length - 1 && <FormAcao acao={acaoMoverItem.bind(null, id, i.id)} mostrarOk={false}><input type="hidden" name="sentido" value="descer" /><BotaoEnviar className="botao botao-texto botao-pequeno" ariaLabel={`Descer item ${i.numero}`} title="Descer"><ArrowDown /></BotaoEnviar></FormAcao>}
                      {o.etapas.length > 1 && (
                        <FormAcao acao={acaoMoverItem.bind(null, id, i.id)} mostrarOk={false} className="form-linha">
                          <select name="etapaId" className="entrada-texto" defaultValue={e.id} aria-label={`Mover item ${i.numero} para a etapa`}>
                            {o.etapas.map((x) => <option key={x.id} value={x.id}>Etapa {x.ordem}. {x.nome}</option>)}
                          </select>
                          <BotaoEnviar className="botao botao-texto botao-pequeno" title="Mover para a etapa escolhida">Mover</BotaoEnviar>
                        </FormAcao>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </details>
          ))}
        </section>
      )}
      <NavPassos voltar={editavel ? `/orcamentos/${id}/montar` : undefined} proximo={`/orcamentos/${id}/planilhas`} rotuloProximo="Ver resultado" />
    </div>
    <ResumoOrcamento o={o} detalhe={false} />
    </div>
  );
}

/** Ícone de cada assunto, para identificar os itens na revisão. */
async function iconesDosAssuntos() {
  const r = await pool().query("select id, icone from assunto");
  return new Map<string, string>(r.rows.map((l) => [l.id, l.icone]));
}
