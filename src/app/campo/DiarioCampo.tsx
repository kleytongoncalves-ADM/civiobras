"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CloudUpload, Moon, Plus, RefreshCw, Sun, Trash2, Wifi, WifiOff } from "lucide-react";
import { LogoHorizontal } from "@/componentes/Logo";
import type { DadosCampo, ObraParaCampo, ResultadoEnvio } from "@/servicos/diario-campo";
import {
  apagarLancamento, gravarDados, gravarLancamento, lerDados, listarLancamentos, pedirArmazenamentoPersistente,
  type Lancamento, type LinhaLocal,
} from "./armazenamento";

const hojeLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const dataBr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const dataHora = (iso: string) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
const novoId = () => crypto.randomUUID();
const numero = (v: string) => { const t = v.replace(",", ".").trim(); return t === "" ? null : Number(t); };
const TRINTA_DIAS = 30 * 86400000;
/** O id da linha serve só à tela; não vai para o servidor. */
const semId = (l: LinhaLocal) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== "id"));

type Situacao = { online: boolean; enviando: boolean; sessaoEncerrada: boolean; erro: string | null };

function resumo(l: Lancamento) {
  const pessoas = l.linhas.reduce((s, x) => s + (x.tipo === "efetivo" ? x.quantidade : 0), 0);
  const p: string[] = [];
  if (pessoas) p.push(`${pessoas} ${pessoas === 1 ? "pessoa" : "pessoas"}`);
  const conta = (t: LinhaLocal["tipo"], um: string, varios: string) => { const n = l.linhas.filter((x) => x.tipo === t).length; if (n) p.push(`${n} ${n === 1 ? um : varios}`); };
  conta("equipamento", "equipamento", "equipamentos");
  conta("servico", "serviço", "serviços");
  conta("ocorrencia", "ocorrência", "ocorrências");
  if (l.relato.trim()) p.push("relato");
  return p.join(" · ") || "Sem linhas";
}

export function DiarioCampo() {
  const [dados, setDados] = useState<DadosCampo | null>(null);
  const [carregado, setCarregado] = useState(false);
  const [lancamentos, setLancamentos] = useState<Lancamento[]>([]);
  const [edicao, setEdicao] = useState<Lancamento | null>(null);
  const [sit, setSit] = useState<Situacao>({ online: true, enviando: false, sessaoEncerrada: false, erro: null });
  const [obraId, setObraId] = useState("");
  const [data, setData] = useState(hojeLocal());
  const enviandoRef = useRef(false);

  const recarregarLocais = useCallback(async () => setLancamentos(await listarLancamentos()), []);

  /** Baixa obras e atividades. Sem conexão, fica com o que já está no aparelho. */
  const atualizarDados = useCallback(async () => {
    try {
      const r = await fetch("/campo/dados", { cache: "no-store", redirect: "manual" });
      if (r.type === "opaqueredirect" || r.status === 401) { setSit((s) => ({ ...s, sessaoEncerrada: true })); return; }
      if (!r.ok) { setSit((s) => ({ ...s, erro: "Não foi possível atualizar os dados." })); return; }
      const d = (await r.json()) as DadosCampo;
      await gravarDados(d);
      setDados(d);
      setSit((s) => ({ ...s, online: true, sessaoEncerrada: false, erro: null }));
    } catch {
      setSit((s) => ({ ...s, online: false }));
    }
  }, []);

  /** Envia os lançamentos guardados. Repetir o envio não duplica: o servidor reconhece a chave de cada um. */
  const enviar = useCallback(async () => {
    if (enviandoRef.current) return;
    const d = await lerDados();
    if (!d) return;
    const fila = (await listarLancamentos()).filter((l) => l.usuarioId === d.usuario.id && l.estado === "pendente");
    if (!fila.length) return;
    enviandoRef.current = true;
    setSit((s) => ({ ...s, enviando: true, erro: null }));
    const executar = async () => {
      for (let i = 0; i < fila.length; i += 10) {
        const lote = fila.slice(i, i + 10);
        const r = await fetch("/campo/enviar", {
          method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual",
          body: JSON.stringify({ pacotes: lote.map(({ linhas, ...l }) => ({ ...l, linhas: linhas.map(semId) })) }),
        });
        if (r.type === "opaqueredirect" || r.status === 401) { setSit((s) => ({ ...s, sessaoEncerrada: true })); return; }
        if (!r.ok) { setSit((s) => ({ ...s, erro: "O envio não foi concluído. Tente de novo." })); return; }
        const { resultados } = (await r.json()) as { resultados: ResultadoEnvio[] };
        for (const res of resultados) {
          const l = lote.find((x) => x.chave === res.chave);
          if (!l) continue;
          // Se a pessoa alterou o lançamento durante o envio, a nova versão continua pendente e segue no próximo envio.
          const atual = (await listarLancamentos()).find((x) => x.chave === res.chave);
          if (atual && atual.alteradoEm !== l.alteradoEm) {
            await gravarLancamento({ ...atual, diarioId: res.diarioId ?? atual.diarioId, numero: res.numero ?? atual.numero });
            continue;
          }
          const base = { ...l, mensagem: res.mensagem, diarioId: res.diarioId ?? l.diarioId, numero: res.numero ?? l.numero };
          if (res.situacao === "enviado" || res.situacao === "ja_enviado")
            await gravarLancamento({ ...base, estado: "enviado", assinado: res.assinado, enviadoEm: l.enviadoEm ?? new Date().toISOString() });
          else await gravarLancamento({ ...base, estado: res.situacao });
        }
      }
      setSit((s) => ({ ...s, online: true, sessaoEncerrada: false }));
    };
    try {
      // Duas abas abertas: só uma envia por vez.
      if (navigator.locks) await navigator.locks.request("civiobras-envio-campo", executar);
      else await executar();
    } catch {
      setSit((s) => ({ ...s, online: false }));
    } finally {
      enviandoRef.current = false;
      setSit((s) => ({ ...s, enviando: false }));
      await recarregarLocais();
      if (navigator.onLine) await atualizarDados();
    }
  }, [atualizarDados, recarregarLocais]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/campo" }).catch(() => {});
      // Guarda os arquivos desta versão da tela para abrir sem internet.
      navigator.serviceWorker.ready.then((reg) => {
        if (!navigator.onLine) return;
        const urls = [
          ...Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet], link[rel=preload], link[rel=modulepreload]")).map((l) => l.href),
          ...Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).map((s) => s.src),
          ...performance.getEntriesByType("resource").map((r) => r.name),
        ];
        reg.active?.postMessage({ tipo: "guardar-arquivos", urls: [...new Set(urls)] });
      }).catch(() => {});
    }
    pedirArmazenamentoPersistente();
    (async () => {
      const d = await lerDados().catch(() => undefined);
      if (d) setDados(d);
      const todos = await listarLancamentos().catch(() => [] as Lancamento[]);
      // Enviados há mais de 30 dias saem do aparelho; o diário continua no sistema.
      for (const l of todos) if (l.estado === "enviado" && l.enviadoEm && Date.now() - Date.parse(l.enviadoEm) > TRINTA_DIAS) await apagarLancamento(l.chave);
      await recarregarLocais();
      setCarregado(true);
      setSit((s) => ({ ...s, online: navigator.onLine }));
      if (navigator.onLine) { await atualizarDados(); await enviar(); }
    })();
    const ligou = () => { setSit((s) => ({ ...s, online: true })); atualizarDados().then(enviar); };
    const caiu = () => setSit((s) => ({ ...s, online: false }));
    window.addEventListener("online", ligou);
    window.addEventListener("offline", caiu);
    const t = setInterval(() => { if (navigator.onLine) enviar(); }, 60_000);
    return () => { window.removeEventListener("online", ligou); window.removeEventListener("offline", caiu); clearInterval(t); };
  }, [atualizarDados, enviar, recarregarLocais]);

  const meus = useMemo(() => (dados ? lancamentos.filter((l) => l.usuarioId === dados.usuario.id) : []), [dados, lancamentos]);
  const aguardando = meus.filter((l) => l.estado !== "enviado").sort((a, b) => b.data.localeCompare(a.data) || b.alteradoEm.localeCompare(a.alteradoEm));
  const enviados = meus.filter((l) => l.estado === "enviado").sort((a, b) => (b.enviadoEm ?? "").localeCompare(a.enviadoEm ?? ""));
  const pendentes = meus.filter((l) => l.estado === "pendente").length;
  const obraSel = dados?.obras.find((o) => o.id === obraId) ?? null;

  function iniciar() {
    if (!dados || !obraSel || !data) return;
    const aberto = meus.find((l) => l.obraId === obraSel.id && l.data === data && (l.estado === "rascunho" || l.estado === "pendente" || l.estado === "recusado"));
    if (aberto) { setEdicao(aberto); return; }
    const agora = new Date().toISOString();
    setEdicao({
      chave: novoId(), usuarioId: dados.usuario.id, obraId: obraSel.id, obraCodigo: obraSel.codigo, obraNome: obraSel.nome, data,
      registradoEm: agora, alteradoEm: agora, climaManha: "", climaTarde: "", condicao: "praticavel", relato: "",
      linhas: [], assinar: false, comoComplemento: false, estado: "rascunho",
    });
  }

  async function guardar(l: Lancamento, estado: Lancamento["estado"]) {
    const novo = { ...l, estado, mensagem: undefined, alteradoEm: new Date().toISOString() };
    await gravarLancamento(novo);
    await recarregarLocais();
    return novo;
  }

  async function concluir(l: Lancamento) {
    await guardar(l, "pendente");
    setEdicao(null);
    if (navigator.onLine) enviar();
  }

  async function excluir(l: Lancamento) {
    await apagarLancamento(l.chave);
    if (edicao?.chave === l.chave) setEdicao(null);
    await recarregarLocais();
  }

  async function comoComplemento(l: Lancamento) {
    await gravarLancamento({ ...l, comoComplemento: true, estado: "pendente", mensagem: undefined });
    await recarregarLocais();
    enviar();
  }

  const topo = (
    <header className="vidro topo campo-topo">
      {/* Navegação completa de propósito: esta tela roda fora do roteador para funcionar sem internet. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/diario" className="redondo" aria-label="Voltar ao sistema" title="Voltar ao sistema"><ArrowLeft /></a>
      <LogoHorizontal largura={140} />
      <span style={{ flex: 1 }} />
      <span className={`etiqueta campo-status ${sit.online ? "et-verde" : "et-laranja"}`} role="status">
        {sit.online ? <Wifi /> : <WifiOff />} {sit.online ? "Conectado" : "Sem internet"}
      </span>
      <button className="redondo" onClick={alternarTema} aria-label="Alternar entre tema claro e escuro" title="Tema claro ou escuro">
        <Sun className="so-tema-escuro" /><Moon className="so-tema-claro" />
      </button>
    </header>
  );

  if (!carregado) return <div className="campo-casca">{topo}<main className="painel"><p className="cartao-sub">Carregando…</p></main></div>;

  return (
    <div className="campo-casca">
      {topo}
      <main className="painel">
        <div className="cabecalho">
          <div>
            <div className="sobretitulo">Diário de obra</div>
            <h1 className="titulo">Diário em campo</h1>
            {dados && <p className="subtitulo">{dados.usuario.nome} · {dados.usuario.orgao}</p>}
          </div>
          {dados && (
            <div className="campo-acoes-topo">
              {pendentes > 0 && (
                <button className="botao botao-primario" onClick={enviar} disabled={!sit.online || sit.enviando}>
                  <CloudUpload /> {sit.enviando ? "Enviando…" : `Enviar ${pendentes} ${pendentes === 1 ? "lançamento" : "lançamentos"}`}
                </button>
              )}
              <button className="botao botao-neutro" onClick={atualizarDados} disabled={!sit.online}><RefreshCw /> Atualizar obras</button>
            </div>
          )}
        </div>

        {sit.sessaoEncerrada && (
          <div className="aviso aviso-erro" style={{ marginBottom: 16 }}>
            <AlertTriangle /><span>Sessão encerrada. <a href="/login" className="forte">Entre de novo</a> e volte a esta tela para enviar. Os lançamentos continuam no aparelho.</span>
          </div>
        )}
        {sit.erro && <div className="aviso aviso-erro" style={{ marginBottom: 16 }}><AlertTriangle /><span>{sit.erro}</span></div>}

        {!dados ? (
          <div className="cartao vazio">
            <b>{sit.online ? "Baixando as obras…" : "Sem dados no aparelho"}</b>
            {!sit.online && "Abra esta tela uma vez com internet para baixar as obras."}
          </div>
        ) : edicao ? (
          <Formulario
            key={edicao.chave} inicial={edicao} dados={dados}
            obra={dados.obras.find((o) => o.id === edicao.obraId) ?? null}
            aoGuardar={(l) => guardar(l, "rascunho")} aoConcluir={concluir} aoCancelar={() => setEdicao(null)} aoExcluir={excluir}
          />
        ) : (
          <div className="campo-grade">
            <section className="cartao">
              <h2 className="cartao-titulo">Novo lançamento</h2>
              {dados.obras.length === 0 ? (
                <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhuma obra em execução no seu acesso.</p>
              ) : (
                <div className="grade-form" style={{ marginTop: 14 }}>
                  <div className="campo c8">
                    <label htmlFor="obra">Obra</label>
                    <select id="obra" className="entrada-texto" value={obraId} onChange={(e) => setObraId(e.target.value)}>
                      <option value="">Escolha a obra</option>
                      {dados.obras.map((o) => <option key={o.id} value={o.id}>{o.codigo} · {o.nome}</option>)}
                    </select>
                  </div>
                  <div className="campo c4">
                    <label htmlFor="data">Data</label>
                    <input id="data" type="date" className="entrada-texto" value={data} max={hojeLocal()} onChange={(e) => setData(e.target.value)} />
                  </div>
                  {obraSel && <SituacaoDoDia obra={obraSel} data={data} />}
                  <div className="c12">
                    <button className="botao botao-primario" onClick={iniciar} disabled={!obraSel || !data || data > hojeLocal()}><Plus /> Lançar</button>
                  </div>
                </div>
              )}
              <p className="cartao-sub" style={{ marginTop: 16 }}>Obras baixadas em {dataHora(dados.preparadoEm)}.</p>
            </section>

            <section className="cartao">
              <h2 className="cartao-titulo">Aguardando envio</h2>
              {aguardando.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nada pendente neste aparelho.</p> : (
                <ul className="campo-lista">
                  {aguardando.map((l) => (
                    <li key={l.chave}>
                      <div className="campo-lista-topo">
                        <div style={{ minWidth: 0 }}>
                          <b>{l.obraCodigo} · {dataBr(l.data)}</b>
                          <div className="fraco">{l.obraNome}</div>
                        </div>
                        <EtiquetaEstado l={l} />
                      </div>
                      <div className="fraco">{resumo(l)}{l.assinar ? " · assinar ao enviar" : ""}</div>
                      {l.mensagem && <div className={`aviso ${l.estado === "conflito" ? "aviso-info" : "aviso-erro"}`}><AlertTriangle /><span>{l.mensagem}</span></div>}
                      <div className="campo-lista-acoes">
                        {l.estado === "conflito" ? (
                          <button className="botao botao-primario botao-pequeno" onClick={() => comoComplemento(l)} disabled={sit.enviando}>Enviar como complemento</button>
                        ) : (
                          <button className="botao botao-neutro botao-pequeno" onClick={() => setEdicao(l)} disabled={sit.enviando}>{l.estado === "rascunho" ? "Continuar" : l.estado === "recusado" ? "Corrigir" : "Editar"}</button>
                        )}
                        <ExcluirLancamento aoExcluir={() => excluir(l)} desativado={sit.enviando} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {enviados.length > 0 && (
              <section className="cartao campo-largo">
                <h2 className="cartao-titulo">Enviados</h2>
                <ul className="campo-lista">
                  {enviados.map((l) => (
                    <li key={l.chave}>
                      <div className="campo-lista-topo">
                        <div style={{ minWidth: 0 }}>
                          <b>{l.obraCodigo} · {dataBr(l.data)}{l.numero ? ` · diário nº ${l.numero}` : ""}</b>
                          <div className="fraco">{resumo(l)} · lançado {dataHora(l.registradoEm)} · enviado {l.enviadoEm ? dataHora(l.enviadoEm) : "—"}</div>
                        </div>
                        <EtiquetaEstado l={l} />
                      </div>
                      {l.mensagem && <div className="aviso aviso-info"><AlertTriangle /><span>{l.mensagem}</span></div>}
                      {l.diarioId && sit.online && <div className="campo-lista-acoes"><a href={`/diario/${l.diarioId}`} className="botao botao-neutro botao-pequeno">Abrir diário</a></div>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function alternarTema() {
  const raiz = document.documentElement;
  const escuro = raiz.dataset.tema !== "escuro";
  if (escuro) raiz.dataset.tema = "escuro"; else delete raiz.dataset.tema;
  try { localStorage.setItem("civiobra-tema", escuro ? "escuro" : "claro"); } catch { /* sem armazenamento */ }
}

function EtiquetaEstado({ l }: { l: Lancamento }) {
  if (l.estado === "enviado") return <span className="etiqueta et-verde">{l.assinado ? "Assinado" : "Enviado"}</span>;
  if (l.estado === "conflito") return <span className="etiqueta et-azul">Diário já assinado</span>;
  if (l.estado === "recusado") return <span className="etiqueta et-vermelha">Não aceito</span>;
  if (l.estado === "rascunho") return <span className="etiqueta et-neutra">Em preenchimento</span>;
  return <span className="etiqueta et-laranja">Aguardando envio</span>;
}

function ExcluirLancamento({ aoExcluir, desativado }: { aoExcluir: () => void; desativado?: boolean }) {
  const [confirmar, setConfirmar] = useState(false);
  if (!confirmar) return <button className="botao botao-texto botao-pequeno" onClick={() => setConfirmar(true)} disabled={desativado}><Trash2 /> Excluir</button>;
  return (
    <span className="form-linha">
      <span className="fraco">Excluir do aparelho?</span>
      <button className="botao botao-neutro botao-pequeno" onClick={aoExcluir}>Excluir</button>
      <button className="botao botao-texto botao-pequeno" onClick={() => setConfirmar(false)}>Manter</button>
    </span>
  );
}

function SituacaoDoDia({ obra, data }: { obra: ObraParaCampo; data: string }) {
  const d = obra.diarios.find((x) => x.data === data);
  if (!d) return null;
  return (
    <div className="c12 aviso aviso-info">
      <AlertTriangle />
      <span>{d.situacao === "assinado"
        ? `O diário nº ${d.numero} deste dia já está assinado. O lançamento poderá entrar como complemento.`
        : `O diário nº ${d.numero} deste dia está em elaboração. As linhas lançadas aqui são somadas a ele.`}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulário do lançamento
// ---------------------------------------------------------------------------
type PropsFormulario = {
  inicial: Lancamento; dados: DadosCampo; obra: ObraParaCampo | null;
  aoGuardar: (l: Lancamento) => Promise<Lancamento>; aoConcluir: (l: Lancamento) => void; aoCancelar: () => void; aoExcluir: (l: Lancamento) => void;
};

function Formulario({ inicial, dados, obra, aoGuardar, aoConcluir, aoCancelar, aoExcluir }: PropsFormulario) {
  const [l, setL] = useState(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const primeira = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guardarRef = useRef(aoGuardar);
  useEffect(() => { guardarRef.current = aoGuardar; }, [aoGuardar]);
  const r = dados.rotulos;

  // Cada alteração fica guardada no aparelho: fechar o navegador não perde o que foi digitado.
  useEffect(() => {
    if (primeira.current) { primeira.current = false; return; }
    timer.current = setTimeout(() => { timer.current = null; guardarRef.current({ ...l, estado: "rascunho" }); }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [l]);
  const pararGravacao = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const mudar = (x: Partial<Lancamento>) => setL((v) => ({ ...v, ...x }));
  const adicionar = (x: LinhaLocal) => { setErro(null); setL((v) => ({ ...v, linhas: [...v.linhas, x] })); };
  const remover = (id: string) => setL((v) => ({ ...v, linhas: v.linhas.filter((x) => x.id !== id) }));
  const vazio = !l.relato.trim() && l.linhas.length === 0;

  function concluir() {
    if (vazio) { setErro("Registre o relato ou pelo menos uma linha."); return; }
    if (!l.comoComplemento && (!l.climaManha || !l.climaTarde)) { setErro("Escolha o clima da manhã e da tarde."); return; }
    if (l.assinar && !l.relato.trim() && !l.linhas.some((x) => x.tipo === "servico" || x.tipo === "ocorrencia")) {
      setErro("Para assinar, registre o relato, um serviço ou uma ocorrência."); return;
    }
    pararGravacao();
    aoConcluir(l);
  }

  return (
    <div className="campo-form">
      <section className="cartao">
        <div className="barra-acoes">
          <div style={{ minWidth: 0 }}>
            <h2 className="cartao-titulo">{l.obraCodigo} · {dataBr(l.data)}</h2>
            <p className="cartao-sub">{l.obraNome}</p>
          </div>
        </div>
        {obra && <div style={{ marginTop: 12 }}><SituacaoDoDia obra={obra} data={l.data} /></div>}
        {inicial.mensagem && inicial.estado === "recusado" && <div className="aviso aviso-erro" style={{ marginTop: 12 }}><AlertTriangle /><span>{inicial.mensagem}</span></div>}
        <div className="grade-form" style={{ marginTop: 14 }}>
          <div className="campo c4"><label htmlFor="cm">Clima pela manhã</label>
            <select id="cm" className="entrada-texto" required value={l.climaManha} onChange={(e) => mudar({ climaManha: e.target.value })}>
              <option value="" disabled>Escolha</option>
              {Object.entries(r.clima).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div className="campo c4"><label htmlFor="ct">Clima à tarde</label>
            <select id="ct" className="entrada-texto" required value={l.climaTarde} onChange={(e) => mudar({ climaTarde: e.target.value })}>
              <option value="" disabled>Escolha</option>
              {Object.entries(r.clima).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div className="campo c4"><label htmlFor="cd">Condição de trabalho</label>
            <select id="cd" className="entrada-texto" value={l.condicao} onChange={(e) => mudar({ condicao: e.target.value })}>
              {Object.entries(r.condicao).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div className="campo c12"><label htmlFor="rl">Relato do dia</label>
            <textarea id="rl" className="entrada-texto texto-relato" rows={4} value={l.relato} onChange={(e) => mudar({ relato: e.target.value })} /></div>
        </div>
      </section>

      <Bloco titulo="Efetivo" linhas={l.linhas.filter((x) => x.tipo === "efetivo")} aoRemover={remover}
        texto={(x) => x.tipo === "efetivo" ? `${x.quantidade} ${x.funcao}${x.empresa ? ` · ${x.empresa}` : ""}` : ""}>
        <NovoEfetivo funcoes={dados.funcoes} aoAdicionar={adicionar} />
      </Bloco>
      <Bloco titulo="Equipamentos" linhas={l.linhas.filter((x) => x.tipo === "equipamento")} aoRemover={remover}
        texto={(x) => x.tipo === "equipamento" ? `${x.quantidade} ${x.descricao}${x.horas != null ? ` · ${String(x.horas).replace(".", ",")} h` : ""}` : ""}>
        <NovoEquipamento aoAdicionar={adicionar} />
      </Bloco>
      <Bloco titulo="Serviços executados" linhas={l.linhas.filter((x) => x.tipo === "servico")} aoRemover={remover}
        texto={(x) => x.tipo === "servico" ? `${x.descricao || obra?.atividades.find((a) => a.id === x.atividadeId)?.nome || ""}${x.local ? ` · ${x.local}` : ""}${x.avancoPct != null ? ` · ${String(x.avancoPct).replace(".", ",")}%` : ""}` : ""}>
        <NovoServico atividades={obra?.atividades ?? []} aoAdicionar={adicionar} />
      </Bloco>
      <Bloco titulo="Ocorrências e visitas" linhas={l.linhas.filter((x) => x.tipo === "ocorrencia")} aoRemover={remover}
        texto={(x) => x.tipo === "ocorrencia" ? `${r.ocorrencia[x.subtipo]}: ${x.descricao}${x.subtipo === "paralisacao" && x.motivo ? ` · ${r.motivo[x.motivo as keyof typeof r.motivo]}, ${String(x.horas ?? 0).replace(".", ",")} h` : ""}` : ""}>
        <NovaOcorrencia rotulos={r} aoAdicionar={adicionar} />
      </Bloco>

      <section className="cartao campo-rodape">
        {dados.podeAssinar && (
          <label className="opcao-check">
            <input type="checkbox" checked={l.assinar} onChange={(e) => mudar({ assinar: e.target.checked })} />
            <span>Assinar ao enviar. A assinatura registra seu login com a data e a hora do envio.</span>
          </label>
        )}
        {erro && <div className="aviso aviso-erro"><AlertTriangle /><span>{erro}</span></div>}
        <div className="form-linha">
          <button className="botao botao-primario" onClick={concluir}><CloudUpload /> Guardar para envio</button>
          <button className="botao botao-neutro" onClick={() => { pararGravacao(); if (l !== inicial) guardarRef.current({ ...l, estado: "rascunho" }); aoCancelar(); }}>Voltar</button>
          <span style={{ flex: 1 }} />
          <ExcluirLancamento aoExcluir={() => { pararGravacao(); aoExcluir(l); }} />
        </div>
      </section>
    </div>
  );
}

function Bloco({ titulo, linhas, texto, aoRemover, children }: {
  titulo: string; linhas: LinhaLocal[]; texto: (l: LinhaLocal) => string; aoRemover: (id: string) => void; children: React.ReactNode;
}) {
  return (
    <section className="cartao">
      <h2 className="cartao-titulo">{titulo}</h2>
      {linhas.length > 0 && (
        <ul className="lista-simples">
          {linhas.map((x) => (
            <li key={x.id} className="campo-linha">
              <span>{texto(x)}</span>
              <button className="botao botao-texto botao-pequeno" onClick={() => aoRemover(x.id)} aria-label={`Remover ${texto(x)}`}><Trash2 /></button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

function NovoEfetivo({ funcoes, aoAdicionar }: { funcoes: string[]; aoAdicionar: (l: LinhaLocal) => void }) {
  const [funcao, setFuncao] = useState(""), [empresa, setEmpresa] = useState(""), [qtd, setQtd] = useState("1");
  const q = Math.round(numero(qtd) ?? 0);
  const ok = funcao.trim() !== "" && q >= 1 && q <= 2000;
  return (
    <div className="grade-form">
      <div className="campo c5"><label htmlFor="ef-f">Função</label>
        <input id="ef-f" className="entrada-texto" list="funcoes-campo" value={funcao} onChange={(e) => setFuncao(e.target.value)} />
        <datalist id="funcoes-campo">{funcoes.map((f) => <option key={f} value={f} />)}</datalist></div>
      <div className="campo c4"><label htmlFor="ef-e">Empresa</label><input id="ef-e" className="entrada-texto" value={empresa} onChange={(e) => setEmpresa(e.target.value)} /></div>
      <div className="campo c3"><label htmlFor="ef-q">Pessoas</label><input id="ef-q" className="entrada-texto" inputMode="numeric" value={qtd} onChange={(e) => setQtd(e.target.value)} /></div>
      <div className="c12"><button className="botao botao-neutro botao-pequeno" disabled={!ok}
        onClick={() => { aoAdicionar({ id: novoId(), tipo: "efetivo", funcao: funcao.trim(), empresa: empresa.trim(), quantidade: q }); setFuncao(""); setQtd("1"); }}><Plus /> Adicionar</button></div>
    </div>
  );
}

function NovoEquipamento({ aoAdicionar }: { aoAdicionar: (l: LinhaLocal) => void }) {
  const [descricao, setDescricao] = useState(""), [qtd, setQtd] = useState("1"), [horas, setHoras] = useState("");
  const q = Math.round(numero(qtd) ?? 0), h = numero(horas);
  const ok = descricao.trim() !== "" && q >= 1 && q <= 500 && (h == null || (h >= 0 && h <= 24));
  return (
    <div className="grade-form">
      <div className="campo c6"><label htmlFor="eq-d">Equipamento</label><input id="eq-d" className="entrada-texto" value={descricao} onChange={(e) => setDescricao(e.target.value)} /></div>
      <div className="campo c3"><label htmlFor="eq-q">Quantidade</label><input id="eq-q" className="entrada-texto" inputMode="numeric" value={qtd} onChange={(e) => setQtd(e.target.value)} /></div>
      <div className="campo c3"><label htmlFor="eq-h">Horas</label><input id="eq-h" className="entrada-texto" inputMode="decimal" value={horas} onChange={(e) => setHoras(e.target.value)} /></div>
      <div className="c12"><button className="botao botao-neutro botao-pequeno" disabled={!ok}
        onClick={() => { aoAdicionar({ id: novoId(), tipo: "equipamento", descricao: descricao.trim(), quantidade: q, horas: h }); setDescricao(""); setQtd("1"); setHoras(""); }}><Plus /> Adicionar</button></div>
    </div>
  );
}

function NovoServico({ atividades, aoAdicionar }: { atividades: ObraParaCampo["atividades"]; aoAdicionar: (l: LinhaLocal) => void }) {
  const [atividadeId, setAtividadeId] = useState(""), [descricao, setDescricao] = useState(""), [local, setLocal] = useState(""), [avanco, setAvanco] = useState("");
  const at = atividades.find((a) => a.id === atividadeId) ?? null;
  const pct = numero(avanco);
  const erroAvanco = pct != null && (!at ? "Escolha a atividade para lançar o avanço." : pct < 0 || pct > 100 ? "O avanço vai de 0% a 100%." : pct < at.avanco ? `O avanço acumulado já é ${String(at.avanco).replace(".", ",")}%.` : null);
  const ok = (descricao.trim() !== "" || !!at) && !erroAvanco;
  return (
    <div className="grade-form">
      {atividades.length > 0 && (
        <div className="campo c12"><label htmlFor="sv-a">Atividade do cronograma</label>
          <select id="sv-a" className="entrada-texto" value={atividadeId} onChange={(e) => setAtividadeId(e.target.value)}>
            <option value="">Sem vínculo com o cronograma</option>
            {atividades.map((a) => <option key={a.id} value={a.id}>{a.codigo} {a.nome} ({String(a.avanco).replace(".", ",")}%)</option>)}
          </select></div>
      )}
      <div className="campo c6"><label htmlFor="sv-d">Descrição</label><input id="sv-d" className="entrada-texto" value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder={at ? `${at.codigo} ${at.nome}` : ""} /></div>
      <div className="campo c3"><label htmlFor="sv-l">Local</label><input id="sv-l" className="entrada-texto" value={local} onChange={(e) => setLocal(e.target.value)} /></div>
      <div className="campo c3"><label htmlFor="sv-p">Avanço acumulado (%)</label><input id="sv-p" className="entrada-texto" inputMode="decimal" value={avanco} onChange={(e) => setAvanco(e.target.value)} disabled={!at} aria-invalid={!!erroAvanco} /></div>
      {erroAvanco && <div className="c12 aviso aviso-erro"><AlertTriangle /><span>{erroAvanco}</span></div>}
      <div className="c12"><button className="botao botao-neutro botao-pequeno" disabled={!ok}
        onClick={() => { aoAdicionar({ id: novoId(), tipo: "servico", descricao: descricao.trim(), local: local.trim(), atividadeId: at?.id ?? null, avancoPct: pct }); setDescricao(""); setLocal(""); setAvanco(""); setAtividadeId(""); }}><Plus /> Adicionar</button></div>
    </div>
  );
}

function NovaOcorrencia({ rotulos, aoAdicionar }: { rotulos: DadosCampo["rotulos"]; aoAdicionar: (l: LinhaLocal) => void }) {
  const [subtipo, setSubtipo] = useState<"ocorrencia" | "visita" | "paralisacao">("ocorrencia");
  const [descricao, setDescricao] = useState(""), [motivo, setMotivo] = useState(""), [horas, setHoras] = useState("");
  const par = subtipo === "paralisacao";
  const h = numero(horas);
  const ok = descricao.trim() !== "" && (!par || (motivo !== "" && h != null && h > 0 && h <= 24));
  return (
    <div className="grade-form">
      <div className="campo c4"><label htmlFor="oc-t">Tipo</label>
        <select id="oc-t" className="entrada-texto" value={subtipo} onChange={(e) => setSubtipo(e.target.value as typeof subtipo)}>
          {Object.entries(rotulos.ocorrencia).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></div>
      {par && <>
        <div className="campo c5"><label htmlFor="oc-m">Motivo</label>
          <select id="oc-m" className="entrada-texto" value={motivo} onChange={(e) => setMotivo(e.target.value)}>
            <option value="">Escolha</option>
            {Object.entries(rotulos.motivo).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <div className="campo c3"><label htmlFor="oc-h">Horas paradas</label><input id="oc-h" className="entrada-texto" inputMode="decimal" value={horas} onChange={(e) => setHoras(e.target.value)} /></div>
      </>}
      <div className="campo c12"><label htmlFor="oc-d">Descrição</label><textarea id="oc-d" className="entrada-texto texto-relato" rows={2} value={descricao} onChange={(e) => setDescricao(e.target.value)} /></div>
      <div className="c12"><button className="botao botao-neutro botao-pequeno" disabled={!ok}
        onClick={() => { aoAdicionar({ id: novoId(), tipo: "ocorrencia", subtipo, descricao: descricao.trim(), motivo: par ? motivo : null, horas: par ? h : null }); setDescricao(""); setHoras(""); setMotivo(""); }}><Plus /> Adicionar</button></div>
    </div>
  );
}
