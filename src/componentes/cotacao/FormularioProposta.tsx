"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Send } from "lucide-react";
import { Avisos } from "@/componentes/Avisos";
import type { DadosProposta, ItemDigitado } from "@/servicos/cotacoes";
import { unidade } from "@/lib/unidade";

type Material = { id: string; ordem: number; codigo: string; descricao: string; unidade: string; quantidade: string; semSinapi: boolean };
type Retorno = { erro?: string; ok?: string };

type Props = {
  modo: "fornecedor" | "equipe";
  materiais: Material[];
  inicial: DadosProposta | null;
  marcas: string[];
  validadeMinima: number | null;
  freteIncluso: boolean;
  pontua: string[];
  cnpjFinal?: string;
  /** Área do fornecedor: o CNPJ vem da conta e só é mostrado. */
  cnpjFixo?: string;
  reenvio?: boolean;
  enviar: (d: DadosProposta) => Promise<Retorno>;
  salvar?: (d: DadosProposta) => Promise<Retorno>;
  declinar?: (motivo: string) => Promise<Retorno>;
  /** Para onde ir depois do envio. Sem destino, a página é recarregada. */
  destino?: string;
};

const moeda = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const qtd = (v: string) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 4 });
function lerPreco(t: string | undefined): number | null {
  const s = (t ?? "").trim().replace(/\s/g, "");
  if (!s) return null;
  const milhar = /^\d{1,3}(\.\d{3})+$/.test(s);
  const n = Number(s.includes(",") || milhar ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const VAZIO: DadosProposta = { responsavelNome: "", itens: {} };
const ETAPAS = ["Identificação", "Preços", "Revisão"];

export function FormularioProposta(p: Props) {
  const router = useRouter();
  const [d, setD] = useState<DadosProposta>(() => ({ ...VAZIO, ...(p.inicial ?? {}), ...(p.cnpjFixo ? { cnpj: p.cnpjFixo } : {}), itens: { ...(p.inicial?.itens ?? {}) } }));
  const [etapa, setEtapa] = useState(0);
  const [erro, setErro] = useState<string>();
  const [aviso, setAviso] = useState<string>();
  const [faltando, setFaltando] = useState<Set<string>>(new Set());
  const [declinando, setDeclinando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [ocupado, iniciar] = useTransition();
  const topo = useRef<HTMLDivElement>(null);
  const sujo = useRef(false);

  const campo = (k: keyof DadosProposta) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { sujo.current = true; setD((a) => ({ ...a, [k]: e.target.value })); };
  const item = (id: string, m: Partial<ItemDigitado>) => { sujo.current = true; setD((a) => ({ ...a, itens: { ...a.itens, [id]: { ...a.itens[id], ...m } } })); };

  const linhas = useMemo(() => p.materiais.map((m) => {
    const i = d.itens[m.id] ?? {};
    const preco = i.indisponivel ? null : lerPreco(i.preco);
    return { m, i, preco, total: preco == null ? 0 : Math.round(preco * Number(m.quantidade) * 100) / 100 };
  }), [d.itens, p.materiais]);
  const total = linhas.reduce((s, l) => s + l.total, 0);
  const cotados = linhas.filter((l) => l.preco != null).length;
  const indisponiveis = linhas.filter((l) => l.i.indisponivel).length;

  // Rascunho salvo sozinho, para o fornecedor continuar depois pelo mesmo link.
  useEffect(() => {
    if (!p.salvar) return;
    const t = setInterval(() => {
      if (!sujo.current) return;
      sujo.current = false;
      p.salvar!(d).catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [d, p]);

  function ir(n: number) {
    setErro(undefined);
    if (n > etapa && etapa === 0) {
      if (!d.responsavelNome.trim()) return setErro("Informe o nome de quem responde pela proposta.");
      if (p.modo === "fornecedor" && (d.cnpj ?? "").replace(/\D/g, "").length !== 14) return setErro("Confirme o CNPJ da empresa, com 14 dígitos.");
      if (p.modo === "equipe" && !(d.documento ?? "").trim()) return setErro("Informe o documento de origem da proposta.");
    }
    if (n > etapa && etapa === 1) {
      const f = new Set(linhas.filter((l) => !l.i.indisponivel && (l.preco == null || !(l.i.marca ?? "").trim())).map((l) => l.m.id));
      setFaltando(f);
      if (f.size) return setErro(`${f.size === 1 ? "Falta 1 item" : `Faltam ${f.size} itens`}: informe preço e marca ou marque como indisponível.`);
      if (!cotados) return setErro("Informe o preço de ao menos um item.");
      if (p.validadeMinima && Number(d.validadeDias || 0) < p.validadeMinima) return setErro(`A validade da proposta precisa ser de ao menos ${p.validadeMinima} dias.`);
    }
    if (p.salvar && sujo.current) { sujo.current = false; p.salvar(d).catch(() => {}); }
    setEtapa(n);
    topo.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function enviar() {
    setErro(undefined);
    iniciar(async () => {
      const r = await p.enviar(d);
      if (r.erro) return setErro(r.erro);
      if (p.destino) router.push(p.destino); else router.refresh();
    });
  }
  function guardar() {
    if (!p.salvar) return;
    iniciar(async () => {
      sujo.current = false;
      const r = await p.salvar!(d);
      if (r.erro) setErro(r.erro); else setAviso(p.cnpjFixo ? "Rascunho salvo. Você pode continuar depois." : "Rascunho salvo. Você pode continuar depois pelo mesmo link.");
    });
  }
  function recusar() {
    iniciar(async () => {
      const r = await p.declinar!(motivo);
      if (r.erro) setErro(r.erro); else router.refresh();
    });
  }

  return (
    <div ref={topo} style={{ scrollMarginTop: 12 }}>
      <ol className="cot-etapas" aria-label="Etapas da proposta">
        {ETAPAS.map((e, i) => <li key={e} className={i === etapa ? "atual" : i < etapa ? "feito" : ""} aria-current={i === etapa ? "step" : undefined}>{i + 1}. {e}</li>)}
      </ol>
      <Avisos erro={erro} ok={aviso} />

      {etapa === 0 && (
        <div className="grade-form">
          {p.modo === "fornecedor" ? (
            <div className="campo c6"><label htmlFor="pr-cnpj">CNPJ da empresa</label>
              <input id="pr-cnpj" className="entrada-texto" inputMode="numeric" autoComplete="off" value={p.cnpjFixo ? (d.cnpj ?? "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d.cnpj ?? ""}
                readOnly={!!p.cnpjFixo} onChange={campo("cnpj")} placeholder={`Termina em ${p.cnpjFinal?.slice(0, 4)}-${p.cnpjFinal?.slice(4)}`} /></div>
          ) : (
            <div className="campo c6"><label htmlFor="pr-doc">Documento de origem</label>
              <input id="pr-doc" className="entrada-texto" value={d.documento ?? ""} onChange={campo("documento")} placeholder="E-mail de 12/11, ofício nº 45, protocolo…" /></div>
          )}
          <div className="campo c6"><label htmlFor="pr-nome">Quem responde pela proposta</label><input id="pr-nome" className="entrada-texto" autoComplete="name" value={d.responsavelNome} onChange={campo("responsavelNome")} /></div>
          <div className="campo c6"><label htmlFor="pr-cargo">Cargo</label><input id="pr-cargo" className="entrada-texto" value={d.responsavelCargo ?? ""} onChange={campo("responsavelCargo")} /></div>
          <div className="campo c6"><label htmlFor="pr-tel">Telefone</label><input id="pr-tel" className="entrada-texto" inputMode="tel" autoComplete="tel" value={d.responsavelTelefone ?? ""} onChange={campo("responsavelTelefone")} /></div>
          <div className="c12 rodape-form" style={{ justifyContent: "space-between" }}>
            {p.declinar ? <button type="button" className="botao botao-texto" onClick={() => setDeclinando(!declinando)}>Não vou participar</button> : <span />}
            <button type="button" className="botao botao-primario" onClick={() => ir(1)}>Informar preços <ArrowRight /></button>
          </div>
          {declinando && p.declinar && (
            <div className="c12 cartao-interno" style={{ display: "grid", gap: 10 }}>
              <div className="campo"><label htmlFor="pr-motivo">Motivo (opcional)</label><input id="pr-motivo" className="entrada-texto" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} /></div>
              <div><button type="button" className="botao botao-neutro" disabled={ocupado} onClick={recusar}>Confirmar que não vou participar</button></div>
            </div>
          )}
        </div>
      )}

      {etapa === 1 && (
        <>
          <datalist id="pr-marcas">{p.marcas.map((m) => <option key={m} value={m} />)}</datalist>
          <div className="cot-itens">
            {linhas.map(({ m, i, total: t }) => (
              <div key={m.id} className={`cot-item ${i.indisponivel ? "indisponivel" : ""} ${faltando.has(m.id) && !i.indisponivel ? "faltando" : ""}`}>
                <div className="cot-item-topo">
                  <div style={{ minWidth: 0 }}>
                    <b>{m.ordem}. {m.descricao}</b>
                    <div className="cot-item-meta"><span>{m.semSinapi ? "Sem código SINAPI" : `Código ${m.codigo}`}</span><span>Quantidade <b className="num">{qtd(m.quantidade)} {unidade(m.unidade)}</b></span></div>
                  </div>
                  <label className="opcao-check"><input type="checkbox" checked={!!i.indisponivel} onChange={(e) => item(m.id, { indisponivel: e.target.checked })} /> Indisponível</label>
                </div>
                {!i.indisponivel && (
                  <div className="cot-item-campos">
                    <div className="campo"><label htmlFor={`p-${m.id}`}>Preço por {unidade(m.unidade)} (R$)</label>
                      <input id={`p-${m.id}`} className="entrada-texto" inputMode="decimal" autoComplete="off" value={i.preco ?? ""} onChange={(e) => item(m.id, { preco: e.target.value.replace(/[^\d.,]/g, "") })} placeholder="0,00" /></div>
                    <div className="campo"><label htmlFor={`m-${m.id}`}>Marca ou fabricante</label>
                      <input id={`m-${m.id}`} className="entrada-texto" list="pr-marcas" autoComplete="off" value={i.marca ?? ""} onChange={(e) => item(m.id, { marca: e.target.value })} maxLength={80} /></div>
                    <div className="campo"><label htmlFor={`r-${m.id}`}>Modelo ou referência</label>
                      <input id={`r-${m.id}`} className="entrada-texto" autoComplete="off" value={i.modelo ?? ""} onChange={(e) => item(m.id, { modelo: e.target.value })} maxLength={80} placeholder="Opcional" /></div>
                    <div className="cot-item-total">Total do item<b className="num">{moeda(t)}</b></div>
                    <div className="campo cot-campo-largo" style={{ gridColumn: "1 / -1" }}><label htmlFor={`o-${m.id}`}>Observações</label>
                      <input id={`o-${m.id}`} className="entrada-texto" autoComplete="off" value={i.observacao ?? ""} onChange={(e) => item(m.id, { observacao: e.target.value })} maxLength={300} placeholder="Opcional" /></div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <h2 style={{ margin: "22px 0 12px" }}>Condições da proposta</h2>
          <div className="grade-form">
            <div className="campo c3"><label htmlFor="pr-val">Validade (dias){p.validadeMinima ? ` · mínimo ${p.validadeMinima}` : ""}</label><input id="pr-val" className="entrada-texto" inputMode="numeric" value={d.validadeDias ?? ""} onChange={campo("validadeDias")} /></div>
            <div className="campo c3"><label htmlFor="pr-ent">Prazo de entrega (dias)</label><input id="pr-ent" className="entrada-texto" inputMode="numeric" value={d.prazoEntrega ?? ""} onChange={campo("prazoEntrega")} /></div>
            <div className="campo c3"><label htmlFor="pr-pag">Prazo de pagamento (dias)</label><input id="pr-pag" className="entrada-texto" inputMode="numeric" value={d.pagamentoDias ?? ""} onChange={campo("pagamentoDias")} /></div>
            <div className="campo c3"><label htmlFor="pr-gar">Garantia (meses)</label><input id="pr-gar" className="entrada-texto" inputMode="numeric" value={d.garantiaMeses ?? ""} onChange={campo("garantiaMeses")} /></div>
            <div className="campo c8"><label htmlFor="pr-cond">Condição de pagamento</label><input id="pr-cond" className="entrada-texto" value={d.condicaoPagamento ?? ""} onChange={campo("condicaoPagamento")} placeholder="Boleto, 30 dias após a entrega" /></div>
            {!p.freteIncluso && <div className="campo c4"><label htmlFor="pr-frete">Frete (R$)</label><input id="pr-frete" className="entrada-texto" inputMode="decimal" value={d.frete ?? ""} onChange={campo("frete")} placeholder="0,00" /></div>}
            <div className="campo c12"><label htmlFor="pr-obs">Observações gerais</label><textarea id="pr-obs" className="entrada-texto" rows={2} value={d.observacao ?? ""} onChange={campo("observacao")} maxLength={1000} /></div>
            {p.pontua.length > 0 && <p className="cartao-sub c12">Contam na classificação, além do preço: {p.pontua.join(", ")}.</p>}
            {p.freteIncluso && <p className="cartao-sub c12">Os preços devem incluir o frete até o local de entrega.</p>}
          </div>
        </>
      )}

      {etapa === 2 && (
        <>
          <h2>Confira antes de enviar</h2>
          <div className="tabela-caixa">
            <table className="tabela tabela-compacta">
              <thead><tr><th>Item</th><th>Und.</th><th className="dir">Quantidade</th><th className="dir">Preço unitário</th><th>Marca</th><th className="dir">Total</th></tr></thead>
              <tbody>{linhas.map(({ m, i, preco, total: t }) => (
                <tr key={m.id} className={i.indisponivel ? "linha-apagada" : ""}>
                  <td style={{ minWidth: 200 }}>{m.ordem}. {m.descricao}{i.observacao && <div className="fraco">{i.observacao}</div>}</td>
                  <td>{unidade(m.unidade)}</td><td className="dir num">{qtd(m.quantidade)}</td>
                  {i.indisponivel ? <td colSpan={3} className="fraco">Indisponível</td> : (
                    <><td className="dir num">{preco == null ? "—" : preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 4 })}</td>
                      <td>{i.marca}{i.modelo ? ` · ${i.modelo}` : ""}</td><td className="dir num forte">{moeda(t)}</td></>
                  )}
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={5} className="forte">Total da proposta</td><td className="dir num forte">{moeda(total)}</td></tr></tfoot>
            </table>
          </div>
          <dl className="dados" style={{ marginTop: 16 }}>
            <div><dt>Responsável</dt><dd>{d.responsavelNome}{d.responsavelCargo ? ` · ${d.responsavelCargo}` : ""}</dd></div>
            <div><dt>Itens cotados</dt><dd>{cotados} de {p.materiais.length}{indisponiveis ? ` · ${indisponiveis} ${indisponiveis === 1 ? "indisponível" : "indisponíveis"}` : ""}</dd></div>
            <div><dt>Validade</dt><dd>{d.validadeDias ? `${d.validadeDias} dias` : "—"}</dd></div>
            <div><dt>Entrega</dt><dd>{d.prazoEntrega ? `${d.prazoEntrega} dias` : "—"}</dd></div>
            <div><dt>Pagamento</dt><dd>{[d.pagamentoDias ? `${d.pagamentoDias} dias` : "", d.condicaoPagamento].filter(Boolean).join(" · ") || "—"}</dd></div>
            <div><dt>Garantia</dt><dd>{d.garantiaMeses ? `${d.garantiaMeses} meses` : "—"}</dd></div>
            {!p.freteIncluso && <div><dt>Frete</dt><dd>{lerPreco(d.frete) ? moeda(lerPreco(d.frete)!) : "Sem frete"}</dd></div>}
            {p.modo === "equipe" && <div><dt>Documento de origem</dt><dd>{d.documento}</dd></div>}
          </dl>
          {p.reenvio && <p className="cartao-sub" style={{ marginTop: 12 }}>Este envio substitui a proposta anterior, que continua registrada.</p>}
        </>
      )}

      {etapa > 0 && (
        <div className="cot-total-fixo">
          <div>
            <div><span>{cotados} de {p.materiais.length} itens cotados</span><b className="num">{moeda(total)}</b></div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="botao botao-neutro" onClick={() => ir(etapa - 1)} disabled={ocupado}><ArrowLeft /> Voltar</button>
              {etapa === 1 && p.salvar && <button type="button" className="botao botao-neutro" onClick={guardar} disabled={ocupado}><Check /> Salvar</button>}
              {etapa === 1
                ? <button type="button" className="botao botao-primario" onClick={() => ir(2)}>Revisar <ArrowRight /></button>
                : <button type="button" className="botao botao-primario" onClick={enviar} disabled={ocupado}><Send /> {ocupado ? "Enviando…" : p.modo === "equipe" ? "Lançar proposta" : "Enviar proposta"}</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
