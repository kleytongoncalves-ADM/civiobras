/**
 * Aritmética decimal exata para dinheiro, quantidades e coeficientes.
 * Os valores são inteiros (bigint) com 12 casas decimais fixas: nada de ponto flutuante.
 */
export type Dec = bigint;
export type Regra = "arredondar" | "truncar";

const CASAS = 12;
const ESCALA = 10n ** BigInt(CASAS);

export const ZERO: Dec = 0n;
export const UM: Dec = ESCALA;

/** Converte texto ("1234.5678", "-0.5") ou número em decimal exato. */
export function dec(v: string | number | bigint | null | undefined): Dec {
  if (v == null || v === "") return 0n;
  if (typeof v === "bigint") return v * ESCALA;
  const t = typeof v === "number" ? numeroParaTexto(v) : v.trim();
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m) throw new Error(`Número inválido: ${v}`);
  const inteiro = BigInt(m[2] || "0");
  const frac = (m[3] ?? "").slice(0, CASAS).padEnd(CASAS, "0");
  const r = inteiro * ESCALA + BigInt(frac || "0");
  return m[1] === "-" ? -r : r;
}

function numeroParaTexto(n: number) {
  if (!Number.isFinite(n)) throw new Error("Número inválido.");
  return n.toFixed(CASAS).replace(/0+$/, "").replace(/\.$/, "");
}

/** Lê número digitado no padrão brasileiro ("1.234,56") ou com ponto ("1234.56"). */
export function lerNumeroBr(t: string): Dec | null {
  const s = t.trim().replace(/\s/g, "");
  if (s === "") return null;
  const normal = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^[+-]?\d*(\.\d*)?$/.test(normal) || normal === "." || normal === "") return null;
  return dec(normal);
}

/**
 * Lê valor em reais. Igual a lerNumeroBr, mas "1.500" e "12.345.678" (pontos de milhar, sem vírgula)
 * valem 1500 e 12345678. Só para campos de dinheiro; quantidades continuam com lerNumeroBr.
 */
export function lerValorBr(t: string): Dec | null {
  const s = t.trim().replace(/\s/g, "");
  if (/^[+-]?\d{1,3}(\.\d{3})+$/.test(s)) return dec(s.replace(/\./g, ""));
  return lerNumeroBr(s);
}

export const soma = (...v: Dec[]) => v.reduce((a, b) => a + b, 0n);
export const mul = (a: Dec, b: Dec): Dec => (a * b) / ESCALA;
export const div = (a: Dec, b: Dec): Dec => {
  if (b === 0n) throw new Error("Divisão por zero.");
  return (a * ESCALA) / b;
};

/** Arredonda (meio para cima, afastando do zero) ou trunca na quantidade de casas pedida. */
export function ajustar(a: Dec, casas: number, regra: Regra): Dec {
  const fator = 10n ** BigInt(CASAS - casas);
  const negativo = a < 0n;
  const abs = negativo ? -a : a;
  let q = abs / fator;
  if (regra === "arredondar" && (abs % fator) * 2n >= fator) q += 1n;
  const r = q * fator;
  return negativo ? -r : r;
}

export const arred = (a: Dec, casas = 2) => ajustar(a, casas, "arredondar");

/** Texto com ponto decimal, para gravar no banco. */
export function texto(a: Dec, casas = 2): string {
  const v = ajustar(a, casas, "arredondar");
  const negativo = v < 0n;
  const abs = negativo ? -v : v;
  const inteiro = abs / ESCALA;
  const frac = (abs % ESCALA).toString().padStart(CASAS, "0").slice(0, casas);
  return `${negativo ? "-" : ""}${inteiro}${casas > 0 ? "." + frac : ""}`;
}

export const paraNumero = (a: Dec) => Number(texto(a, 10));

export const maior = (a: Dec, b: Dec) => (a > b ? a : b);
export const menor = (a: Dec, b: Dec) => (a < b ? a : b);
