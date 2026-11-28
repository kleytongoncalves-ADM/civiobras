import { describe, expect, it } from "vitest";
import { nomeLegivel } from "../src/lib/formato";
import type { InsumoDoItem, Item } from "../src/servicos/orcamentos";
import { analiticaDoItem } from "../src/servicos/planilhas";

const insumo = (p: Partial<InsumoDoItem>): InsumoDoItem => ({
  id: Math.random().toString(), codigo: "1", descricao: "X", unidade: "UN", tipo: "material", coeficiente: "1", preco: "1",
  fonte: "sinapi", ordem: 1, auxiliarCodigo: null, auxiliarDescricao: null, auxiliarUnidade: null, auxiliarCoeficiente: null, ...p,
});
const item = { id: "i", numero: "1.1", custoUnitario: "30.00" } as unknown as Item;

describe("planilha analítica", () => {
  it("separa insumos diretos e composição auxiliar, com o custo da auxiliar tirado dos próprios insumos", () => {
    const r = analiticaDoItem(item, [
      insumo({ codigo: "88316", descricao: "SERVENTE", tipo: "mao_de_obra", coeficiente: "0.5", preco: "20" }),
      // Argamassa (auxiliar, 0,02 m³ por unidade do serviço): 400 kg de cimento × R$ 0,50 e 1 m³ de areia × R$ 100 por m³.
      insumo({ codigo: "1379", descricao: "CIMENTO", coeficiente: "8", preco: "0.5", auxiliarCodigo: "87292", auxiliarDescricao: "ARGAMASSA", auxiliarUnidade: "M3", auxiliarCoeficiente: "0.02" }),
      insumo({ codigo: "370", descricao: "AREIA", coeficiente: "0.02", preco: "100", auxiliarCodigo: "87292", auxiliarDescricao: "ARGAMASSA", auxiliarUnidade: "M3", auxiliarCoeficiente: "0.02" }),
    ]);
    expect(r.linhas.map((l) => [l.nivel, l.tipo, l.codigo])).toEqual([[0, "insumo", "88316"], [0, "auxiliar", "87292"], [1, "insumo", "1379"], [1, "insumo", "370"]]);
    const aux = r.linhas[1];
    expect(aux.coeficiente).toBeCloseTo(0.02);
    expect(aux.preco).toBeCloseTo(300); // 400 × 0,50 + 1 × 100
    expect(aux.parcial).toBeCloseTo(6);
    expect(r.linhas[2].coeficiente).toBeCloseTo(400);
    expect(r.soma).toBeCloseTo(16);
  });

  it("insumo sem preço deixa a soma em aberto, sem inventar valor", () => {
    const r = analiticaDoItem(item, [insumo({ preco: null }), insumo({ preco: "2" })]);
    expect(r.linhas[0].parcial).toBeNull();
    expect(r.soma).toBeNull();
  });
});

describe("nome legível", () => {
  it("tira o sufixo AF, passa para minúsculas e preserva siglas e unidades", () => {
    expect(nomeLegivel("ALVENARIA DE VEDAÇÃO DE BLOCOS CERÂMICOS 9X19X19 CM, FBK = 10 MPA. AF_08/2026"))
      .toBe("Alvenaria de vedação de blocos cerâmicos 9×19×19 cm, fbk = 10 MPa");
  });
  it("mantém o texto do SCO-Rio, que já vem com maiúsculas e minúsculas", () => {
    expect(nomeLegivel("Muro de pedra argamassada")).toBe("Muro de pedra argamassada");
  });
});
