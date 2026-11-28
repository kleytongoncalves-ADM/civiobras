/**
 * Serviços pré-selecionados por assunto, a partir das medidas.
 *
 * Cada pacote diz quais serviços normalmente andam juntos (ex.: alvenaria leva verga, contraverga,
 * chapisco e reboco) e como a quantidade de cada um sai das medidas informadas. A composição vem
 * sempre da base: primeiro pelo código de referência, depois pela busca na base escolhida. Quando a
 * base não tem o serviço, a linha fica sem composição e o usuário escolhe outra ou desmarca.
 */
import { ErroDeRegra } from "../lib/db";
import { lerNumeroBr, texto } from "../lib/decimal";
import { buscarServicos, type ServicoComCusto } from "./assistente";
import type { Ator } from "./obras";
import type { Fonte } from "./precos";
import type { Regra } from "../lib/decimal";

export type ParametroPacote = { chave: string; rotulo: string; unidade: string; padrao: string; dica?: string; inteiro?: boolean; minimo?: number };
type Medidas = Record<string, number>;
type LinhaPacote = {
  chave: string; nome: string; unidade: string;
  /** Código de referência por fonte (o mais usado para o caso comum). */
  codigos: Partial<Record<Fonte, string[]>>;
  /** Termos para achar o serviço em outra base ou para oferecer alternativas. */
  busca: string[];
  quantidade: (m: Medidas) => [number, string];
  marcado?: boolean;
};
export type Pacote = { assuntoId: string; titulo: string; resumo: string; parametros: ParametroPacote[]; linhas: LinhaPacote[] };

const n = (v: number, casas = 2) => v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: casas });
const pos = (v: number) => Math.max(0, v);

export const PACOTES: Pacote[] = [
  {
    assuntoId: "servicos-preliminares", titulo: "Canteiro pelo tamanho do terreno",
    resumo: "Limpeza do terreno, locação da obra e tapume no perímetro.",
    parametros: [
      { chave: "areaTerreno", rotulo: "Área do terreno", unidade: "m²", padrao: "300" },
      { chave: "perimetroTerreno", rotulo: "Perímetro do terreno (frente com tapume)", unidade: "m", padrao: "30" },
      { chave: "perimetroObra", rotulo: "Perímetro da edificação", unidade: "m", padrao: "40" },
      { chave: "alturaTapume", rotulo: "Altura do tapume", unidade: "m", padrao: "2,20" },
    ],
    linhas: [
      { chave: "limpeza", nome: "Limpeza do terreno", unidade: "M2", codigos: { sinapi: ["98524"] }, busca: ["limpeza manual terreno", "limpeza terreno"],
        quantidade: (m) => [m.areaTerreno, `${n(m.areaTerreno)} m² de terreno`] },
      { chave: "locacao", nome: "Locação da obra com gabarito", unidade: "M", codigos: { sinapi: ["105009"] }, busca: ["locação obra gabarito", "locação"],
        quantidade: (m) => [m.perimetroObra, `${n(m.perimetroObra)} m de perímetro da edificação`] },
      { chave: "tapume", nome: "Tapume", unidade: "M2", codigos: { sinapi: ["98459"] }, busca: ["tapume"],
        quantidade: (m) => [m.perimetroTerreno * m.alturaTapume, `${n(m.perimetroTerreno)} m × ${n(m.alturaTapume)} m de altura`] },
    ],
  },
  {
    assuntoId: "alvenaria", titulo: "Alvenaria pelo tamanho das paredes",
    resumo: "Alvenaria descontando os vãos, vergas sobre portas e janelas e contravergas sob as janelas.",
    parametros: [
      { chave: "comprimento", rotulo: "Comprimento total das paredes", unidade: "m", padrao: "40" },
      { chave: "altura", rotulo: "Pé-direito", unidade: "m", padrao: "2,80" },
      { chave: "areaVaos", rotulo: "Área de portas e janelas", unidade: "m²", padrao: "12" },
      { chave: "vaos", rotulo: "Quantidade de portas e janelas", unidade: "un", padrao: "8", inteiro: true, minimo: 0 },
      { chave: "janelas", rotulo: "Quantidade de janelas", unidade: "un", padrao: "4", inteiro: true, minimo: 0 },
      { chave: "larguraVao", rotulo: "Largura média dos vãos", unidade: "m", padrao: "1,00" },
    ],
    linhas: [
      { chave: "alvenaria", nome: "Alvenaria de vedação", unidade: "M2", codigos: { sinapi: ["103328"] }, busca: ["alvenaria vedação blocos cerâmicos furados", "alvenaria vedação"],
        quantidade: (m) => [pos(m.comprimento * m.altura - m.areaVaos), `${n(m.comprimento)} m × ${n(m.altura)} m − ${n(m.areaVaos)} m² de vãos`] },
      { chave: "verga", nome: "Verga sobre portas e janelas", unidade: "M", codigos: { sinapi: ["105024"] }, busca: ["verga moldada in loco", "verga"],
        quantidade: (m) => [m.vaos * (m.larguraVao + 0.6), `${n(m.vaos, 0)} vãos × (${n(m.larguraVao)} m + 0,30 m de apoio em cada lado)`] },
      { chave: "contraverga", nome: "Contraverga sob as janelas", unidade: "M", codigos: { sinapi: ["105028"] }, busca: ["contraverga"],
        quantidade: (m) => [m.janelas * (m.larguraVao + 0.6), `${n(m.janelas, 0)} janelas × (${n(m.larguraVao)} m + 0,30 m de apoio em cada lado)`] },
    ],
  },
  {
    assuntoId: "revestimentos", titulo: "Revestimento pela área de parede",
    resumo: "Chapisco em toda a área, reboco onde fica pintura e emboço com cerâmica nas áreas molhadas.",
    parametros: [
      { chave: "area", rotulo: "Área de parede (uma face)", unidade: "m²", padrao: "100" },
      { chave: "faces", rotulo: "Faces revestidas", unidade: "", padrao: "2", inteiro: true, minimo: 1 },
      { chave: "ceramica", rotulo: "Área com cerâmica (cozinha, banheiros)", unidade: "m²", padrao: "20", minimo: 0 },
    ],
    linhas: [
      { chave: "chapisco", nome: "Chapisco", unidade: "M2", codigos: { sinapi: ["87878"] }, busca: ["chapisco aplicado alvenaria", "chapisco"],
        quantidade: (m) => [m.area * m.faces, `${n(m.area)} m² × ${n(m.faces, 0)} faces`] },
      { chave: "massa", nome: "Reboco (massa única)", unidade: "M2", codigos: { sinapi: ["104959"] }, busca: ["massa única paredes internas", "reboco", "massa única"],
        quantidade: (m) => [pos(m.area * m.faces - m.ceramica), `${n(m.area)} m² × ${n(m.faces, 0)} faces − ${n(m.ceramica)} m² com cerâmica`] },
      { chave: "emboco", nome: "Emboço para cerâmica", unidade: "M2", codigos: { sinapi: ["87554"] }, busca: ["emboço paredes internas", "emboço"],
        quantidade: (m) => [m.ceramica, `${n(m.ceramica)} m² com cerâmica`] },
      { chave: "ceramica", nome: "Revestimento cerâmico de parede", unidade: "M2", codigos: { sinapi: ["87267"] }, busca: ["revestimento cerâmico paredes internas", "azulejo"],
        quantidade: (m) => [m.ceramica, `${n(m.ceramica)} m² com cerâmica`] },
    ],
  },
  {
    assuntoId: "pisos", titulo: "Piso pela área dos ambientes",
    resumo: "Contrapiso, piso cerâmico e rodapé no perímetro, descontadas as portas.",
    parametros: [
      { chave: "area", rotulo: "Área de piso", unidade: "m²", padrao: "80" },
      { chave: "perimetro", rotulo: "Perímetro dos ambientes", unidade: "m", padrao: "60" },
      { chave: "portas", rotulo: "Largura somada das portas", unidade: "m", padrao: "4,80", minimo: 0 },
    ],
    linhas: [
      { chave: "contrapiso", nome: "Contrapiso", unidade: "M2", codigos: { sinapi: ["87624"] }, busca: ["contrapiso argamassa", "contrapiso", "regularização de piso"],
        quantidade: (m) => [m.area, `${n(m.area)} m² de piso`] },
      { chave: "piso", nome: "Piso cerâmico", unidade: "M2", codigos: { sinapi: ["87255"] }, busca: ["revestimento cerâmico piso", "piso cerâmico"],
        quantidade: (m) => [m.area, `${n(m.area)} m² de piso`] },
      { chave: "rodape", nome: "Rodapé cerâmico", unidade: "M", codigos: { sinapi: ["88648"] }, busca: ["rodapé cerâmico", "rodapé"],
        quantidade: (m) => [pos(m.perimetro - m.portas), `${n(m.perimetro)} m − ${n(m.portas)} m de portas`] },
    ],
  },
  {
    assuntoId: "pintura", titulo: "Pintura pela área de paredes e teto",
    resumo: "Selador, massa e tinta acrílica nas paredes e no teto.",
    parametros: [
      { chave: "paredes", rotulo: "Área de paredes a pintar", unidade: "m²", padrao: "180", minimo: 0 },
      { chave: "teto", rotulo: "Área de teto", unidade: "m²", padrao: "80", minimo: 0 },
    ],
    linhas: [
      { chave: "seladorParede", nome: "Fundo selador nas paredes", unidade: "M2", codigos: { sinapi: ["88485"] }, busca: ["fundo selador parede", "selador"],
        quantidade: (m) => [m.paredes, `${n(m.paredes)} m² de paredes`] },
      { chave: "massaParede", nome: "Massa látex nas paredes", unidade: "M2", codigos: { sinapi: ["88495"] }, busca: ["emassamento massa látex parede", "massa corrida"],
        quantidade: (m) => [m.paredes, `${n(m.paredes)} m² de paredes`] },
      { chave: "tintaParede", nome: "Tinta acrílica nas paredes", unidade: "M2", codigos: { sinapi: ["104642"] }, busca: ["pintura látex acrílica paredes", "pintura acrílica"],
        quantidade: (m) => [m.paredes, `${n(m.paredes)} m² de paredes`] },
      { chave: "seladorTeto", nome: "Fundo selador no teto", unidade: "M2", codigos: { sinapi: ["88484"] }, busca: ["fundo selador teto"],
        quantidade: (m) => [m.teto, `${n(m.teto)} m² de teto`] },
      { chave: "massaTeto", nome: "Massa látex no teto", unidade: "M2", codigos: { sinapi: ["88494"] }, busca: ["emassamento massa látex teto"],
        quantidade: (m) => [m.teto, `${n(m.teto)} m² de teto`] },
      { chave: "tintaTeto", nome: "Tinta acrílica no teto", unidade: "M2", codigos: { sinapi: ["104640"] }, busca: ["pintura látex acrílica teto"],
        quantidade: (m) => [m.teto, `${n(m.teto)} m² de teto`] },
    ],
  },
  {
    assuntoId: "cobertura", titulo: "Telhado pela área coberta",
    resumo: "Estrutura de madeira, telha cerâmica e cumeeira. A área inclinada sai da área em planta e da inclinação.",
    parametros: [
      { chave: "projecao", rotulo: "Área coberta em planta (com beirais)", unidade: "m²", padrao: "100" },
      { chave: "inclinacao", rotulo: "Inclinação do telhado", unidade: "%", padrao: "35", minimo: 0 },
      { chave: "cumeeira", rotulo: "Comprimento da cumeeira", unidade: "m", padrao: "10", minimo: 0 },
    ],
    linhas: [
      { chave: "trama", nome: "Estrutura de madeira (ripas, caibros e terças)", unidade: "M2", codigos: { sinapi: ["92539"] }, busca: ["trama madeira telha cerâmica", "estrutura madeira telhado"],
        quantidade: (m) => { const f = Math.sqrt(1 + (m.inclinacao / 100) ** 2); return [m.projecao * f, `${n(m.projecao)} m² × ${n(f, 3)} (fator da inclinação de ${n(m.inclinacao, 0)}%)`]; } },
      { chave: "telha", nome: "Telha cerâmica", unidade: "M2", codigos: { sinapi: ["94442"] }, busca: ["telhamento telha cerâmica", "telha cerâmica"],
        quantidade: (m) => { const f = Math.sqrt(1 + (m.inclinacao / 100) ** 2); return [m.projecao * f, `${n(m.projecao)} m² × ${n(f, 3)} (fator da inclinação de ${n(m.inclinacao, 0)}%)`]; } },
      { chave: "cumeeira", nome: "Cumeeira", unidade: "M", codigos: { sinapi: ["94221"] }, busca: ["cumeeira telha cerâmica", "cumeeira"],
        quantidade: (m) => [m.cumeeira, `${n(m.cumeeira)} m de cumeeira`] },
    ],
  },
  {
    assuntoId: "impermeabilizacao", titulo: "Impermeabilização pela área",
    resumo: "Manta asfáltica na área e subindo nas paredes (rodapé da manta).",
    parametros: [
      { chave: "area", rotulo: "Área a impermeabilizar", unidade: "m²", padrao: "30" },
      { chave: "perimetro", rotulo: "Perímetro", unidade: "m", padrao: "22", minimo: 0 },
      { chave: "subida", rotulo: "Altura da subida nas paredes", unidade: "m", padrao: "0,30", minimo: 0 },
    ],
    linhas: [
      { chave: "manta", nome: "Manta asfáltica", unidade: "M2", codigos: { sinapi: ["98546"] }, busca: ["impermeabilização manta asfáltica", "manta asfáltica"],
        quantidade: (m) => [m.area + m.perimetro * m.subida, `${n(m.area)} m² + ${n(m.perimetro)} m × ${n(m.subida)} m de subida`] },
    ],
  },
];

export const pacoteDoAssunto = (assuntoId: string | null | undefined) => PACOTES.find((p) => p.assuntoId === assuntoId) ?? null;

/** Lê as medidas do formulário (aceita vírgula); usa o padrão quando o campo vem vazio. */
export function lerMedidas(p: Pacote, valores: Record<string, string | undefined>): Medidas {
  const m: Medidas = {};
  for (const x of p.parametros) {
    const bruto = (valores[x.chave] ?? "").trim() || x.padrao;
    const v = lerNumeroBr(bruto);
    const num = v == null ? NaN : Number(texto(v, 6));
    const minimo = x.minimo ?? 0.0001;
    if (!Number.isFinite(num) || num < minimo) throw new ErroDeRegra(`Informe ${x.rotulo.toLowerCase()}.`);
    if (x.inteiro && !Number.isInteger(num)) throw new ErroDeRegra(`${x.rotulo}: use um número inteiro.`);
    m[x.chave] = num;
  }
  return m;
}

export type LinhaSugerida = {
  chave: string; nome: string; unidade: string; quantidade: string; memoria: string; marcado: boolean;
  escolhida: ServicoComCusto | null; alternativas: ServicoComCusto[]; pelaReferencia: boolean;
};

/**
 * Monta a lista pré-selecionada: quantidade de cada serviço e a composição sugerida nas bases do
 * orçamento (a principal primeiro). Nada é inventado: sem composição na base, a linha fica sem ela.
 */
export async function sugerirPacote(
  a: Ator, p: Pacote, medidas: Medidas, bases: { tabelaId: string; fonte: Fonte; principal: boolean }[], regra: Regra,
): Promise<LinhaSugerida[]> {
  const ordemFonte = (f: Fonte) => (bases.find((b) => b.principal)?.fonte === f ? 0 : 1);
  const tabelaIds = bases.map((b) => b.tabelaId);
  const saida: LinhaSugerida[] = [];
  for (const l of p.linhas) {
    const [q, memoria] = l.quantidade(medidas);
    const quantidade = (Math.round(q * 100) / 100).toFixed(2);
    const codigos = [...new Set(Object.entries(l.codigos).filter(([f]) => bases.some((b) => b.fonte === f)).flatMap(([, c]) => c ?? []))];
    const porCodigo = codigos.length ? await buscarServicos(a, { tabelaIds, codigos, regra, limite: 10 }) : [];
    const referencia = porCodigo.filter((k) => (l.codigos[k.fonte] ?? []).includes(k.codigo)).sort((x, y) => ordemFonte(x.fonte) - ordemFonte(y.fonte));
    let alternativas: ServicoComCusto[] = [];
    for (const termo of l.busca) {
      // Alternativas só do mesmo assunto, para não oferecer demolição ou remoção no lugar do serviço.
      alternativas = await buscarServicos(a, { tabelaIds, busca: termo, unidade: l.unidade, assuntoId: p.assuntoId, regra, limite: 8 });
      if (alternativas.length) break;
    }
    const todas = [...referencia, ...alternativas.filter((x) => !referencia.some((r) => r.id === x.id && r.tabelaId === x.tabelaId))]
      .sort((x, y) => ordemFonte(x.fonte) - ordemFonte(y.fonte));
    const escolhida = referencia[0] ?? todas.find((k) => k.custo != null) ?? todas[0] ?? null;
    saida.push({
      chave: l.chave, nome: l.nome, unidade: l.unidade, quantidade, memoria, marcado: (l.marcado ?? true) && q > 0 && !!escolhida,
      escolhida, alternativas: todas.slice(0, 8), pelaReferencia: !!referencia[0],
    });
  }
  return saida;
}
