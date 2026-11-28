"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Copy, Crosshair, ExternalLink, LocateFixed, MapPin, Navigation, ScanEye, X } from "lucide-react";
import type { Circle, LayerGroup, Map as MapaLeaflet, Marker, TileLayer } from "leaflet";
import { EtiquetaSituacao } from "@/componentes/Situacao";
import type { FichaObra, ObraNoMapa } from "@/servicos/mapa";
import { ROTULO_SITUACAO, type Situacao } from "@/servicos/rotulos";
import { acaoDefinirLocal } from "./acoes";

/** Imagem de satélite (Esri World Imagery) com ruas e nomes por cima; mapa de ruas da Esri como alternativa. */
const SATELITE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const RUAS_SOBRE = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}";
const NOMES_SOBRE = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const RUAS = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const ATRIB_SATELITE = "Imagens &copy; Esri, Maxar, Earthstar Geographics";
const ATRIB_RUAS = "Mapa &copy; Esri, HERE, Garmin, OpenStreetMap";
const CENTRO_RJ: [number, number] = [-22.6, -43.0];

const COR_SITUACAO: Record<Situacao, string> = {
  em_estudo: "#7b8c93", orcada: "#0b7d8a", licitada: "#7a5cc2", contratada: "#7a5cc2", em_execucao: "#f28c28",
  paralisada: "#c23a3a", concluida: "#17834a", recebida_provisoriamente: "#17834a", recebida_definitivamente: "#17834a", cancelada: "#7b8c93",
};
const COR_NIVEL = { verde: "#17834a", amarelo: "#d99a00", vermelho: "#c23a3a" } as const;
const ROTULO_NIVEL = { verde: "Em dia", amarelo: "Atenção", vermelho: "Crítica" } as const;
const SEM_SEMAFORO = "#7b8c93";

const dataBr = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const dataHora = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)).replace(",", "");
const pct = (v: number) => `${v.toFixed(1).replace(".", ",")}%`;
const moeda = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v: number, casas = 0) => v.toLocaleString("pt-BR", { maximumFractionDigits: casas });
const coord = (v: number) => v.toFixed(6).replace(".", ",");

type Props = { obras: ObraNoMapa[]; comSemaforo: boolean; podeEditar: boolean; camadas: string | null };
type Fundo = "satelite" | "ruas";

export function MapaObras({ obras, comSemaforo, podeEditar, camadas }: Props) {
  const router = useRouter();
  const caixa = useRef<HTMLDivElement>(null);
  const mapa = useRef<MapaLeaflet | null>(null);
  const grupo = useRef<LayerGroup | null>(null);
  const destaque = useRef<LayerGroup | null>(null);
  const fundos = useRef<{ satelite: TileLayer[]; ruas: TileLayer[] }>({ satelite: [], ruas: [] });
  const marcadores = useRef(new Map<string, Marker>());
  const novoPonto = useRef<Marker | null>(null);
  const L = useRef<typeof import("leaflet") | null>(null);
  const [pronto, setPronto] = useState(false);
  const [fundo, setFundo] = useState<Fundo>("satelite");
  const [situacao, setSituacao] = useState<Situacao | "">("");
  const [nivel, setNivel] = useState<"" | "verde" | "amarelo" | "vermelho">("");
  const [corPor, setCorPor] = useState<"situacao" | "semaforo">(comSemaforo ? "semaforo" : "situacao");
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [ficha, setFicha] = useState<FichaObra | null>(null);
  const [carregandoFicha, setCarregandoFicha] = useState(false);
  const [marcando, setMarcando] = useState<ObraNoMapa | null>(null);
  const [ponto, setPonto] = useState<{ lat: number; lng: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, iniciar] = useTransition();

  const situacoes = useMemo(() => [...new Set(obras.map((o) => o.situacao))], [obras]);
  const filtradas = useMemo(() => obras.filter((o) => (!situacao || o.situacao === situacao) && (!nivel || o.nivel === nivel)), [obras, situacao, nivel]);
  const localizadas = filtradas.filter((o) => o.latitude != null && o.longitude != null);
  const semLocal = obras.filter((o) => o.latitude == null || o.longitude == null);
  const cor = (o: ObraNoMapa) => (corPor === "semaforo" ? (o.nivel ? COR_NIVEL[o.nivel] : SEM_SEMAFORO) : COR_SITUACAO[o.situacao]);
  const obraSel = obras.find((o) => o.id === selecionada) ?? null;

  // Monta o mapa uma vez.
  useEffect(() => {
    let vivo = true;
    import("leaflet").then((mod) => {
      if (!vivo || !caixa.current || mapa.current) return;
      L.current = mod;
      const m = mod.map(caixa.current, { zoomControl: true, attributionControl: true, maxZoom: 20 }).setView(CENTRO_RJ, 8);
      m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a>');
      fundos.current.satelite = [
        mod.tileLayer(SATELITE, { maxZoom: 20, maxNativeZoom: 19, attribution: ATRIB_SATELITE }),
        mod.tileLayer(RUAS_SOBRE, { maxZoom: 20, maxNativeZoom: 19, opacity: 0.85 }),
        mod.tileLayer(NOMES_SOBRE, { maxZoom: 20, maxNativeZoom: 19 }),
      ];
      fundos.current.ruas = [mod.tileLayer(camadas || RUAS, { maxZoom: 20, maxNativeZoom: 19, attribution: ATRIB_RUAS })];
      fundos.current.satelite.forEach((t) => t.addTo(m));
      grupo.current = mod.layerGroup().addTo(m);
      destaque.current = mod.layerGroup().addTo(m);
      mapa.current = m;
      setPronto(true);
    });
    return () => { vivo = false; mapa.current?.remove(); mapa.current = null; };
  }, [camadas]);

  // Troca entre satélite e mapa de ruas.
  useEffect(() => {
    const m = mapa.current;
    if (!pronto || !m) return;
    const [liga, desliga] = fundo === "satelite" ? [fundos.current.satelite, fundos.current.ruas] : [fundos.current.ruas, fundos.current.satelite];
    desliga.forEach((t) => t.remove());
    liga.forEach((t) => { if (!m.hasLayer(t)) t.addTo(m); t.bringToBack(); });
    fundos.current.satelite[0]?.bringToBack();
    m.getContainer().dataset.fundo = fundo;
  }, [fundo, pronto]);

  // Marcadores das obras filtradas.
  useEffect(() => {
    const mod = L.current, m = mapa.current, g = grupo.current;
    if (!pronto || !mod || !m || !g) return;
    g.clearLayers();
    marcadores.current.clear();
    for (const o of localizadas) {
      const icone = mod.divIcon({
        className: `marcador-obra${o.id === selecionada ? " marcador-ativo" : ""}`, iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<span style="--c:${cor(o)}"></span>`,
      });
      const mk = mod.marker([o.latitude!, o.longitude!], { icon: icone, riseOnHover: true, keyboard: true, alt: `${o.codigo} ${o.nome}` })
        .bindTooltip(rotuloMarcador(o), { direction: "top", offset: [0, -14], className: "mapa-dica" });
      mk.on("click", () => abrir(o));
      mk.addTo(g);
      marcadores.current.set(o.id, mk);
    }
    if (localizadas.length && !selecionada) {
      const b = mod.latLngBounds(localizadas.map((o) => [o.latitude!, o.longitude!] as [number, number]));
      m.fitBounds(b.pad(0.25), { maxZoom: 16 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pronto, filtradas, corPor, selecionada]);

  // Destaque da obra escolhida: área aproximada e pontos das fotos com GPS.
  useEffect(() => {
    const mod = L.current, d = destaque.current;
    if (!mod || !d) return;
    d.clearLayers();
    if (!obraSel || obraSel.latitude == null || obraSel.longitude == null) return;
    const raio = obraSel.areaM2 ? Math.max(12, Math.sqrt(obraSel.areaM2 / Math.PI)) : 25;
    const area: Circle = mod.circle([obraSel.latitude, obraSel.longitude], { radius: raio, color: "#f28c28", weight: 2, dashArray: "6 6", fillColor: "#f28c28", fillOpacity: 0.12, interactive: false });
    area.addTo(d);
    for (const f of ficha?.id === obraSel.id ? ficha.fotos : []) {
      if (f.latitude == null || f.longitude == null) continue;
      mod.marker([f.latitude, f.longitude], {
        icon: mod.divIcon({ className: "marcador-foto", iconSize: [34, 34], iconAnchor: [17, 17], html: `<img src="/fotos/${encodeURIComponent(f.id)}?mini" alt="">` }),
      }).bindTooltip(textoSeguro(`${f.legenda ?? "Foto"} · ${dataHora(f.em)}`), { direction: "top", offset: [0, -16], className: "mapa-dica" })
        .on("click", () => window.open(`/fotos/${f.id}`, "_blank", "noopener"))
        .addTo(d);
    }
  }, [obraSel, ficha]);

  // Modo de marcar o local de uma obra.
  useEffect(() => {
    const mod = L.current, m = mapa.current;
    if (!mod || !m) return;
    const el = m.getContainer();
    if (!marcando) { el.classList.remove("mapa-marcando"); novoPonto.current?.remove(); novoPonto.current = null; return; }
    el.classList.add("mapa-marcando");
    const clicar = (e: { latlng: { lat: number; lng: number } }) => colocarPonto(e.latlng);
    m.on("click", clicar);
    return () => { m.off("click", clicar); };
  }, [marcando]);

  function colocarPonto(ll: { lat: number; lng: number }) {
    const mod = L.current, m = mapa.current;
    if (!mod || !m) return;
    setPonto(ll);
    if (novoPonto.current) { novoPonto.current.setLatLng(ll); return; }
    novoPonto.current = mod.marker(ll, {
      draggable: true, icon: mod.divIcon({ className: "marcador-obra marcador-novo", iconSize: [30, 30], iconAnchor: [15, 15], html: "<span></span>" }),
    }).addTo(m);
    novoPonto.current.on("dragend", () => setPonto(novoPonto.current!.getLatLng()));
  }

  async function abrir(o: ObraNoMapa) {
    if (marcando) return;
    setSelecionada(o.id);
    setErro(null);
    if (o.latitude != null && o.longitude != null) mapa.current?.flyTo([o.latitude, o.longitude], 18, { duration: 1.1 });
    if (ficha?.id === o.id) return;
    setFicha(null);
    setCarregandoFicha(true);
    try {
      const r = await fetch(`/mapa/obra/${o.id}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) setErro(j.erro ?? "Não foi possível abrir a ficha da obra.");
      else setFicha(j as FichaObra);
    } catch {
      setErro("Sem conexão para abrir a ficha da obra.");
    } finally {
      setCarregandoFicha(false);
    }
  }

  function fechar() {
    setSelecionada(null);
    setFicha(null);
    const mod = L.current;
    if (mod && mapa.current && localizadas.length)
      mapa.current.flyToBounds(mod.latLngBounds(localizadas.map((o) => [o.latitude!, o.longitude!] as [number, number])).pad(0.25), { maxZoom: 16, duration: 0.9 });
  }

  function comecarMarcacao(o: ObraNoMapa) {
    setErro(null); setPonto(null); setMarcando(o);
    if (o.latitude != null && o.longitude != null) mapa.current?.flyTo([o.latitude, o.longitude], 18, { duration: 0.8 });
    caixa.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function minhaLocalizacao() {
    navigator.geolocation?.getCurrentPosition(
      (p) => { const ll = { lat: p.coords.latitude, lng: p.coords.longitude }; mapa.current?.flyTo(ll, 18); if (marcando) colocarPonto(ll); },
      () => setErro("Não foi possível obter a localização do aparelho."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function salvar() {
    if (!marcando || !ponto) return;
    iniciar(async () => {
      const r = await acaoDefinirLocal(marcando.id, ponto.lat, ponto.lng);
      if (r.erro) { setErro(r.erro); return; }
      setMarcando(null); setPonto(null);
      if (ficha?.id === marcando.id) setFicha({ ...ficha, latitude: ponto.lat, longitude: ponto.lng });
      router.refresh();
    });
  }

  return (
    <div className="mapa-obras">
      <div className="mapa-filtros">
        <div className="chips">
          <button className={`chip ${!situacao ? "chip-ativo" : ""}`} onClick={() => setSituacao("")}>Todas <small className="num">{obras.length}</small></button>
          {situacoes.map((s) => (
            <button key={s} className={`chip ${situacao === s ? "chip-ativo" : ""}`} onClick={() => setSituacao(situacao === s ? "" : s)}>
              <i className="mapa-ponto" style={{ background: COR_SITUACAO[s] }} />{ROTULO_SITUACAO[s]} <small className="num">{obras.filter((o) => o.situacao === s).length}</small>
            </button>
          ))}
        </div>
        {comSemaforo && (
          <div className="chips">
            {(["vermelho", "amarelo", "verde"] as const).map((n) => (
              <button key={n} className={`chip ${nivel === n ? "chip-ativo" : ""}`} onClick={() => setNivel(nivel === n ? "" : n)}>
                <i className="mapa-ponto" style={{ background: COR_NIVEL[n] }} />{ROTULO_NIVEL[n]} <small className="num">{obras.filter((o) => o.nivel === n).length}</small>
              </button>
            ))}
            <span className="mapa-cor-por">
              Cor por
              <button className={`chip ${corPor === "semaforo" ? "chip-ativo" : ""}`} onClick={() => setCorPor("semaforo")}>Semáforo</button>
              <button className={`chip ${corPor === "situacao" ? "chip-ativo" : ""}`} onClick={() => setCorPor("situacao")}>Situação</button>
            </span>
          </div>
        )}
      </div>

      <div className="mapa-grade">
        <section className="cartao mapa-cartao">
          {marcando && (
            <div className="mapa-barra-marcar">
              <Crosshair />
              <span>{ponto ? <>Local de <b>{marcando.codigo}</b> marcado. Arraste o ponto para ajustar.</> : <>Toque no mapa no local de <b>{marcando.codigo} · {marcando.nome}</b>.</>}</span>
              <span style={{ flex: 1 }} />
              <button className="botao botao-neutro botao-pequeno" onClick={minhaLocalizacao}><LocateFixed /> Minha localização</button>
              <button className="botao botao-primario botao-pequeno" onClick={salvar} disabled={!ponto || salvando}>{salvando ? "Salvando…" : "Salvar local"}</button>
              <button className="botao botao-texto botao-pequeno" onClick={() => { setMarcando(null); setPonto(null); setErro(null); }} aria-label="Cancelar"><X /></button>
            </div>
          )}
          {erro && <div className="aviso aviso-erro" style={{ margin: "0 0 10px" }}>{erro}</div>}
          <div className="mapa-moldura">
            <div ref={caixa} className="mapa-tela" role="region" aria-label="Mapa das obras" />
            <div className="mapa-fundos" role="group" aria-label="Fundo do mapa">
              <button className={fundo === "satelite" ? "ativo" : ""} onClick={() => setFundo("satelite")} aria-pressed={fundo === "satelite"}>Satélite</button>
              <button className={fundo === "ruas" ? "ativo" : ""} onClick={() => setFundo("ruas")} aria-pressed={fundo === "ruas"}>Mapa</button>
            </div>
          </div>
          <div className="mapa-legenda">
            {corPor === "semaforo"
              ? <>{(["verde", "amarelo", "vermelho"] as const).map((n) => <span key={n}><i className="mapa-ponto" style={{ background: COR_NIVEL[n] }} />{ROTULO_NIVEL[n]}</span>)}<span><i className="mapa-ponto" style={{ background: SEM_SEMAFORO }} />Fora do painel gerencial</span></>
              : situacoes.map((s) => <span key={s}><i className="mapa-ponto" style={{ background: COR_SITUACAO[s] }} />{ROTULO_SITUACAO[s]}</span>)}
            {obraSel && <span><i className="mapa-area" />Área aproximada da obra</span>}
          </div>
        </section>

        {obraSel ? (
          <Ficha obra={obraSel} ficha={ficha?.id === obraSel.id ? ficha : null} carregando={carregandoFicha} podeEditar={podeEditar}
            aoFechar={fechar} aoCorrigirLocal={() => comecarMarcacao(obraSel)} />
        ) : (
          <aside className="cartao mapa-lista">
            <h2 className="cartao-titulo">Obras no mapa <span className="fraco num">{localizadas.length}</span></h2>
            {localizadas.length === 0 ? <p className="cartao-sub" style={{ marginTop: 8 }}>Nenhuma obra localizada com este filtro.</p> : (
              <ul>
                {localizadas.map((o) => (
                  <li key={o.id}>
                    <button className="mapa-item" onClick={() => abrir(o)}>
                      <i className="mapa-ponto" style={{ background: cor(o) }} />
                      <span style={{ minWidth: 0 }}>
                        <b>{o.codigo} · {o.nome}</b>
                        <small>{[o.municipio, ROTULO_SITUACAO[o.situacao], o.executadoPct != null ? `${pct(o.executadoPct)} medido` : null].filter(Boolean).join(" · ")}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {semLocal.length > 0 && (
              <>
                <h3 className="subtitulo-secao">Sem localização <span className="fraco num">{semLocal.length}</span></h3>
                <ul>
                  {semLocal.map((o) => (
                    <li key={o.id}>
                      <div className="mapa-item mapa-item-sem">
                        <span style={{ minWidth: 0 }}>
                          <Link href={`/obras/${o.id}`}><b>{o.codigo} · {o.nome}</b></Link>
                          <small><EtiquetaSituacao situacao={o.situacao} /></small>
                        </span>
                      </div>
                      {podeEditar && <button className="botao botao-neutro botao-pequeno" onClick={() => comecarMarcacao(o)}><MapPin /> Marcar</button>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ficha da obra
// ---------------------------------------------------------------------------
function Ficha({ obra, ficha, carregando, podeEditar, aoFechar, aoCorrigirLocal }: {
  obra: ObraNoMapa; ficha: FichaObra | null; carregando: boolean; podeEditar: boolean; aoFechar: () => void; aoCorrigirLocal: () => void;
}) {
  const [copiado, setCopiado] = useState(false);
  const lat = ficha?.latitude ?? obra.latitude, lon = ficha?.longitude ?? obra.longitude;
  const temLocal = lat != null && lon != null;
  const copiar = async () => {
    if (!temLocal) return;
    try { await navigator.clipboard.writeText(`${lat!.toFixed(6)}, ${lon!.toFixed(6)}`); setCopiado(true); setTimeout(() => setCopiado(false), 1800); } catch { /* sem permissão */ }
  };
  const linha = (k: string, v: React.ReactNode) => (v == null || v === "" ? null : <><dt>{k}</dt><dd>{v}</dd></>);

  return (
    <aside className="cartao mapa-ficha" aria-label={`Ficha da obra ${obra.codigo}`}>
      <div className="ficha-topo">
        <div style={{ minWidth: 0 }}>
          <div className="sobretitulo num">{obra.codigo}</div>
          <h2 className="ficha-titulo">{obra.nome}</h2>
          <div className="ficha-etiquetas">
            <EtiquetaSituacao situacao={obra.situacao} />
            {obra.nivel && <span className={`etiqueta ${obra.nivel === "vermelho" ? "et-vermelha" : obra.nivel === "amarelo" ? "et-laranja" : "et-verde"}`}>{ROTULO_NIVEL[obra.nivel]}</span>}
          </div>
        </div>
        <button className="redondo-claro" onClick={aoFechar} aria-label="Fechar ficha" title="Fechar"><X /></button>
      </div>

      <div className="ficha-acoes">
        <Link href={`/obras/${obra.id}`} className="botao botao-primario botao-pequeno"><ExternalLink /> Abrir obra</Link>
        {temLocal && <>
          <a href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`} target="_blank" rel="noreferrer" className="botao botao-neutro botao-pequeno"><ScanEye /> Street View</a>
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`} target="_blank" rel="noreferrer" className="botao botao-neutro botao-pequeno"><Navigation /> Rota</a>
        </>}
        {podeEditar && <button className="botao botao-texto botao-pequeno" onClick={aoCorrigirLocal}><MapPin /> Corrigir local</button>}
      </div>

      {carregando && !ficha && <div className="esqueleto" style={{ marginTop: 16 }}><span className="esq esq-linha" /><span className="esq esq-cartao" style={{ height: 120 }} /><span className="esq esq-linha" /></div>}

      {ficha && (
        <div className="ficha-corpo">
          <section>
            <h3>Localização</h3>
            <dl>
              {linha("Endereço", ficha.endereco)}
              {linha("Município", [ficha.municipio, ficha.uf].filter(Boolean).join(" / "))}
              {temLocal && linha("Coordenadas", <span className="ficha-coord num">{coord(lat!)}, {coord(lon!)} <button onClick={copiar} aria-label="Copiar coordenadas" title="Copiar"><Copy /></button>{copiado && <small>copiado</small>}</span>)}
            </dl>
          </section>

          {(obra.previstoPct != null || obra.executadoPct != null) && (
            <section>
              <h3>Andamento</h3>
              {obra.previstoPct != null && <Barra rotulo="Previsto até hoje" valor={obra.previstoPct} cor="#7b8c93" />}
              {obra.realizadoPct != null && <Barra rotulo="Executado (físico)" valor={obra.realizadoPct} cor="#f28c28" />}
              {obra.executadoPct != null && <Barra rotulo="Medido (financeiro)" valor={obra.executadoPct} cor="#0b7d8a" />}
            </section>
          )}

          {obra.motivos.length > 0 && (
            <section>
              <h3>Alertas</h3>
              <ul className="ficha-alertas">
                {obra.motivos.map((m, i) => <li key={i} className={m.nivel === "vermelho" ? "motivo-vermelho" : "motivo-amarelo"}><Link href={m.href}>{m.texto}</Link></li>)}
              </ul>
            </section>
          )}

          {ficha.contratos && ficha.contratos.length > 0 && (
            <section>
              <h3>{ficha.contratos.length === 1 ? "Contrato" : "Contratos"}</h3>
              {ficha.contratos.map((k) => (
                <div key={k.id} className="ficha-bloco">
                  <Link href={`/contratos/${k.id}`} className="forte">Contrato {k.numero}</Link>
                  <dl>
                    {linha("Executor", k.empresa ? `${k.empresa}${k.cnpj ? ` · ${k.cnpj}` : ""}` : "Execução direta")}
                    {linha("Valor atual", <span className="num">{moeda(k.valor)}</span>)}
                    {linha("Medido", <span className="num">{moeda(k.medido)} ({pct(k.executadoPct)})</span>)}
                    {linha("Pago", <span className="num">{moeda(k.pago)}</span>)}
                    {linha("Saldo", <span className="num">{moeda(k.saldo)}</span>)}
                    {linha("Término previsto", dataBr(k.terminoPrevisto))}
                    {linha("Vigência", k.vigenciaFim ? `${dataBr(k.vigenciaFim)}${k.diasParaVencer != null ? (k.diasParaVencer < 0 ? ` · encerrada há ${-k.diasParaVencer} dias` : ` · ${k.diasParaVencer} dias`) : ""}` : null)}
                    {linha("Aditivos", k.aditivos ? String(k.aditivos) : null)}
                    {linha("Gestor", k.gestor)}
                    {linha("Fiscal", k.fiscal)}
                  </dl>
                </div>
              ))}
            </section>
          )}

          {ficha.diario && (
            <section>
              <h3>Campo</h3>
              {ficha.diario.ultimo ? (
                <div className="ficha-bloco">
                  <Link href={`/diario/${ficha.diario.ultimo.id}`} className="forte">Diário nº {ficha.diario.ultimo.numero} · {dataBr(ficha.diario.ultimo.data)}</Link>
                  <dl>
                    {linha("Situação", `${ficha.diario.ultimo.situacao}${ficha.diario.ultimo.visto ? " · com visto" : ""}`)}
                    {linha("Clima", ficha.diario.ultimo.clima)}
                    {linha("Condição", ficha.diario.ultimo.condicao)}
                    {linha("Efetivo", ficha.diario.ultimo.efetivo ? `${ficha.diario.ultimo.efetivo} ${ficha.diario.ultimo.efetivo === 1 ? "pessoa" : "pessoas"}` : null)}
                  </dl>
                  {ficha.diario.ultimo.relato && <p className="ficha-relato">{ficha.diario.ultimo.relato}</p>}
                </div>
              ) : <p className="cartao-sub">Nenhum diário registrado.</p>}
              <div className="ficha-numeros">
                <div><b className="num">{ficha.diario.noMes}</b><span>diários no mês</span></div>
                <div><b className="num">{ficha.diario.semVisto}</b><span>sem visto</span></div>
                <div><b className="num">{num(ficha.diario.horasParadas, 1)} h</b><span>paradas</span></div>
                <div><b className="num">{ficha.diario.diasChuva}</b><span>dias de chuva</span></div>
              </div>
            </section>
          )}

          {(ficha.equipeHoje || ficha.qualidade || ficha.seguranca) && (
            <section>
              <h3>Hoje na obra</h3>
              <div className="ficha-numeros">
                {ficha.equipeHoje && <><div><b className="num">{ficha.equipeHoje.pessoas}</b><span>pessoas alocadas</span></div><div><b className="num">{ficha.equipeHoje.equipamentos}</b><span>equipamentos</span></div></>}
                {ficha.qualidade && <div className={ficha.qualidade.graves ? "ficha-alerta" : ""}><b className="num">{ficha.qualidade.abertas}</b><span>não conformidades abertas{ficha.qualidade.graves ? ` · ${ficha.qualidade.graves} graves` : ""}</span></div>}
                {ficha.seguranca && <div><b className="num">{ficha.seguranca.diasSemAcidente ?? "—"}</b><span>dias sem acidente</span></div>}
                {ficha.seguranca && ficha.seguranca.abertas > 0 && <div className="ficha-alerta"><b className="num">{ficha.seguranca.abertas}</b><span>ocorrências de segurança abertas</span></div>}
              </div>
            </section>
          )}

          {ficha.fotos.length > 0 && (
            <section>
              <h3>Fotos recentes</h3>
              <div className="ficha-fotos">
                {ficha.fotos.map((f) => (
                  <a key={f.id} href={`/fotos/${f.id}`} target="_blank" rel="noreferrer" title={`${f.legenda ?? "Foto"} · ${dataHora(f.em)}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/fotos/${f.id}?mini`} alt={f.legenda ?? "Foto da obra"} loading="lazy" />
                    <span>{dataHora(f.em).slice(0, 5)}{f.latitude != null ? " · GPS" : ""}</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>Identificação</h3>
            <dl>
              {linha("Tipo", ficha.tipo)}
              {linha("Execução", ficha.forma)}
              {linha("Área", ficha.areaM2 != null ? `${num(ficha.areaM2, 2)} m²` : null)}
              {linha("Extensão", ficha.extensaoM != null ? `${num(ficha.extensaoM, 2)} m` : null)}
              {linha("Fonte de recurso", ficha.fonteRecurso)}
              {linha("Convênio", ficha.convenio)}
              {linha("Processo", ficha.processo)}
              {linha("Licitação", ficha.licitacao)}
              {linha("ART/RRT", ficha.art)}
              {linha("Ordem de serviço", ficha.ordemServico ? `${ficha.ordemServico}${ficha.ordemServicoData ? ` · ${dataBr(ficha.ordemServicoData)}` : ""}` : null)}
              {linha("Início previsto", ficha.inicioPrevisto ? dataBr(ficha.inicioPrevisto) : null)}
              {linha("Fim previsto", ficha.fimPrevisto ? dataBr(ficha.fimPrevisto) : null)}
            </dl>
          </section>

          {ficha.responsaveis.length > 0 && (
            <section>
              <h3>Equipe da obra no sistema</h3>
              <dl>{ficha.responsaveis.map((r, i) => <span key={i} style={{ display: "contents" }}>{linha(r.papel, r.nome)}</span>)}</dl>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

function Barra({ rotulo, valor, cor }: { rotulo: string; valor: number; cor: string }) {
  const v = Math.max(0, Math.min(100, valor));
  return (
    <div className="ficha-barra">
      <div><span>{rotulo}</span><b className="num">{pct(valor)}</b></div>
      <i><em style={{ width: `${v}%`, background: cor }} /></i>
    </div>
  );
}

/** Texto do marcador, montado com nós de texto: o nome da obra nunca vira HTML. */
function rotuloMarcador(o: ObraNoMapa): HTMLElement {
  const el = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = `${o.codigo} · ${o.nome}`;
  const s = document.createElement("span");
  s.textContent = [ROTULO_SITUACAO[o.situacao], o.municipio].filter(Boolean).join(" · ");
  el.append(b, s);
  return el;
}

function textoSeguro(t: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = t;
  return el;
}
