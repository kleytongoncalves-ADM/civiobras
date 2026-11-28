import { afterAll, describe, expect, it } from "vitest";
import { fecharPool, pool } from "../src/lib/db";
import { gravarCargaSinapi } from "../src/servicos/importador-sinapi";
import {
  classificacoesDe, codigoSco, gravarClassificacoesSco, lerComposicao, lerLista, montarCargaSco, opcoesDoSelect, separarOpcao,
} from "../src/servicos/importador-sco";
import { buscarComposicoes, listarTabelas } from "../src/servicos/precos";
import { novoOrgao, novoUsuario } from "./apoio";

afterAll(fecharPool);

const tr = (cels: string[]) => `<tr>${cels.map((c) => `<td class="x">${c}</td>`).join("")}</tr>`;

/** Página de composição no layout do SCO-Rio. */
function paginaComposicao(d: { codigo: string; descricao: string; und: string; custo: string; linhas: string[][] }) {
  return `<html><body><table>
    ${tr(["Item de Serviço", d.codigo])}${tr(["Mês/Ano", "10/2026"])}
    ${tr(["Descrição", d.descricao])}${tr(["Custo", d.custo])}${tr(["Und.", d.und])}
  </table><table>
    ${tr(["Item Elementar", "Antigo", "Item Reutilizado", "Descrição", "Und", "Quantidade", "Custo Unitário", "Custo Parcial"])}
    ${d.linhas.map(tr).join("\n")}
  </table></body></html>`;
}

const muro = paginaComposicao({
  codigo: "AL 04.05.0050 (/)", descricao: "Alvenaria de pedra argamassada", und: "m3", custo: "578,29",
  linhas: [
    ["MAT095050", "103450", "", "Pedra de alvenaria de uma face", "m3", "1,20000000", "78,57", "94,28"],
    ["MAT001000", "100010", "", "Cimento Portland", "kg", "100,00000000", "0,80", "80,00"],
    ["MOD000100", "200100", "", "Pedreiro (desonerado)", "h", "8,00000000", "30,00", "240,00"],
    ["MOD000200", "200200", "", "Servente (desonerado)", "h", "4,98666667", "20,00", "99,73"],
    ["EVE000050", "900050", "", "3% incidente sobre mão de obra", "%", "1,00000000", "338,90", "10,17"],
    ["RSE000010", "", "AL 10.10.0050 (A)", "Argamassa de cimento e areia", "m3", "0,10000000", "541,10", "54,11"],
  ],
});
const argamassa = paginaComposicao({
  codigo: "AL 10.10.0050 (A)", descricao: "Argamassa de cimento e areia", und: "m3", custo: "541,10",
  linhas: [
    ["MAT001000", "100010", "", "Cimento Portland", "kg", "430,00000000", "0,80", "344,00"],
    ["MOD000200", "200200", "", "Servente (desonerado)", "h", "9,85500000", "20,00", "197,10"],
  ],
});

describe("leitura das páginas do SCO-Rio", () => {
  it("normaliza o código do item", () => {
    expect(codigoSco("AL 04.05.0050 (/)")).toBe("AL 04.05.0050");
    expect(codigoSco("AL 10.10.0050 (A)")).toBe("AL 10.10.0050(A)");
  });

  it("lê a composição e as linhas somam o custo publicado", () => {
    const k = lerComposicao(muro)!;
    expect(k).toMatchObject({ codigo: "AL 04.05.0050", unidade: "m3", custo: "578.29", mes: "2026-10-01" });
    expect(k.linhas).toHaveLength(6);
    expect(k.linhas[5].reutilizado).toBe("AL 10.10.0050(A)");
    const soma = k.linhas.reduce((s, l) => s + Number(l.custoParcial), 0);
    expect(soma.toFixed(2)).toBe("578.29");
  });

  it("lê a lista de resultados e o total", () => {
    const html = `<p>A pesquisa retornou 2 item(ns) na página em um total de 2. Esta página lista do item 1 ao item 2.</p><table>
      <tr><td><a href="composicaosco.cfm?item=1AL04050050%2F202610">AL 04.05.0050 (/)</a></td><td>Alvenaria de pedra</td><td>m3</td><td>578,29</td></tr>
      ${tr(["AL 10.10.0050 (A)", "Argamassa", "m3", "541,10"])}</table>`;
    const l = lerLista(html);
    expect(l.total).toBe(2);
    expect(l.ate).toBe(2);
    expect(l.itens.map((i) => i.codigo)).toEqual(["AL 04.05.0050", "AL 10.10.0050(A)"]);
    expect(l.itens[0].endereco).toContain("composicaosco.cfm");
  });

  it("lê as opções dos filtros", () => {
    const html = `<select name="cla"><option value="">Todos</option><option value="4">04 - Alvenarias de pedra</option></select>`;
    const [, o] = opcoesDoSelect(html, "cla");
    expect(separarOpcao(o.texto)).toEqual({ codigo: "04", nome: "Alvenarias de pedra" });
  });

  it("monta a carga com taxa sobre a mão de obra e item reutilizado como auxiliar", () => {
    const carga = montarCargaSco([lerComposicao(muro)!, lerComposicao(argamassa)!], { mes: "2026-10-01", regime: "desonerado" });
    expect(carga.insumos.get("EVE000050")?.tipo).toBe("taxa");
    expect(carga.precos.desonerado.get("EVE000050")?.preco).toBe("0.0300");
    expect(carga.analitico).toContainEqual({ composicao: "AL 04.05.0050", tipo: "composicao", item: "AL 10.10.0050(A)", coeficiente: "0.10000000" });
    expect(carga.insumos.has("RSE000010")).toBe(false);
  });
});

describe("gravação do SCO-Rio", () => {
  it("confere com o custo publicado e liga as classificações aos assuntos", async () => {
    const carga = montarCargaSco([lerComposicao(muro)!, lerComposicao(argamassa)!], { mes: "2026-10-01", regime: "desonerado" });
    const arvore = classificacoesDe([{
      codigo: "AL", nome: "Alvenarias", clas: [
        { codigo: "04", nome: "Alvenarias de pedra", familias: [{ codigo: "05", nome: "Pedra argamassada" }] },
        { codigo: "10", nome: "Argamassas", familias: [{ codigo: "10", nome: "Cimento e areia" }] },
      ],
    }]);
    const c = await pool().connect();
    let r;
    try {
      await c.query("begin");
      r = await gravarCargaSinapi(c, carga, "sco");
      await gravarClassificacoesSco(c, arvore);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
    const d = r.find((x) => x.regime === "desonerado")!;
    expect(d).toMatchObject({ divergentes: 0, situacao: "liberada" });
    expect(d.conferidas).toBe(2);

    const eng = await novoUsuario(await novoOrgao(), "engenheiro");
    const tabela = (await listarTabelas(eng, { somenteLiberadas: true })).find((t) => t.fonte === "sco" && t.regime === "desonerado");
    expect(tabela).toBeTruthy();
    const [k] = await buscarComposicoes(eng, { tabelaId: tabela!.id, busca: "pedra argamassada" });
    expect(k).toMatchObject({ codigo: "AL 04.05.0050", custo: "578.29" });

    const { rows } = await pool().query(
      `select k.assunto_id, cl.nome from composicao k join classificacao cl on cl.id = k.classificacao_id where k.fonte = 'sco' and k.codigo = 'AL 04.05.0050'`,
    );
    expect(rows[0]).toMatchObject({ assunto_id: "alvenaria", nome: "Pedra argamassada" });
  });
});

describe("detalhes do layout real", () => {
  it("decodifica letras acentuadas e lê o item reutilizado sem espaço antes do sufixo", () => {
    const html = `<table>${tr(["Composi&ccedil;&atilde;o do Item de Servi&ccedil;o"])}
      ${tr(["Item de Servi&ccedil;o", "AL 04.05.0050 (/)", "M&ecirc;s/Ano de Refer&ecirc;ncia", "10/2026"])}
      ${tr(["Descri&ccedil;&atilde;o", "Alvenaria de pedra"])}${tr(["Custo", "10,17", "Und. de Medida", "m3"])}
      ${tr(["Item Elementar", "Antigo", "Item Reutilizado", "Descrição", "Und. de Medida", "Quantidade", "Custo Unitário R$", "Custo Parcial R$"])}
      ${tr(["RSE902050", "902998", "RV 04.10.0453(A)", "Argamassa", "m3", "0,02000000", "508,50", "10,17"])}</table>`;
    const k = lerComposicao(html)!;
    expect(k).toMatchObject({ codigo: "AL 04.05.0050", unidade: "m3", custo: "10.17", mes: "2026-10-01", descricao: "Alvenaria de pedra" });
    expect(k.linhas[0].reutilizado).toBe("RV 04.10.0453(A)");
  });
});
