/**
 * Fotos reais de obra usadas para identificar assuntos e serviços no orçamento.
 * As fotos ficam em public/fotos/obra/<chave>.jpg; os créditos (autor, licença e origem)
 * ficam em CREDITOS, e a página de créditos lista todos.
 *
 * Uma foto só aparece se a chave estiver em CREDITOS (quer dizer que o arquivo existe e a licença foi conferida).
 */
import creditos from "./fotos-obra-creditos.json";

export type CreditoFoto = { autor: string; licenca: string; origem: string; titulo: string };
export const CREDITOS = creditos as Record<string, CreditoFoto>;

/** Regras por palavra da descrição (já em minúsculas, sem acento), da mais específica para a mais geral. */
const REGRAS: [RegExp, string][] = [
  [/drywall|gesso acartonado|placa de gesso/, "drywall"],
  [/bloco[s]? de concreto|bloco estrutural de concreto|canaleta de concreto/, "bloco-concreto"],
  [/bloco[s]? ceramico|tijolo[s]? ceramico|tijolo furado|bloco[s]? de ceramica/, "tijolo-ceramico"],
  [/tijolo macico|tijolo comum/, "tijolo-macico"],
  [/pedra argamassada|alvenaria de pedra|muro de pedra|enrocamento|gabiao/, "pedra"],
  [/verga|contraverga/, "verga"],
  [/chapisco|emboco|reboco|massa unica|argamassa de revestimento/, "reboco"],
  [/azulejo|revestimento ceramico|ceramica.*parede|porcelanato.*parede/, "azulejo"],
  [/forro/, "forro"],
  [/contrapiso|regularizacao de piso|lastro/, "contrapiso"],
  [/rodape/, "rodape"],
  [/porcelanato|piso ceramico|revestimento ceramico.*piso|ceramica.*piso|piso/, "piso-ceramico"],
  [/telha ceramica|telhado ceramico|cumeeira/, "telha-ceramica"],
  [/fibrocimento|telha ondulada/, "telha-fibrocimento"],
  [/telha metalica|telha de aco|termoacustica/, "telha-metalica"],
  [/trama|madeiramento|tesoura|ripa|caibro/, "madeiramento"],
  [/calha|rufo|condutor/, "calha"],
  [/impermeabiliza|manta asfaltica|emulsao/, "impermeabilizacao"],
  [/armacao|aco ca-?50|aco ca-?60|vergalhao|tela soldada/, "armacao"],
  [/forma|escoramento|desforma/, "forma"],
  [/concretagem|concreto usinado|concreto fck|lancamento de concreto|concreto/, "concreto"],
  [/estaca|broca|sapata|bloco de coroamento|baldrame|radier/, "fundacao"],
  [/escavacao|corte de terreno|vala/, "escavacao"],
  [/aterro|reaterro|compactacao/, "aterro"],
  [/demolicao|remocao|retirada/, "demolicao"],
  [/tapume/, "tapume"],
  [/locacao|gabarito/, "locacao"],
  [/limpeza/, "limpeza"],
  [/tubo.*pvc|pvc.*tubo|tubulacao|registro|conexao|joelho|caixa sifonada|esgoto|agua fria/, "tubo-pvc"],
  [/vaso sanitario|lavatorio|bacia|cuba|torneira|chuveiro|louca/, "loucas"],
  [/eletroduto|cabo|fio|condutor eletrico|tomada|interruptor|disjuntor|quadro de distribuicao/, "eletrica"],
  [/luminaria|lampada|refletor|poste|iluminacao/, "iluminacao"],
  [/porta/, "porta"],
  [/janela|esquadria|basculante|vidro/, "janela"],
  [/textura|grafiato/, "textura"],
  [/pintura|tinta|latex|acrilica|esmalte|selador|massa corrida/, "pintura"],
  [/meio-?fio|sarjeta/, "meio-fio"],
  [/bloquete|paver|intertravado|paralelepipedo/, "bloquete"],
  [/asfalt|cbuq|imprimacao|pintura de ligacao|tsd|fresagem|sub-?base|base de brita/, "asfalto"],
  [/calcada|passeio/, "calcada"],
  [/grama|plantio|muda|paisagismo/, "paisagismo"],
  [/sinalizacao|faixa|placa de transito|tachao/, "sinalizacao"],
  [/galeria|bueiro|boca de lobo|drenagem|poco de visita|tubo de concreto/, "drenagem"],
  [/extintor|hidrante|sprinkler|incendio|gas/, "incendio"],
  [/ar condicionado|split|climatiza|exaustor|ventila/, "climatizacao"],
  [/transporte|carga|descarga|caminhao|basculante/, "transporte"],
  [/escavadeira|retroescavadeira|betoneira|compactador|rolo|guindaste|andaime|locacao de equipamento/, "equipamento"],
];

/** Foto de referência de cada assunto, quando o serviço não tem uma mais específica. */
export const FOTO_DO_ASSUNTO: Record<string, string> = {
  "servicos-preliminares": "tapume", demolicoes: "demolicao", "movimento-terra": "escavacao", fundacoes: "fundacao",
  estrutura: "concreto", alvenaria: "tijolo-ceramico", cobertura: "telha-ceramica", impermeabilizacao: "impermeabilizacao",
  revestimentos: "reboco", pisos: "piso-ceramico", esquadrias: "janela", pintura: "pintura", hidrossanitarias: "tubo-pvc",
  eletricas: "eletrica", "incendio-gas": "incendio", climatizacao: "climatizacao", drenagem: "drenagem", pavimentacao: "asfalto",
  urbanizacao: "calcada", sinalizacao: "sinalizacao", "iluminacao-publica": "iluminacao", "obras-especiais": "ponte",
  transporte: "transporte", equipamentos: "equipamento", complementares: "limpeza", administracao: "administracao",
};

const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const url = (chave: string | undefined) => (chave && CREDITOS[chave] ? `/fotos/obra/${chave}.jpg` : null);

/** Foto que identifica um serviço pela descrição; se não houver, a do assunto. Null quando não há foto. */
export function fotoDoServico(descricao: string | null | undefined, assuntoId?: string | null): string | null {
  const d = semAcento(descricao ?? "");
  for (const [re, chave] of REGRAS) if (re.test(d) && CREDITOS[chave]) return url(chave);
  return fotoDoAssunto(assuntoId);
}

export function fotoDoAssunto(assuntoId: string | null | undefined): string | null {
  return assuntoId ? url(FOTO_DO_ASSUNTO[assuntoId]) : null;
}

/** Fotos das telas do assistente (modos de montar, faixa do topo e resumo vazio). */
export const fotoTela = (chave: "modo-assunto" | "modo-livre" | "faixa-obra" | "resumo-vazio") => url(chave);
