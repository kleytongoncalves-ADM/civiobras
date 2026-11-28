import Link from "next/link";
import { EtiquetaOrcamento } from "@/componentes/EtiquetaOrcamento";
import { mesAno, moeda, percentual } from "@/lib/formato";
import { rotuloOrcamento } from "@/servicos/orcamentos";
import { ROTULO_FONTE, ROTULO_REGIME } from "@/servicos/precos";
import { Suspense } from "react";
import { AbasOrcamento, PassosOrcamento } from "./AbasOrcamento";
import { carregarOrcamento } from "./carregar";

export default async function LayoutOrcamento({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orcamento: o } = await carregarOrcamento(id);
  const total = Number(o.totais.custo) || 1;
  const fatia = (v: string) => `${Math.max(0, (Number(v) / total) * 100)}%`;
  return (
    <>
      <div className="cabecalho nao-imprimir">
        <div style={{ minWidth: 0 }}>
          <div className="sobretitulo">
            <Link href="/orcamentos">Orçamentos</Link><span>/</span>
            <Link href={`/obras/${o.obraId}`} className="num">{o.obraCodigo}</Link><span>/</span>
            <span className="num">{rotuloOrcamento(o)}</span>
          </div>
          <h1 className="titulo">{o.nome}</h1>
          <p className="subtitulo" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <EtiquetaOrcamento situacao={o.situacao} />
            <span>{o.obraNome}</span>
            <span>· {o.bases.map((b) => `${ROTULO_FONTE[b.fonte]} ${mesAno(b.mes)}`).join(" + ")} · {o.uf} · {ROTULO_REGIME[o.regime]} · {o.arredondamento === "truncar" ? "Trunca" : "Arredonda"} em 2 casas</span>
          </p>
        </div>
      </div>

      <div className="indicadores nao-imprimir">
        <div className="indicador surgir" style={{ "--i": 0 } as React.CSSProperties}>
          <span>Custo direto</span><b className="num">{moeda(o.totais.custo)}</b>
        </div>
        <div className="indicador surgir" style={{ "--i": 1 } as React.CSSProperties}>
          <span>BDI {percentual(o.bdiObraPct)}</span><b className="num">{moeda(o.totais.bdi)}</b>
        </div>
        <div className="indicador indicador-destaque surgir" style={{ "--i": 2 } as React.CSSProperties}>
          <span>Total com BDI</span><b className="num">{moeda(o.totais.total)}</b>
        </div>
        <div className="indicador surgir" style={{ "--i": 3 } as React.CSSProperties}>
          <span>Material · Mão de obra · Equipamento</span>
          <div className="barra-composicao" aria-hidden="true">
            <i style={{ width: fatia(o.totais.material) }} /><i style={{ width: fatia(o.totais.maoDeObra) }} /><i style={{ width: fatia(o.totais.equipamento) }} />
          </div>
          <small className="num">{moeda(o.totais.material)} · {moeda(o.totais.maoDeObra)} · {moeda(o.totais.equipamento)}</small>
        </div>
      </div>

      {o.situacao === "rascunho" && (
        <Suspense fallback={null}>
          <PassosOrcamento id={id} feitos={[true, !!o.modoMontagem, o.etapas.some((e) => e.itens.length > 0), o.pendencias.length === 0, false]} />
        </Suspense>
      )}
      <AbasOrcamento id={id} />
      {children}
    </>
  );
}
