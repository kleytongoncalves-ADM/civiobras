const FUSO = "America/Sao_Paulo";

export const dataCurta = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
};

/** Dia (AAAA-MM-DD) de um instante no horário de Brasília. Depois das 21h, o dia em UTC já é o seguinte. */
export const diaLocal = (d: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(d));

export const dataHora = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);

export const dataExtenso = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "long", day: "numeric", month: "long" }).format(d);

export const horaLocal = (d: Date) =>
  Number(new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "numeric", hour12: false }).format(d));

export function haQuantoTempo(d: Date, agora = new Date()) {
  const min = Math.round((agora.getTime() - d.getTime()) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const dias = Math.round(h / 24);
  return dias === 1 ? "ontem" : `há ${dias} dias`;
}

export const numero = (v: number | null | undefined, casas = 2) =>
  v == null ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Valor em reais a partir do texto decimal do banco ("1234.56"). */
export const moeda = (v: string | number | null | undefined) =>
  v == null || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Número sem o símbolo da moeda, com as casas pedidas. */
export const valor = (v: string | number | null | undefined, casas = 2) =>
  v == null || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Quantidade: até 4 casas, sem zeros sobrando. */
export const quantidade = (v: string | number | null | undefined) =>
  v == null || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const percentual = (v: string | number | null | undefined, casas = 2) =>
  v == null || v === "" ? "—" : `${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "2026-10" vira "out/2026". */
export const mesAno = (v: string | null | undefined) => {
  if (!v) return "—";
  const [a, m] = v.split("-");
  return `${MESES[Number(m) - 1]}/${a}`;
};

/** Texto decimal do banco para o campo de formulário ("1234.5" vira "1234,5"). */
export const paraCampo = (v: string | null | undefined) => (v == null ? "" : String(Number(v)).replace(".", ","));

/** "25 de novembro de 2026" */
export const dataLonga = (d: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "numeric", month: "long", year: "numeric" }).format(d);

/** Valor curto para eixos de gráfico: R$ 2,6 mil, R$ 1,2 mi. */
export function moedaCurta(v: number) {
  const f = (x: number, s: string) => `R$ ${x.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${s}`;
  if (Math.abs(v) >= 1e6) return f(v / 1e6, "mi");
  if (Math.abs(v) >= 1e3) return f(v / 1e3, "mil");
  return `R$ ${Math.round(v).toLocaleString("pt-BR")}`;
}

/** Símbolos das unidades de medida como devem ser escritos (SI). Siglas sem símbolo, como UN e CJ, ficam como estão. */
const SIMBOLO_UNIDADE: Record<string, string> = {
  M: "m", M2: "m²", M3: "m³", CM: "cm", CM2: "cm²", CM3: "cm³", MM: "mm", KM: "km", KM2: "km²",
  KG: "kg", G: "g", T: "t", L: "L", ML: "mL", H: "h", MIN: "min", KW: "kW", KWH: "kWh", MPA: "MPa",
};
/** "M2" vira "m²", "M3XKM" vira "m³×km", "H/M2" vira "h/m²". */
export function unidadeMedida(u: string | null | undefined): string {
  if (!u) return u ?? "";
  const t = u.trim();
  const direto = SIMBOLO_UNIDADE[t.toUpperCase().replace("²", "2").replace("³", "3")];
  if (direto) return direto;
  const partes = t.split(/([X/])/i);
  if (partes.length < 3) return t;
  const convertidas = partes.map((p, i) => (i % 2 ? (p === "/" ? "/" : "×") : SIMBOLO_UNIDADE[p.toUpperCase()]));
  return convertidas.every(Boolean) ? convertidas.join("") : t;
}

/** Encurta um texto longo e marca o corte com reticências. */
export const resumir = (t: string | null | undefined, n: number) => { const v = t ?? ""; return v.length > n ? `${v.slice(0, n).trimEnd()}…` : v; };

const SIGLAS: Record<string, string> = {
  mpa: "MPa", kpa: "kPa", kn: "kN", kv: "kV", kva: "kVA", kw: "kW", pvc: "PVC", pead: "PEAD", cpvc: "CPVC", ppr: "PPR", dn: "DN",
  ca: "CA", cp: "CP", fck: "fck", led: "LED", spda: "SPDA", gln: "GLN", ac: "AC", pp: "PP", eps: "EPS", osb: "OSB", mdf: "MDF",
  m2: "m²", m3: "m³", cbuq: "CBUQ", pmf: "PMF", tsd: "TSD", tss: "TSS", rr: "RR", cm30: "CM-30", ii: "II", iii: "III", iv: "IV",
  rj: "RJ", abnt: "ABNT", nbr: "NBR", sinapi: "SINAPI", sicro: "SICRO", dnit: "DNIT", epi: "EPI", epc: "EPC", art: "ART",
};

/**
 * Descrição oficial (em maiúsculas nas bases) em letra normal, para leitura: sem o sufixo de
 * aferição (AF_mm/aaaa) e com siglas e unidades conhecidas preservadas. A descrição original
 * continua nas fichas e nas planilhas.
 */
export function nomeLegivel(descricao: string | null | undefined): string {
  const d = (descricao ?? "").replace(/\s*\.?\s*AF_\d{2}\/\d{4}(_[A-Z]+)?\s*\.?\s*$/i, "").trim().replace(/[.;]\s*$/, "");
  if (!d) return "";
  // Só converte o que está todo em maiúsculas (SINAPI, SICRO); o SCO-Rio já vem em letra normal.
  if (d !== d.toUpperCase()) return d.charAt(0).toUpperCase() + d.slice(1);
  const minus = d.toLowerCase().replace(/[a-zà-ú0-9]+/gi, (p) => SIGLAS[p] ?? p).replace(/\*(\d+)\*/g, "$1").replace(/(\d)x(?=\d)/g, "$1×");
  return minus.charAt(0).toUpperCase() + minus.slice(1);
}
