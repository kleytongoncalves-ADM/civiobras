import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Boxes, Plus, Search } from "lucide-react";
import { BotaoEnviar, FormAcao } from "@/componentes/FormAcao";
import { ErroDeRegra } from "@/lib/db";
import { dataHora, moeda, quantidade, unidadeMedida, resumir } from "@/lib/formato";
import { medidaDaUnidade, obterLeituraIfc, ROTULO_MEDIDA, SEM_TIPO, UNIDADE_MEDIDA, type MedidaLancamento, type QuantitativoIfc } from "@/servicos/ifc";
import { buscarComposicoes, buscarInsumos, ROTULO_FONTE, ROTULO_TIPO_INSUMO } from "@/servicos/precos";
import { carregarOrcamento } from "../../carregar";
import { acaoLancarIfc } from "../acoes";

export const metadata: Metadata = { title: "Quantitativos do IFC" };

type Busca = { grupo?: string; incluir?: string; busca?: string };
const MEDIDAS: MedidaLancamento[] = ["area", "volume", "comprimento", "peso", "elementos"];
const casas: Record<MedidaLancamento, number> = { comprimento: 2, area: 2, volume: 3, peso: 1, elementos: 0 };

function Medida({ g, m }: { g: QuantitativoIfc; m: Exclude<MedidaLancamento, "elementos"> }) {
  const v = g[m];
  if (v == null) return <span className="fraco">—</span>;
  return <>{Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas[m], maximumFractionDigits: casas[m] })}{g.calculadas.includes(m) && <sup title="Calculado pela geometria do modelo">*</sup>}</>;
}

export default async function LeituraIfc({ params, searchParams }: { params: Promise<{ id: string; leituraId: string }>; searchParams: Promise<Busca> }) {
  const { id, leituraId } = await params;
  const q = await searchParams;
  const { ator, orcamento: o, editavel } = await carregarOrcamento(id);
  let l;
  try {
    l = await obterLeituraIfc(ator, leituraId);
  } catch (e) {
    if (e instanceof ErroDeRegra) notFound();
    throw e;
  }
  if (l.orcamentoId !== id) notFound();

  const grupo = editavel ? l.quantitativos.find((g) => g.id === q.grupo) : undefined;
  const incluir = q.incluir === "insumo" ? "insumo" : "composicao";
  const base = `/orcamentos/${id}/ifc/${leituraId}`;
  const linkGrupo = (gid: string, modo = incluir) => `${base}?grupo=${gid}&incluir=${modo}#lancar`;
  const resultados = grupo && q.busca
    ? incluir === "composicao"
      ? (await buscarComposicoes(ator, { tabelaId: o.tabelaId, busca: q.busca, regra: o.arredondamento, limite: 20 })).map((k) => ({ id: k.id, fonte: k.fonte, codigo: k.codigo, descricao: k.descricao, unidade: k.unidade, preco: k.custo, extra: k.aprovada ? null : "aguardando aprovação" }))
      : (await buscarInsumos(ator, { tabelaId: o.tabelaId, busca: q.busca, limite: 20 })).map((i) => ({ id: i.id, fonte: i.fonte, codigo: i.codigo, descricao: i.descricao, unidade: i.unidade, preco: i.preco, extra: ROTULO_TIPO_INSUMO[i.tipo] }))
    : [];
  const disponiveis = (g: QuantitativoIfc) => MEDIDAS.filter((m) => m === "elementos" || g[m] != null);
  const algumaCalculada = l.quantitativos.some((g) => g.calculadas.length);

  return (
    <div className="grade">
      <div className="barra-acoes surgir">
        <Link href={`/orcamentos/${id}/ifc`} className="botao botao-neutro"><ArrowLeft /> Arquivos IFC</Link>
        <div style={{ minWidth: 0 }}>
          <b>{l.arquivo}</b>
          <div className="fraco">{[l.projeto, l.aplicativo, l.schema].filter(Boolean).join(" · ")} · {l.elementos.toLocaleString("pt-BR")} elementos · lido em {dataHora(l.criadoEm)}{l.criadoPor ? ` por ${l.criadoPor}` : ""}</div>
        </div>
        {l.modelo3d && <Link href={`/orcamentos/${id}/3d`} className="botao botao-neutro" style={{ marginLeft: "auto" }}><Boxes /> Ver em 3D</Link>}
      </div>

      {l.avisos.length > 0 && <div className="aviso aviso-info"><span>{l.avisos.join(" ")}</span></div>}

      {grupo && (
        <section className="cartao surgir" id="lancar">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
            <h2 className="cartao-titulo">Lançar no orçamento</h2>
            <div className="chips">
              <Link href={linkGrupo(grupo.id, "composicao")} className={`chip ${incluir === "composicao" ? "chip-ativo" : ""}`}>Por serviço</Link>
              <Link href={linkGrupo(grupo.id, "insumo")} className={`chip ${incluir === "insumo" ? "chip-ativo" : ""}`}>Por material</Link>
              <Link href={base} className="chip">Fechar</Link>
            </div>
          </div>
          <p className="cartao-sub" style={{ marginBottom: 14 }}>
            <b>{grupo.rotulo}</b>{grupo.tipo !== SEM_TIPO ? ` · ${grupo.tipo}` : ""}{grupo.material ? ` · ${grupo.material}` : ""} · {grupo.elementos} {grupo.elementos === 1 ? "elemento" : "elementos"}
            {grupo.area != null && <> · área {quantidade(grupo.area)} m²</>}
            {grupo.volume != null && <> · volume {quantidade(grupo.volume)} m³</>}
            {grupo.comprimento != null && <> · comprimento {quantidade(grupo.comprimento)} m</>}
          </p>
          {o.etapas.length === 0 ? (
            <p className="cartao-sub">Crie uma etapa na <Link href={`/orcamentos/${id}`} className="link-item">Planilha</Link> antes de lançar.</p>
          ) : (
            <>
              <form className="form-linha" action={base}>
                <input type="hidden" name="grupo" value={grupo.id} />
                <input type="hidden" name="incluir" value={incluir} />
                <div className="busca-campo">
                  <Search />
                  <input name="busca" type="search" defaultValue={q.busca} autoFocus placeholder={incluir === "composicao" ? "Código ou descrição do serviço" : "Código ou descrição do material"} aria-label="Buscar" />
                </div>
                <button className="botao botao-neutro">Buscar</button>
              </form>
              {q.busca && (resultados.length === 0 ? <p className="cartao-sub" style={{ marginTop: 12 }}>Nada encontrado.</p> : (
                <div className="lista-resultados">
                  {resultados.map((r) => {
                    const padrao = medidaDaUnidade(r.unidade);
                    const opcoes = disponiveis(grupo);
                    return (
                      <div key={r.id} className="resultado">
                        <div className="resultado-texto">
                          <span className="fraco num">{ROTULO_FONTE[r.fonte]} {r.codigo} · {unidadeMedida(r.unidade)}{r.extra ? ` · ${r.extra}` : ""}</span>
                          <span className="forte">{r.descricao}</span>
                        </div>
                        <b className="num resultado-preco">{r.preco ? moeda(r.preco) : <span className="etiqueta et-vermelha">Sem preço</span>}</b>
                        <FormAcao acao={acaoLancarIfc.bind(null, id, grupo.id)} className="form-linha" mostrarOk={false}>
                          <input type="hidden" name="tipo" value={incluir} />
                          <input type="hidden" name="refId" value={r.id} />
                          <select name="etapaId" className="entrada-texto" defaultValue={o.etapas.at(-1)?.id} aria-label="Etapa" style={{ height: 36, fontSize: 13, maxWidth: 180 }}>
                            {o.etapas.map((e) => <option key={e.id} value={e.id}>{e.ordem}. {e.nome}</option>)}
                          </select>
                          <select name="medida" className="entrada-texto" defaultValue={padrao && opcoes.includes(padrao) ? padrao : opcoes[0]} aria-label="Medida" style={{ height: 36, fontSize: 13, width: 150 }}>
                            {opcoes.map((m) => <option key={m} value={m}>{ROTULO_MEDIDA[m]} ({unidadeMedida(UNIDADE_MEDIDA[m])})</option>)}
                          </select>
                          <input name="multiplicador" className="entrada-texto num" inputMode="decimal" defaultValue="1" aria-label="Multiplicar por" title="Multiplicar por (2 para os dois lados da parede, por exemplo)" style={{ width: 70, height: 36 }} />
                          <BotaoEnviar className="botao botao-primario botao-pequeno" enviando="…" ariaLabel={`Lançar ${r.codigo}`}><Plus /></BotaoEnviar>
                        </FormAcao>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </section>
      )}

      <div className="tabela-caixa surgir">
        <table className="tabela tabela-compacta">
          <thead>
            <tr>
              <th>Elemento</th><th>Tipo e material</th><th>Pavimento</th><th className="dir">Qtd.</th>
              <th className="dir">Compr. (m)</th><th className="dir">Área (m²)</th><th className="dir">Volume (m³)</th><th className="dir">Peso (kg)</th><th>No orçamento</th>
            </tr>
          </thead>
          <tbody>
            {l.quantitativos.map((g) => (
              <tr key={g.id} style={g.id === grupo?.id ? { background: "var(--chip)" } : undefined}>
                <td className="forte">{g.rotulo}</td>
                <td>{g.tipo === SEM_TIPO ? (g.material ?? "—") : <>{g.tipo}{g.material && <><br /><span className="fraco">{g.material}</span></>}</>}</td>
                <td className="fraco">{g.pavimentos.join(", ") || "—"}</td>
                <td className="dir num">{g.elementos}</td>
                <td className="dir num"><Medida g={g} m="comprimento" /></td>
                <td className="dir num"><Medida g={g} m="area" /></td>
                <td className="dir num"><Medida g={g} m="volume" /></td>
                <td className="dir num"><Medida g={g} m="peso" /></td>
                <td>
                  {g.lancamentos.map((x) => (
                    <div key={x.id} className="fraco" style={{ fontSize: 12 }}>
                      <Link href={`/orcamentos/${id}/itens/${x.itemId}`} className="link-item">{x.codigo ? `${x.codigo} · ` : ""}{x.descricao.length > 48 ? resumir(x.descricao, 48) : x.descricao}</Link> <span className="num">{quantidade(x.quantidade)} {unidadeMedida(x.unidade)}</span>
                    </div>
                  ))}
                  {editavel && <Link href={linkGrupo(g.id)} className="botao botao-texto botao-pequeno"><Plus /> Lançar</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {algumaCalculada && <p className="fraco" style={{ fontSize: 12 }}>* Calculado pela geometria do modelo: o arquivo não trazia essa quantidade.</p>}
    </div>
  );
}
