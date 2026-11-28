import { describe, expect, it } from "vitest";
import { lerNumeroBr, lerValorBr, texto } from "../src/lib/decimal";
import { diasSemAcidente } from "../src/servicos/campo";
import { comparar, type MaterialC, type PropostaC } from "../src/servicos/cotacao-calculo";

describe("valor em reais", () => {
  it("1.500 é mil e quinhentos só nos campos de valor", () => {
    expect(texto(lerValorBr("1.500")!)).toBe("1500.00");
    expect(texto(lerValorBr("12.345.678")!)).toBe("12345678.00");
    expect(texto(lerValorBr("1.500,25")!)).toBe("1500.25");
    expect(texto(lerValorBr("1.5")!)).toBe("1.50");
    expect(texto(lerValorBr("150")!)).toBe("150.00");
    expect(texto(lerNumeroBr("1.500")!, 3)).toBe("1.500");
  });
});

describe("frete no comparativo", () => {
  const mat = (id: string, q: string): MaterialC => ({ id, codigo: id, descricao: id, unidade: "un", quantidade: q, precoReferencia: "10.00", semSinapi: false });
  const prop = (id: string, precos: Record<string, string>, frete?: string): PropostaC => ({
    conviteId: id, fornecedor: id, enviadaEm: "2026-01-01T00:00:00Z", prazoEntrega: 1, pagamentoDias: null, garantiaMeses: null, historico: null, frete,
    itens: Object.fromEntries(Object.entries(precos).map(([k, v]) => [k, { preco: v, marca: "M", modelo: null, indisponivel: false }])),
  });
  it("rateia o frete pelos itens e compara o preço com frete", () => {
    const m = comparar([mat("a", "10"), mat("b", "10")], [prop("x", { a: "9.00", b: "11.00" }, "20.00"), prop("y", { a: "9.50", b: "11.50" })], [], "arredondar");
    const x = m.linhas[0].ofertas[0];
    expect(x).toMatchObject({ preco: "9.9000", precoSemFrete: "9.0000", total: "99.00" });
    expect(m.fornecedores[0]).toMatchObject({ total: "220.00", frete: "20.00" });
    expect(m.linhas[0].menor?.conviteId).toBe("y");
  });
});

describe("dias sem acidente", () => {
  it("conta do último acidente; sem acidente, do início da obra", () => {
    expect(diasSemAcidente("2026-11-20", "2026-01-01", "2026-11-28")).toBe(8);
    expect(diasSemAcidente(null, "2026-11-01", "2026-11-28")).toBe(27);
    expect(diasSemAcidente(null, null, "2026-11-28")).toBeNull();
    expect(diasSemAcidente(null, "2026-12-10", "2026-11-28")).toBeNull();
  });
});
