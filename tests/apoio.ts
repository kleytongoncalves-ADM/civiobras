import { randomUUID } from "node:crypto";
import { comContexto, pool } from "../src/lib/db";
import { gerarHashSenha } from "../src/servicos/auth";
import type { Ator, DadosObra } from "../src/servicos/obras";
import type { Perfil } from "../src/servicos/rotulos";

export const SENHA = "Teste@123";
// Hash calculado uma vez: a derivação de senha é lenta de propósito.
const HASH = gerarHashSenha(SENHA);

export async function novoOrgao(nome = "Órgão de teste"): Promise<string> {
  const r = await pool().query(
    "insert into orgao (nome, cnpj, esfera, uf, municipio, demonstracao) values ($1, $2, 'municipal', 'RJ', 'Vila Exemplo', true) returning id",
    [nome, randomUUID()],
  );
  return r.rows[0].id;
}

export async function novoUsuario(orgaoId: string, perfil: Perfil, extra: { administrador?: boolean; ativo?: boolean } = {}): Promise<Ator & { email: string }> {
  const email = `${perfil}.${randomUUID().slice(0, 8)}@teste.exemplo`;
  const id = await comContexto({ usuarioId: null, orgaoId }, async (c) => {
    const r = await c.query(
      "insert into usuario (orgao_id, nome, email, perfil, administrador, ativo, senha_hash) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [orgaoId, `Pessoa ${perfil}`, email, perfil, !!extra.administrador, extra.ativo ?? true, HASH],
    );
    return r.rows[0].id as string;
  });
  return { id, orgaoId, perfil, administrador: !!extra.administrador, email };
}

let n = 0;
export function dadosObra(extra: Partial<DadosObra> = {}): DadosObra {
  n += 1;
  return { codigo: `OB-${Date.now()}-${n}`, nome: `Obra de teste ${n}`, tipo: "edificacao", formaExecucao: "contratada", ...extra };
}
