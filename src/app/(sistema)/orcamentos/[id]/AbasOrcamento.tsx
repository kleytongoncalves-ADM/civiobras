"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Check } from "lucide-react";

const ABAS: [string, string][] = [
  ["", "Planilha"], ["/montar", "Montar"], ["/dados", "BDI e dados"], ["/cronograma", "Cronograma"], ["/abc", "Curva ABC"], ["/ifc", "IFC"],
  ["/cotacoes", "Cotações"], ["/planilhas", "Sintética e analítica"], ["/nota", "Nota"], ["/versoes", "Versões"],
];

export function AbasOrcamento({ id }: { id: string }) {
  const caminho = usePathname();
  const base = `/orcamentos/${id}`;
  const ativa = (s: string) => (s === "" ? caminho === base || caminho.startsWith(`${base}/itens`) || caminho.startsWith(`${base}/muro`) : caminho.startsWith(base + s));
  return (
    <nav className="abas nao-imprimir" aria-label="Seções do orçamento">
      {ABAS.map(([s, rotulo]) => (
        <Link key={s} href={base + s} className={`aba ${ativa(s) ? "aba-ativa" : ""}`} aria-current={ativa(s) ? "page" : undefined}>{rotulo}</Link>
      ))}
    </nav>
  );
}

/** Passos do assistente: identificação, como montar, serviços, revisão e planilhas. */
export function PassosOrcamento({ id, feitos }: { id: string; feitos: boolean[] }) {
  const caminho = usePathname();
  const busca = useSearchParams();
  const base = `/orcamentos/${id}`;
  const passos: { rotulo: string; sub: string; href: string; ativo: boolean }[] = [
    { rotulo: "Identificação", sub: "Dados do orçamento", href: `${base}/dados`, ativo: caminho.startsWith(`${base}/dados`) },
    { rotulo: "Como montar", sub: "Escolha o método", href: `${base}/montar?escolher=1`, ativo: caminho.startsWith(`${base}/montar`) && busca.has("escolher") },
    { rotulo: "Serviços", sub: "Selecione os itens", href: `${base}/montar`, ativo: caminho.startsWith(`${base}/montar`) && !busca.has("escolher") },
    { rotulo: "Revisão", sub: "Confira e organize", href: base, ativo: caminho === base || caminho.startsWith(`${base}/itens`) },
    { rotulo: "Planilhas", sub: "Veja e baixe", href: `${base}/planilhas`, ativo: caminho.startsWith(`${base}/planilhas`) },
  ];
  return (
    <ol className="passos nao-imprimir" aria-label="Passos do orçamento">
      {passos.map((p, i) => (
        <li key={p.rotulo} className={`${p.ativo ? "passo-ativo" : ""} ${feitos[i] ? "passo-feito" : ""}`}>
          <Link href={p.href} aria-current={p.ativo ? "step" : undefined}>
            <span className="passo-numero">{feitos[i] && !p.ativo ? <Check /> : i + 1}</span>
            <span className="passo-rotulo"><b>{p.rotulo}</b><small>{p.sub}</small></span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
