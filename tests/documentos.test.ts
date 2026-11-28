import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comContexto, fecharPool } from "../src/lib/db";
import { hoje } from "../src/servicos/campo";
import {
  baixarArt, dispensarExigencia, documentosDaObra, enviarDocumento, lerArquivo, novaVersao, obterDocumento, painelDocumentos, salvarDocumento, superarDocumento,
} from "../src/servicos/documentos";
import { avaliarObra, painelGerencial, type ObraGerencial } from "../src/servicos/gerencial";
import { criarObra, mudarSituacao, vincular, type Ator } from "../src/servicos/obras";
import { SemPermissao } from "../src/servicos/permissoes";
import { dadosObra, novoOrgao, novoUsuario } from "./apoio";

const pdf = (texto: string) => ({ nome: `${texto}.pdf`, conteudo: Buffer.from(`%PDF-1.4\n% ${texto}\n%%EOF`) });
const somar = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

let orgao: string, eng: Ator, direcao: Ator, campo: Ator, financeiro: Ator, outro: Ator;

beforeAll(async () => {
  orgao = await novoOrgao();
  eng = await novoUsuario(orgao, "engenheiro");
  direcao = await novoUsuario(orgao, "direcao");
  campo = await novoUsuario(orgao, "campo");
  financeiro = await novoUsuario(orgao, "financeiro");
  outro = await novoUsuario(await novoOrgao("Outro órgão"), "direcao");
});
afterAll(fecharPool);

const consulta = (sql: string, p: unknown[]) => comContexto({ usuarioId: null, orgaoId: orgao }, async (c) => (await c.query(sql, p)).rows);

describe("documentos", () => {
  it("versões numeradas, resumo SHA-256 e arquivo imutável", async () => {
    const obraId = await criarObra(eng, dadosObra());
    const id = await enviarDocumento(eng, obraId, { categoria: "projeto", tipo: "Projeto estrutural", titulo: "Estrutura do bloco A", emissao: "2026-10-01" }, pdf("rev0"));
    expect(await novaVersao(eng, id, pdf("rev1"), "Revisão das sapatas")).toBe(2);
    await expect(novaVersao(eng, id, pdf("rev2"), "  ")).rejects.toThrow(/mudou/);
    const d = await obterDocumento(eng, id);
    expect(d.versao).toBe(2);
    expect(d.versoes.map((v) => v.numero).sort()).toEqual([1, 2]);
    const v1 = d.versoes.find((v) => v.numero === 1)!;
    expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);
    const f = await lerArquivo(eng, v1.id);
    expect(f!.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(f!.mime).toBe("application/pdf");
    expect(await lerArquivo(outro, v1.id)).toBeNull();
    await expect(consulta("update documento_versao set mudanca = 'x' where id = $1", [v1.id])).rejects.toThrow();
    await expect(consulta("delete from documento_versao where id = $1", [v1.id])).rejects.toThrow();
    await expect(consulta("delete from documento where id = $1", [id])).rejects.toThrow();
  });

  it("confere arquivo, dados e permissões", async () => {
    const obraId = await criarObra(eng, dadosObra());
    const base = { categoria: "laudo", tipo: "Sondagem do solo", titulo: "Sondagem SPT" };
    await expect(enviarDocumento(eng, obraId, base, { nome: "x.exe", conteudo: Buffer.from("MZ") })).rejects.toThrow(/não aceito/);
    await expect(enviarDocumento(eng, obraId, base, { nome: "falso.pdf", conteudo: Buffer.from("texto") })).rejects.toThrow(/PDF válido/);
    await expect(enviarDocumento(eng, obraId, base, { nome: "grande.pdf", conteudo: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(4 * 1024 * 1024)]) })).rejects.toThrow(/4 MB/);
    await expect(enviarDocumento(eng, obraId, { ...base, emissao: "2026-10-10", validade: "2026-10-01" }, pdf("a"))).rejects.toThrow(/posterior/);
    await expect(enviarDocumento(eng, obraId, { ...base, exigencia: "alvara" }, pdf("a"))).rejects.toThrow(/pertence/);
    await expect(enviarDocumento(campo, obraId, base, pdf("a"))).rejects.toThrow(SemPermissao);
    await expect(enviarDocumento(outro, obraId, base, pdf("a"))).rejects.toThrow();
    await expect(enviarDocumento(eng, obraId, { categoria: "art_rrt", tipo: "ART de execução", titulo: "ART" }, pdf("a"))).rejects.toThrow(/número/);
    await expect(enviarDocumento(eng, obraId, { categoria: "art_rrt", tipo: "ART de execução", titulo: "ART", numero: "RJ1" }, pdf("a"))).rejects.toThrow(/conselho/);
    const png = await enviarDocumento(eng, obraId, { ...base, titulo: "Foto" }, { nome: "C:\\fotos\\furo.PNG", conteudo: Buffer.from([0x89, 0x50]) });
    const d = await obterDocumento(eng, png);
    expect(d.arquivo).toBe("furo.PNG");
    expect(d.mime).toBe("image/png");
    await vincular(direcao, obraId, financeiro.id, "financeiro");
    expect((await documentosDaObra(financeiro, obraId)).podeEnviar).toBe(false);
  });

  it("substituição, baixa da ART e validade", async () => {
    const obraId = await criarObra(eng, dadosObra());
    const h = hoje();
    const art = await enviarDocumento(eng, obraId, {
      categoria: "art_rrt", tipo: "ART de execução", titulo: "ART de execução", numero: "RJ2026000999", conselho: "CREA", profissional: "Eng. Teste", exigencia: "art_execucao",
    }, pdf("art"));
    const alvara = await enviarDocumento(eng, obraId, { categoria: "licenca", tipo: "Alvará de obra", titulo: "Alvará 1", emissao: somar(h, -60), validade: somar(h, 10), exigencia: "alvara" }, pdf("alv"));
    const vencida = await enviarDocumento(eng, obraId, { categoria: "licenca", tipo: "Licença ambiental de instalação", titulo: "LI antiga", emissao: somar(h, -400), validade: somar(h, -5) }, pdf("li"));
    let lista = await documentosDaObra(eng, obraId);
    const sit = (id: string) => lista.documentos.find((d) => d.id === id)!.situacao;
    expect(sit(alvara)).toBe("vencendo");
    expect(sit(vencida)).toBe("vencido");
    expect(sit(art)).toBe("vigente");
    expect(lista.vencidos).toBe(1);
    expect(lista.vencendo).toBe(1);

    await expect(superarDocumento(eng, alvara, art, "Troca")).rejects.toThrow(/mesma obra e categoria/);
    await expect(superarDocumento(eng, alvara, alvara, "Troca")).rejects.toThrow();
    const novo = await enviarDocumento(eng, obraId, { categoria: "licenca", tipo: "Alvará de obra", titulo: "Alvará 2", emissao: h, validade: somar(h, 365), exigencia: "alvara" }, pdf("alv2"));
    await superarDocumento(eng, alvara, novo, "Renovação do alvará");
    await expect(novaVersao(eng, alvara, pdf("x"), "Teste")).rejects.toThrow(/superado/);
    await expect(salvarDocumento(eng, alvara, { tipo: "Alvará de obra", titulo: "Outro" })).rejects.toThrow(/superado/);
    await expect(superarDocumento(eng, vencida, alvara, "Teste")).rejects.toThrow(/também está superado/);
    lista = await documentosDaObra(eng, obraId);
    expect(sit(alvara)).toBe("superado");
    expect(lista.exigencias.find((e) => e.chave === "alvara")!.documento!.id).toBe(novo);
    expect((await obterDocumento(eng, novo)).superadoDe.map((s) => s.id)).toEqual([alvara]);

    await expect(baixarArt(eng, alvara, h)).rejects.toThrow();
    await expect(baixarArt(eng, novo, h)).rejects.toThrow(/Só ART/);
    await expect(baixarArt(eng, art, somar(h, 3))).rejects.toThrow(/inválida/);
    await baixarArt(eng, art, h);
    await expect(baixarArt(eng, art, h)).rejects.toThrow(/já está baixada/);
    await expect(consulta("update documento set baixada_em = null where id = $1", [art])).rejects.toThrow(/não se desfaz/);
    lista = await documentosDaObra(eng, obraId);
    expect(sit(art)).toBe("baixada");
  });

  it("exigências atendidas por documento ou dispensa", async () => {
    const obraId = await criarObra(eng, dadosObra({ formaExecucao: "direta" }));
    let lista = await documentosDaObra(eng, obraId);
    const chaves = lista.exigencias.map((e) => e.chave);
    expect(chaves).toContain("art_execucao");
    expect(chaves).not.toContain("art_fiscalizacao");
    expect(chaves).not.toContain("ordem_servico");
    expect(lista.exigencias.every((e) => !e.atendida)).toBe(true);
    expect(lista.pendentes).toBe(0); // obra ainda não está em execução

    await expect(dispensarExigencia(eng, obraId, "licenca_ambiental", "curta")).rejects.toThrow(/Justifique/);
    await expect(dispensarExigencia(campo, obraId, "licenca_ambiental", "Obra de pequeno porte, sem impacto.")).rejects.toThrow(SemPermissao);
    await dispensarExigencia(direcao, obraId, "licenca_ambiental", "Reforma interna sem impacto ambiental, dispensada pelo órgão ambiental.");
    await expect(dispensarExigencia(direcao, obraId, "licenca_ambiental", "Outra justificativa longa.")).rejects.toThrow(/já foi dispensada/);
    lista = await documentosDaObra(eng, obraId);
    const la = lista.exigencias.find((e) => e.chave === "licenca_ambiental")!;
    expect(la.atendida).toBe(true);
    expect(la.dispensa!.justificativa).toMatch(/Reforma interna/);

    const p = await painelDocumentos(eng);
    expect(p.obras.some((o) => o.id === obraId)).toBe(true);
    await expect(painelDocumentos(outro)).resolves.toBeTruthy();
    expect((await painelDocumentos(outro)).obras.some((o) => o.id === obraId)).toBe(false);
  });
});

describe("painel gerencial", () => {
  const base: Omit<ObraGerencial, "nivel" | "motivos"> = {
    id: "o1", codigo: "OB-1", nome: "Obra", tipo: "edificacao", forma: "contratada", situacao: "em_execucao", unidade: null, unidadeId: null,
    latitude: null, longitude: null, contratado: 1000, saldo: 500, medido: 500, pago: 400, aPagar: 100, executadoPct: 50, previstoPct: 50, realizadoPct: 50, idp: 1,
    ultimaMedicao: "2026-11-01", vigenciaFim: "2027-06-30", diasVigencia: 200, ncsGraves: 0, ncsVencidas: 0, documentosVencidos: 0, exigenciasFaltando: 0, habilitacoesVencidas: 0,
  };
  const H = "2026-11-25";

  it("semáforo verde, amarelo e vermelho com motivos", () => {
    expect(avaliarObra(base, H)).toEqual({ nivel: "verde", motivos: [] });
    expect(avaliarObra({ ...base, idp: 0.9, realizadoPct: 45 }, H).nivel).toBe("amarelo");
    const atraso = avaliarObra({ ...base, idp: 0.7, realizadoPct: 35, executadoPct: 35 }, H);
    expect(atraso.nivel).toBe("vermelho");
    expect(atraso.motivos[0].texto).toMatch(/IDP 0,70/);
    expect(atraso.motivos[0].href).toBe("/obras/o1/cronograma");
    expect(avaliarObra({ ...base, diasVigencia: -3 }, H).motivos[0].texto).toBe("Vigência do contrato encerrada há 3 dias");
    expect(avaliarObra({ ...base, diasVigencia: 1 }, H).motivos[0].texto).toBe("Vigência do contrato termina em 1 dia");
    expect(avaliarObra({ ...base, ultimaMedicao: "2026-09-01" }, H).motivos[0].texto).toMatch(/Sem medição aprovada há 85 dias/);
    expect(avaliarObra({ ...base, executadoPct: 70 }, H).motivos[0].texto).toMatch(/Medido à frente/);
    const varios = avaliarObra({ ...base, exigenciasFaltando: 1, ncsGraves: 2, documentosVencidos: 1 }, H);
    expect(varios.nivel).toBe("vermelho");
    expect(varios.motivos[0].nivel).toBe("vermelho");
    expect(varios.motivos).toHaveLength(3);
    // Obra concluída não acusa vigência; obra licitada não acusa atraso físico.
    expect(avaliarObra({ ...base, situacao: "concluida", diasVigencia: -10 }, H).nivel).toBe("verde");
    expect(avaliarObra({ ...base, situacao: "licitada", idp: 0.5 }, H).nivel).toBe("verde");
  });

  it("painel consolidado respeita permissão e filtros", async () => {
    const obraId = await criarObra(eng, dadosObra({ tipo: "pavimentacao" }));
    expect((await painelGerencial(direcao)).obras.some((o) => o.id === obraId)).toBe(false); // em estudo fica fora
    await mudarSituacao(eng, obraId, "orcada", "Orçamento pronto");
    await mudarSituacao(eng, obraId, "licitada", "Pregão 1/2026");
    await expect(painelGerencial(campo)).rejects.toThrow(SemPermissao);
    const p = await painelGerencial(direcao);
    expect(p.obras.some((o) => o.id === obraId)).toBe(true);
    expect(p.porNivel.verde + p.porNivel.amarelo + p.porNivel.vermelho).toBe(p.obras.length);
    expect(p.mensal).toHaveLength(12);
    const f = await painelGerencial(direcao, { tipo: "edificacao" });
    expect(f.obras.some((o) => o.id === obraId)).toBe(false);
    expect((await painelGerencial(direcao, { situacao: "licitada" })).obras.every((o) => o.situacao === "licitada")).toBe(true);
    expect((await painelGerencial(outro)).obras.some((o) => o.id === obraId)).toBe(false);
  });
});
