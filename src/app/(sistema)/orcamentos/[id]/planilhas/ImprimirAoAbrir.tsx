"use client";

import { useEffect } from "react";

/** Abre a janela de impressão (salvar em PDF) assim que a página carrega. */
export function ImprimirAoAbrir() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, []);
  return null;
}
