/**
 * Carrega os dados de exemplo: um órgão fictício, um usuário por perfil e quatro obras
 * em situações diferentes. Tudo aqui é inventado. Não rode em produção.
 *
 * A senha de demonstração vem de SENHA_DEMO no .env. Sem ela, o script usa a senha
 * padrão abaixo, que serve só para o ambiente local.
 */
import { comContexto, fecharPool, pool } from "../src/lib/db";
import { gerarHashSenha } from "../src/servicos/auth";
import { criarObra, editarObra, mudarSituacao, vincular, type Ator, type DadosObra } from "../src/servicos/obras";
import type { Perfil } from "../src/servicos/rotulos";
import { cargaDemonstracao } from "../src/dados/base-demonstracao";
import { lancarMuro, PADRAO_MURO, sugerirMuro } from "../src/servicos/assistente-muro";
import { gravarCargaSinapi } from "../src/servicos/importador-sinapi";
import { baixarArt, dispensarExigencia, enviarDocumento, novaVersao, superarDocumento } from "../src/servicos/documentos";
import {
  adicionarComposicao, adicionarEtapa, aprovarOrcamento, criarOrcamento, obterOrcamento, salvarCronograma, salvarDadosGerais,
} from "../src/servicos/orcamentos";
import { buscarComposicoes } from "../src/servicos/precos";
import { assinarAditivo, criarAditivo, FUNDAMENTOS, incluirItem, registrarRevisao, salvarAditivo } from "../src/servicos/aditivos";
import { adicionarGarantia, assinarContrato, criarContrato, obterContrato, salvarEmpresa } from "../src/servicos/contratos";
import { adicionarConvite, criarSolicitacao, declinar, encerrarAntes, enviarProposta, enviarSolicitacao, homologar, materiaisDoOrcamento, obterSolicitacao, paginaDoFornecedor } from "../src/servicos/cotacoes";
import {
  adicionarGlosa, adicionarRetencao, aprovarMedicao, atestarMedicao, criarMedicao, registrarNotaFiscal, registrarPagamento, salvarBoletim,
} from "../src/servicos/medicoes";
import { criarCronograma, editarAtividade, gravarLinhaBase, obterCronograma, registrarAvanco } from "../src/servicos/cronogramas";
import { abrirDiario, adicionarLinha, assinarDiario, complementarDiario, salvarDiario, vistarDiario, type Clima, type Condicao } from "../src/servicos/campo";
import { abrirNc, corrigirNc, MODELOS, registrarEnsaio, registrarInspecao } from "../src/servicos/qualidade";
import { encerrarOcorrencia, registrarEpi, registrarOcorrencia } from "../src/servicos/seguranca";
import {
  adicionarItemRequisicao, criarRequisicao, decidirRequisicao, definirMinimo, emitirPedido, enviarRequisicao, importarDoOrcamento, obterPedido,
  obterRequisicao, painelSuprimentos, registrarCotacao, registrarMovimento, registrarRecebimento,
} from "../src/servicos/suprimentos";
import {
  alocarEquipamento, alocarPessoa, apontarEquipamento, apontarHoras, registrarDocumentoEmpresa, registrarHabilitacao, registrarManutencao,
  salvarEquipamento, salvarPessoa,
} from "../src/servicos/equipes";

try { process.loadEnvFile(".env"); } catch {}
const SENHA_DEMO = process.env.SENHA_DEMO ?? "Demonstracao2026";
const CNPJ = "00.000.000/0001-00";

async function principal() {
  if (process.env.NODE_ENV === "production") throw new Error("Dados de exemplo não entram em produção.");
  const ja = await pool().query("select 1 from orgao where cnpj = $1", [CNPJ]);
  if (ja.rowCount) return console.log("Os dados de exemplo já estão carregados.");

  const orgaoId = (await pool().query(
    "insert into orgao (nome, cnpj, esfera, uf, municipio, demonstracao) values ('Prefeitura de Vila Exemplo', $1, 'municipal', 'RJ', 'Vila Exemplo', true) returning id",
    [CNPJ],
  )).rows[0].id as string;

  const hash = gerarHashSenha(SENHA_DEMO);
  const pessoas: [string, string, Perfil, boolean, string | null][] = [
    ["Helena Duarte", "direcao", "direcao", false, null],
    ["Marcos Teixeira", "gestor", "gestor_contrato", false, null],
    ["Carla Nogueira", "engenheira", "engenheiro", false, "CREA-RJ 000000-0"],
    ["Rafael Pinto", "fiscal", "fiscal", false, "CREA-RJ 000001-0"],
    ["Juliana Reis", "administrativo", "administrativo", true, null],
    ["Paulo Mendes", "financeiro", "financeiro", false, null],
    ["Sebastião Lima", "campo", "campo", false, null],
    ["Construtora Exemplo Ltda.", "contratada", "contratada", false, null],
  ];
  const ator: Record<string, Ator> = {};
  await comContexto({ usuarioId: null, orgaoId }, async (c) => {
    const unidade = (await c.query("insert into unidade (orgao_id, nome, sigla) values ($1, 'Secretaria Municipal de Obras', 'SMO') returning id", [orgaoId])).rows[0].id;
    for (const [nome, login, perfil, administrador, registro] of pessoas) {
      const r = await c.query(
        `insert into usuario (orgao_id, unidade_id, nome, email, perfil, administrador, registro_profissional, senha_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [orgaoId, unidade, nome, `${login}@vilaexemplo.exemplo`, perfil, administrador, registro, hash],
      );
      ator[login] = { id: r.rows[0].id, orgaoId, perfil, administrador };
    }
  });
  const { direcao, engenheira, gestor } = ator;

  const base = { municipio: "Vila Exemplo", uf: "RJ" };
  const equipe = async (id: string, comContratada: boolean) => {
    await vincular(direcao, id, ator.fiscal.id, "fiscal");
    await vincular(direcao, id, gestor.id, "gestor_contrato");
    await vincular(direcao, id, ator.campo.id, "campo");
    await vincular(direcao, id, ator.financeiro.id, "financeiro");
    if (comContratada) await vincular(direcao, id, ator.contratada.id, "contratada");
  };

  // Obra A: ciclo completo, por contratada.
  const a: DadosObra = {
    ...base, codigo: "OB-2026-001", nome: "Muro de fechamento da Escola Municipal Modelo", tipo: "edificacao",
    formaExecucao: "contratada", endereco: "Rua das Acácias, 120, Centro", extensaoM: 10, latitude: -22.52, longitude: -43.18,
    fonteRecurso: "Recursos próprios", processoAdministrativo: "PA 0101/2026", licitacao: "Dispensa 04/2026",
    dataInicioPrevista: "2026-03-02", dataFimPrevista: "2026-03-31",
  };
  const idA = await criarObra(engenheira, a);
  await equipe(idA, true);
  await mudarSituacao(engenheira, idA, "orcada", "Orçamento 001/2026, aprovado em 10/02/2026");
  await mudarSituacao(gestor, idA, "licitada", "Dispensa 04/2026");
  await mudarSituacao(gestor, idA, "contratada", "Contrato 012/2026");
  await editarObra(engenheira, idA, { ...a, artNumero: "ART 2020260000001", ordemServicoNumero: "OS 05/2026", ordemServicoData: "2026-03-02" });
  await mudarSituacao(gestor, idA, "em_execucao", "OS 05/2026");
  await mudarSituacao(engenheira, idA, "concluida", "Segunda e última medição, atestada");
  await mudarSituacao(direcao, idA, "recebida_provisoriamente", "Termo de recebimento provisório 03/2026");
  await mudarSituacao(direcao, idA, "recebida_definitivamente", "Termo de recebimento definitivo 03/2026");

  // Obra B: reforma, execução mista, em andamento.
  const b: DadosObra = {
    ...base, codigo: "OB-2026-002", nome: "Reforma da Unidade de Saúde Central", tipo: "reforma", formaExecucao: "mista",
    endereco: "Avenida Principal, 800, Centro", areaM2: 640, latitude: -22.521, longitude: -43.176,
    fonteRecurso: "Convênio estadual", convenio: "Convênio 77/2025", processoAdministrativo: "PA 0230/2026",
    licitacao: "Concorrência 02/2026", dataInicioPrevista: "2026-05-04", dataFimPrevista: "2026-12-18",
    artNumero: "ART 2020260000002", ordemServicoNumero: "OS 11/2026", ordemServicoData: "2026-05-04",
  };
  const idB = await criarObra(engenheira, b);
  await equipe(idB, true);
  await mudarSituacao(engenheira, idB, "orcada", "Orçamento 004/2026");
  await mudarSituacao(gestor, idB, "licitada", "Concorrência 02/2026");
  await mudarSituacao(gestor, idB, "contratada", "Contrato 031/2026");
  await mudarSituacao(gestor, idB, "em_execucao", "OS 11/2026");

  // Obra C: calçada, execução direta.
  const c: DadosObra = {
    ...base, codigo: "OB-2026-003", nome: "Calçada acessível da Rua Principal", tipo: "urbanizacao", formaExecucao: "direta",
    endereco: "Rua Principal, do número 1 ao 240", extensaoM: 120, latitude: -22.523, longitude: -43.181,
    fonteRecurso: "Recursos próprios", processoAdministrativo: "PA 0312/2026",
    dataInicioPrevista: "2026-09-01", dataFimPrevista: "2026-12-05",
    artNumero: "ART 2020260000003", ordemServicoNumero: "OS 19/2026", ordemServicoData: "2026-09-01",
  };
  const idC = await criarObra(engenheira, c);
  await equipe(idC, false);
  await mudarSituacao(engenheira, idC, "orcada", "Orçamento 009/2026");
  await mudarSituacao(engenheira, idC, "em_execucao", "OS 19/2026");

  // Obra D: ainda em estudo.
  const idD = await criarObra(engenheira, {
    ...base, codigo: "OB-2026-004", nome: "Praça do Bairro Novo", tipo: "urbanizacao", formaExecucao: "contratada",
    endereco: "Quadra 12, Bairro Novo", areaM2: 1800, processoAdministrativo: "PA 0455/2026",
  });
  await vincular(direcao, idD, ator.administrativo.id, "administrativo");

  // Base de preços de demonstração (global) e orçamentos de exemplo.
  const conexao = await pool().connect();
  let tabelaId: string;
  try {
    await conexao.query("begin");
    const r = await gravarCargaSinapi(conexao, cargaDemonstracao(), "demonstracao");
    await conexao.query("commit");
    tabelaId = r.find((x) => x.regime === "nao_desonerado")!.tabelaId;
  } finally { conexao.release(); }

  // Obra A: muro de 10 m x 2 m pelo assistente, aprovado com nota.
  const orcA = await criarOrcamento(engenheira, { obraId: idA, nome: "Muro de fechamento", tabelaId });
  const linhas = await sugerirMuro(engenheira, orcA, PADRAO_MURO);
  await lancarMuro(engenheira, orcA, {
    nomeEtapa: "Muro", modo: "servico",
    linhas: linhas.filter((l) => l.escolhida).map((l) => ({ composicaoId: l.escolhida!, quantidade: l.quantidade, memoria: l.memoria })),
  });
  const oA = await obterOrcamento(engenheira, orcA);
  await salvarDadosGerais(engenheira, orcA, {
    ...oA, responsavelTecnico: "Carla Nogueira", registroProfissional: "CREA-RJ 000000-0", art: "ART 2020260000001",
  });
  await salvarCronograma(engenheira, orcA, {
    periodos: 4, unidadePeriodo: "semana", inicio: "2026-03-02",
    percentuais: { [oA.etapas[0].id]: { 1: "25", 2: "35", 3: "25", 4: "15" } },
  });
  await aprovarOrcamento(direcao, orcA);

  // Empresas e contratos.
  const construtora = await salvarEmpresa(gestor, {
    razaoSocial: "Construtora Exemplo Ltda", cnpj: "11.222.333/0001-81", tipo: "contratada",
    responsavel: "Paulo Souza", email: "contato@construtoraexemplo.exemplo", telefone: "(21) 3000-0000",
  });
  const reformas = await salvarEmpresa(gestor, { razaoSocial: "Reformas Modelo Engenharia Ltda", cnpj: "11.444.777/0001-61", tipo: "contratada", responsavel: "Ana Lima" });
  const deposito = await salvarEmpresa(gestor, { razaoSocial: "Depósito de Materiais Central", cnpj: "45.723.174/0001-10", tipo: "fornecedor" });

  // Obra A: contrato 012/2026 do muro, já cumprido, com cronograma executado.
  const ctA = await criarContrato(gestor, {
    orcamentoId: orcA, empresaId: construtora, numero: "012/2026", processo: "PA 0101/2026", objeto: "Muro de fechamento da Escola Municipal Modelo",
    regime: "preco_unitario", natureza: "obra_nova", desconto: "3", dataAssinatura: "2026-02-20", dataOrdemServico: "2026-03-02",
    prazoExecucaoDias: 30, vigenciaFim: "2026-06-30", dataBase: "2026-02-01", indiceReajuste: "INCC-DI", gestorId: gestor.id, fiscalId: ator.fiscal.id,
  });
  await assinarContrato(gestor, ctA);
  const cronA = await criarCronograma(engenheira, ctA, { inicio: "2026-03-02", calendario: "uteis", unidadePeriodo: "semana" });
  await gravarLinhaBase(engenheira, cronA);
  for (const at of (await obterCronograma(engenheira, cronA)).atividades.filter((x) => x.duracao > 0)) {
    await registrarAvanco(ator.fiscal, cronA, at.id, { data: at.fim!, percentual: "100", justificativa: "Serviço concluído e conferido em campo" });
  }

  // Medição única do muro: tudo executado, atestado, aprovado e pago.
  const itensA = (await obterContrato(gestor, ctA)).itens;
  const periodoA = { periodoInicio: "2026-03-02", periodoFim: "2026-03-31" };
  const mA = await criarMedicao(engenheira, ctA, periodoA);
  await salvarBoletim(engenheira, mA, { ...periodoA, linhas: itensA.map((i) => ({ itemServicoId: i.id, quantidade: i.quantidade, memoria: "Conforme projeto, conferido em campo" })) });
  await atestarMedicao(ator.fiscal, mA, "Serviços concluídos e conferidos");
  const brutoA = itensA.reduce((s, i) => s + Number(i.total), 0);
  await adicionarRetencao(gestor, mA, { tipo: "iss", base: (brutoA / 2).toFixed(2).replace(".", ","), aliquota: "5" });
  await aprovarMedicao(gestor, mA);
  const hojeSp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  await registrarNotaFiscal(ator.financeiro, mA, { numero: "1042", data: hojeSp, valor: brutoA.toFixed(2).replace(".", ",") });
  const liqA = brutoA - Math.round(brutoA / 2 * 0.05 * 100) / 100;
  await registrarPagamento(ator.financeiro, mA, { data: hojeSp, valor: liqA.toFixed(2).replace(".", ","), empenho: "2026NE00045", liquidacao: "2026NL00102", ordemBancaria: "2026OB00230" });

  // Contrato cumprido e obra recebida: o contrato fica encerrado.
  await comContexto({ usuarioId: gestor.id, orgaoId }, (k) => k.query("update contrato set situacao = 'encerrado' where id = $1", [ctA]));

  // Obra B: reforma em andamento, com contrato, garantia e cronograma com avanço parcial.
  const orcB = await criarOrcamento(engenheira, { obraId: idB, nome: "Reforma das salas de atendimento", tabelaId });
  const compB = async (busca: string) => (await buscarComposicoes(engenheira, { tabelaId, busca }))[0];
  const alvB = await adicionarEtapa(engenheira, orcB, "Alvenaria e revestimento");
  await adicionarComposicao(engenheira, orcB, (await compB("alvenaria")).id, { etapaId: alvB, quantidade: "120", memoria: "Novas divisórias das salas 1 a 6" });
  await adicionarComposicao(engenheira, orcB, (await compB("chapisco")).id, { etapaId: alvB, quantidade: "240", memoria: "2 faces x 120 m²" });
  await adicionarComposicao(engenheira, orcB, (await compB("reboco")).id, { etapaId: alvB, quantidade: "240", memoria: "2 faces x 120 m²" });
  const pinB = await adicionarEtapa(engenheira, orcB, "Pintura");
  await adicionarComposicao(engenheira, orcB, (await compB("pintura")).id, { etapaId: pinB, quantidade: "640", memoria: "Paredes novas e existentes" });
  const oB = await obterOrcamento(engenheira, orcB);
  await salvarDadosGerais(engenheira, orcB, { ...oB, responsavelTecnico: "Carla Nogueira", registroProfissional: "CREA-RJ 000000-0", art: "ART 2020260000002" });
  await salvarCronograma(engenheira, orcB, {
    periodos: 2, unidadePeriodo: "mes", inicio: "2026-11-02",
    percentuais: { [oB.etapas[0].id]: { 1: "70", 2: "30" }, [oB.etapas[1].id]: { 1: "20", 2: "80" } },
  });
  await aprovarOrcamento(direcao, orcB);
  const ctB = await criarContrato(gestor, {
    orcamentoId: orcB, empresaId: reformas, numero: "031/2026", processo: "PA 0230/2026", objeto: "Reforma das salas de atendimento da Unidade de Saúde Central",
    regime: "preco_unitario", natureza: "reforma", desconto: "4,5", dataAssinatura: "2026-10-26", dataOrdemServico: "2026-11-02",
    prazoExecucaoDias: 60, vigenciaFim: "2027-03-31", dataBase: "2026-10-01", indiceReajuste: "INCC-DI", gestorId: gestor.id, fiscalId: ator.fiscal.id,
  });
  await assinarContrato(gestor, ctB);
  await adicionarGarantia(gestor, ctB, { modalidade: "seguro_garantia", valor: "2500,00", instituicao: "Seguradora Exemplo S.A.", documento: "Apólice 0001", inicio: "2026-10-26", vencimento: "2027-04-30" });
  const cronB = await criarCronograma(engenheira, ctB, { inicio: "2026-11-03", calendario: "uteis", unidadePeriodo: "semana" });
  // Chapisco começa dois dias depois da alvenaria; a pintura espera o reboco.
  const atsB = (await obterCronograma(engenheira, cronB)).atividades;
  const porCodigo = (k: string) => atsB.find((x) => x.codigo === k)!;
  const ch = porCodigo("1.2");
  await editarAtividade(engenheira, cronB, ch.id, { codigo: "1.2", nome: ch.nome, duracao: ch.duracao, predecessoras: "1.1II+2", itemServicoId: ch.itemServicoId });
  await gravarLinhaBase(engenheira, cronB);
  const atsB2 = (await obterCronograma(engenheira, cronB)).atividades;
  await registrarAvanco(ator.fiscal, cronB, atsB2.find((x) => x.codigo === "1.1")!.id, { data: "2026-11-10", percentual: "40", justificativa: "Conferência de campo, salas 1 a 3" });

  // Medição 01 aprovada e a pagar; medição 02 em elaboração. O avanço do cronograma vem da medição aprovada.
  const itB = (await obterContrato(gestor, ctB)).itens;
  const periodoB1 = { periodoInicio: "2026-11-02", periodoFim: "2026-11-20" };
  const mB1 = await criarMedicao(engenheira, ctB, periodoB1);
  await salvarBoletim(engenheira, mB1, { ...periodoB1, linhas: [
    { itemServicoId: itB[0].id, quantidade: "102", memoria: "Salas 1 a 5: 5 x 20,40 m²" },
    { itemServicoId: itB[1].id, quantidade: "168", memoria: "Salas 1 a 4, duas faces: 4 x 2 x 21,00 m²" },
    { itemServicoId: itB[2].id, quantidade: "36", memoria: "Sala 1, duas faces: 2 x 18,00 m²" },
  ] });
  await atestarMedicao(ator.fiscal, mB1, "Quantidades conferidas em campo");
  await adicionarGlosa(ator.fiscal, mB1, { motivo: "Reboco da sala 1 com fissuras, refazer 4 m²", valor: "120,00", itemServicoId: itB[2].id });
  const brutoB1 = 102 * Number(itB[0].precoUnitario) + 168 * Number(itB[1].precoUnitario) + 36 * Number(itB[2].precoUnitario);
  const baseB = ((brutoB1 - 120) / 2).toFixed(2).replace(".", ",");
  await adicionarRetencao(gestor, mB1, { tipo: "iss", base: baseB, aliquota: "5" });
  await adicionarRetencao(gestor, mB1, { tipo: "inss", base: baseB, aliquota: "11" });
  await aprovarMedicao(gestor, mB1, "De acordo");
  const periodoB2 = { periodoInicio: "2026-11-21", periodoFim: "2026-11-30" };
  const mB2 = await criarMedicao(engenheira, ctB, periodoB2);
  await salvarBoletim(engenheira, mB2, { ...periodoB2, linhas: [
    { itemServicoId: itB[0].id, quantidade: "18", memoria: "Sala 6: 18,00 m²" },
    { itemServicoId: itB[1].id, quantidade: "52", memoria: "Salas 5 e 6, duas faces" },
  ] });

  // 1º aditivo assinado: sala 7, rodapé novo e mais prazo. 2º aditivo em elaboração. Reequilíbrio a partir de 21/11.
  const adB1 = await criarAditivo(gestor, ctB, {
    objeto: "Inclusão da sala 7 e de rodapé cerâmico, com prorrogação do prazo de execução",
    justificativa: "A vistoria de 12/11 apontou a necessidade de reformar também a sala 7, que não constava do projeto básico, e de instalar rodapé cerâmico nas salas 1 a 7 para proteger o revestimento novo.",
    fundamento: FUNDAMENTOS[0], prazoDias: 20,
  });
  await salvarAditivo(gestor, adB1, {
    objeto: "Inclusão da sala 7 e de rodapé cerâmico, com prorrogação do prazo de execução",
    justificativa: "A vistoria de 12/11 apontou a necessidade de reformar também a sala 7, que não constava do projeto básico, e de instalar rodapé cerâmico nas salas 1 a 7 para proteger o revestimento novo.",
    fundamento: FUNDAMENTOS[0], prazoDias: 20,
    linhas: [{ itemServicoId: itB[0].id, variacao: "24" }, { itemServicoId: itB[1].id, variacao: "48" }, { itemServicoId: itB[2].id, variacao: "48" }],
  });
  await incluirItem(gestor, adB1, { etapa: itB[0].etapa, descricao: "Rodapé cerâmico h = 7 cm, assentado com argamassa", unidade: "m", quantidade: "96", precoUnitario: "28,40", fonte: "cotacao" });
  await assinarAditivo(gestor, adB1, "2026-11-24");
  const adB2 = await criarAditivo(gestor, ctB, {
    objeto: "Prorrogação da vigência e supressão de pintura", fundamento: FUNDAMENTOS[1], novaVigencia: "2027-06-30",
    justificativa: "As paredes da sala 2 foram mantidas com o revestimento original em bom estado, dispensando a pintura prevista. A vigência é estendida para cobrir o recebimento definitivo.",
  });
  await salvarAditivo(gestor, adB2, {
    objeto: "Prorrogação da vigência e supressão de pintura", fundamento: FUNDAMENTOS[1], novaVigencia: "2027-06-30",
    justificativa: "As paredes da sala 2 foram mantidas com o revestimento original em bom estado, dispensando a pintura prevista. A vigência é estendida para cobrir o recebimento definitivo.",
    linhas: [{ itemServicoId: itB[3].id, variacao: "-64" }],
  });
  await registrarRevisao(gestor, ctB, {
    tipo: "reequilibrio", inicio: "2026-11-21", percentual: "3,2",
    justificativa: "Alta extraordinária do cimento e da cal no mês de novembro, comprovada por notas fiscais de três fornecedores e pela variação do SINAPI insumos.",
    documento: "PA 0311/2026 · parecer técnico 18/2026",
  });

  // Obra B em campo: diário de 03/11 até hoje (faltam 06/11 e 19/11), qualidade e segurança.
  const { fiscal, campo } = ator;
  const atsCampo = (await obterCronograma(engenheira, cronB)).atividades;
  const pintura = atsCampo.find((x) => x.itemServicoId === itB[3].id)!;
  await registrarOcorrencia(campo, idB, {
    tipo: "acidente_sem_afastamento", data: "2026-11-05", hora: "10:20", local: "Sala 2", descricao: "Corte superficial na mão ao manusear bloco cerâmico sem luva.",
    envolvido: "Antônio Ferreira", empresa: "Reformas Exemplo Ltda.", acaoCorretiva: "Entrega de luva de raspa e orientação da equipe no diálogo de segurança",
    responsavel: "Encarregado da contratada", prazo: "2026-11-06",
  });
  const riscoId = await registrarOcorrencia(fiscal, idB, {
    tipo: "risco_grave", data: "2026-11-18", hora: "08:40", local: "Fachada lateral", descricao: "Andaime fachadeiro sem guarda-corpo e sem travamento no 2º nível.",
    empresa: "Reformas Exemplo Ltda.", acaoCorretiva: "Montagem do guarda-corpo, travamento e liberação do andaime pelo técnico de segurança",
    responsavel: "Reformas Exemplo Ltda.", prazo: "2026-11-19", paralisacao: true, horasParalisadas: 3,
  });
  await registrarOcorrencia(campo, idB, {
    tipo: "quase_acidente", data: "2026-11-23", hora: "14:10", local: "Corredor de acesso", descricao: "Balde de argamassa caiu do andaime a 1 m de um servente.",
    acaoCorretiva: "Instalar rodapé de contenção no andaime e isolar a área abaixo", responsavel: "Encarregado da contratada", prazo: "2026-11-27",
  });
  const dias = ["03", "04", "05", "07", "09", "10", "11", "12", "13", "16", "17", "18", "20", "21", "23", "24", "25"].map((d) => `2026-11-${d}`);
  const clima: Record<string, [Clima, Clima, Condicao]> = {
    "2026-11-10": ["chuva_forte", "chuva_fraca", "impraticavel"], "2026-11-11": ["nublado", "chuva_fraca", "parcial"], "2026-11-17": ["nublado", "nublado", "praticavel"],
  };
  const relatos: Record<string, string> = {
    "2026-11-03": "Início dos serviços. Locação das divisórias das salas 1 a 3 e recebimento de 4.000 blocos cerâmicos.",
    "2026-11-10": "Chuva forte pela manhã. Serviços internos só a partir das 13 h.",
    "2026-11-18": "Frente da fachada parada até a correção do andaime. Equipe remanejada para as salas 5 e 6.",
    "2026-11-24": "Início da pintura na sala 1 após liberação do reboco.",
  };
  for (const [i, data] of dias.entries()) {
    const id = await abrirDiario(campo, idB, data);
    const [m, t, cond] = clima[data] ?? ["bom", "bom", "praticavel"];
    await salvarDiario(campo, id, { climaManha: m, climaTarde: t, condicao: cond, relato: relatos[data] ?? `Execução das divisórias e revestimento conforme programação da semana.` });
    const pedreiros = data >= "2026-11-16" ? 5 : 4;
    await adicionarLinha(campo, id, { tipo: "efetivo", funcao: "Encarregado", empresa: "Reformas Exemplo Ltda.", quantidade: 1 });
    await adicionarLinha(campo, id, { tipo: "efetivo", funcao: "Pedreiro", empresa: "Reformas Exemplo Ltda.", quantidade: pedreiros });
    await adicionarLinha(campo, id, { tipo: "efetivo", funcao: "Servente", empresa: "Reformas Exemplo Ltda.", quantidade: pedreiros + 1 });
    if (data >= "2026-11-24") await adicionarLinha(campo, id, { tipo: "efetivo", funcao: "Pintor", empresa: "Reformas Exemplo Ltda.", quantidade: 2 });
    await adicionarLinha(campo, id, { tipo: "equipamento", descricao: "Betoneira 400 L", quantidade: 1, horas: data === "2026-11-10" ? 3 : 7 });
    if (i % 3 === 0) await adicionarLinha(campo, id, { tipo: "equipamento", descricao: "Andaime fachadeiro (módulos)", quantidade: 12, horas: null });
    const sala = Math.min(6, 1 + Math.floor(i / 3));
    await adicionarLinha(campo, id, { tipo: "servico", descricao: data < "2026-11-16" ? "Elevação de alvenaria de vedação" : "Chapisco e reboco das divisórias", local: `Sala ${sala}` });
    if (data === "2026-11-24") await adicionarLinha(campo, id, { tipo: "servico", descricao: "", atividadeId: pintura.id, avancoPct: 8, local: "Sala 1" });
    if (data === "2026-11-25") await adicionarLinha(campo, id, { tipo: "servico", descricao: "", atividadeId: pintura.id, avancoPct: 15, local: "Salas 1 e 2" });
    if (data === "2026-11-10") await adicionarLinha(campo, id, { tipo: "ocorrencia", subtipo: "paralisacao", motivo: "chuva", horas: 4, descricao: "Chuva forte entre 7 h e 11 h." });
    if (data === "2026-11-13") await adicionarLinha(campo, id, { tipo: "ocorrencia", subtipo: "paralisacao", motivo: "falta_material", horas: 2, descricao: "Atraso na entrega de cal hidratada." });
    if (data === "2026-11-12") await adicionarLinha(campo, id, { tipo: "ocorrencia", subtipo: "visita", descricao: "Vistoria da fiscalização com a direção da unidade de saúde. Pedida a inclusão da sala 7." });
    if (data === "2026-11-25") continue;
    await assinarDiario(engenheira, id);
    if (data < "2026-11-23") await vistarDiario(fiscal, id, data === "2026-11-18" ? "Liberação do andaime conferida às 11 h 40." : null);
  }
  await encerrarOcorrencia(fiscal, riscoId, "Guarda-corpo e travamento instalados; andaime liberado pelo técnico de segurança às 11 h 40.");
  const d12 = await abrirDiario(campo, idB, "2026-11-12");
  await complementarDiario(fiscal, d12, "Registro do pedido de inclusão da sala 7, com croqui anexado ao processo PA 0230/2026.");
  await registrarEpi(campo, idB, { data: "2026-11-03", trabalhador: "Antônio Ferreira", funcao: "Pedreiro", empresa: "Reformas Exemplo Ltda.", epis: ["Capacete", "Calçado de segurança", "Óculos de proteção"] });
  await registrarEpi(campo, idB, { data: "2026-11-05", trabalhador: "Antônio Ferreira", funcao: "Pedreiro", empresa: "Reformas Exemplo Ltda.", epis: ["Luva de raspa"], ca: "38.512" });
  await registrarEpi(campo, idB, { data: "2026-11-16", trabalhador: "José Carlos", funcao: "Servente", empresa: "Reformas Exemplo Ltda.", epis: ["Capacete", "Calçado de segurança", "Luva de raspa", "Protetor auricular"] });
  await registrarEpi(campo, idB, { data: "2026-11-19", trabalhador: "Rogério Alves", funcao: "Pedreiro", empresa: "Reformas Exemplo Ltda.", epis: ["Cinto paraquedista", "Talabarte duplo"], ca: "41.230" });

  const resp = (m: string, falhas: number[], obs: Record<number, string> = {}) => MODELOS.find((x) => x.chave === m)!.itens.map((_, i) => ({ resposta: falhas.includes(i) ? "nao_conforme" : "conforme", observacao: obs[i] ?? null }));
  await registrarInspecao(fiscal, idB, { modelo: "alvenaria", data: "2026-11-12", local: "Salas 1 a 4", itemServicoId: itB[0].id, respostas: resp("alvenaria", [1], { 1: "Divisória da sala 4 com desvio de prumo de 12 mm" }), abrirNcs: true, responsavel: "Reformas Exemplo Ltda." });
  await registrarInspecao(fiscal, idB, { modelo: "revestimento", data: "2026-11-20", local: "Salas 1 a 3", itemServicoId: itB[2].id, respostas: resp("revestimento", []) });
  await registrarInspecao(fiscal, idB, { modelo: "altura", data: "2026-11-18", local: "Fachada lateral", respostas: resp("altura", [4, 5], { 4: "Sem guarda-corpo no 2º nível", 5: "Periferia aberta" }), abrirNcs: true, responsavel: "Reformas Exemplo Ltda." });
  await registrarInspecao(campo, idB, { modelo: "epi", data: "2026-11-23", local: "Canteiro", respostas: resp("epi", [4], { 4: "Dois serventes sem protetor auricular na betoneira" }) });
  const ncReboco = await abrirNc(fiscal, idB, {
    titulo: "Fissuras no reboco da sala 1", descricao: "Fissuras mapeadas em cerca de 4 m² da parede norte da sala 1, com som cavo. Refazer o trecho.",
    local: "Sala 1, parede norte", itemServicoId: itB[2].id, gravidade: "grave", impeditiva: true, responsavel: "Reformas Exemplo Ltda.", prazo: "2026-11-27",
  });
  await corrigirNc(campo, ncReboco, "Trecho removido, base limpa e reboco refeito em 23/11.");
  await registrarEnsaio(fiscal, idB, {
    tipo: "Resistência de aderência à tração", itemServicoId: null, local: "Sala 2, 6 pontos", dataColeta: "2026-11-17", dataResultado: "2026-11-24",
    unidade: "MPa", criterio: "minimo", especificado: "0,30", resultado: "0,36", laboratorio: "Laboratório Exemplo de Materiais", laudo: "LEM-2026-1187",
  });
  await registrarEnsaio(fiscal, idB, {
    tipo: "Resistência de aderência à tração", itemServicoId: null, local: "Sala 4, 6 pontos", dataColeta: "2026-11-17", dataResultado: "2026-11-24",
    unidade: "MPa", criterio: "minimo", especificado: "0,30", resultado: "0,24", laboratorio: "Laboratório Exemplo de Materiais", laudo: "LEM-2026-1188",
  });
  // A não conformidade de prumo aberta em 12/11 ficou com o prazo vencido.
  await comContexto({ usuarioId: null, orgaoId }, (c) => c.query(
    "update nao_conformidade set prazo = '2026-11-19' where obra_id = $1 and origem = 'inspecao' and area = 'qualidade'", [idB]));

  // Obra B em suprimentos: catálogo do orçamento, requisição aprovada, duas cotações, pedidos, recebimento e consumo.
  const { administrativo } = ator;
  await importarDoOrcamento(campo, idB);
  const supB = await painelSuprimentos(campo, idB);
  const prev = supB.estoque.filter((l) => l.previsto > 0).sort((a, b) => b.previsto - a.previsto).slice(0, 4);
  const necessidade = new Date(Date.parse(`${hojeSp}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const reqB = await criarRequisicao(campo, idB, { necessidade, observacao: "Material para as salas 5 a 7" });
  for (const [k, l] of prev.entries()) {
    const q = Math.max(1, Math.round(l.previsto * (k === 0 ? 0.6 : 0.5)));
    await adicionarItemRequisicao(campo, reqB, { materialId: l.materialId, quantidade: String(q), itemServicoId: itB[k === 3 ? 3 : Math.min(k, 2)].id });
  }
  await enviarRequisicao(campo, reqB);
  await decidirRequisicao(engenheira, reqB, true);
  const materiaisB = await salvarEmpresa(gestor, { razaoSocial: "Casa do Construtor Vila Exemplo Ltda", cnpj: "98.765.432/0001-98", tipo: "fornecedor", responsavel: "Rita Gomes", telefone: "(21) 3111-2222" });
  const itensReq = (await obterRequisicao(gestor, reqB)).itens;
  const precos = (fator: number[]) => Object.fromEntries(itensReq.map((i, k) => [i.id, ((i.referencia ?? 10) * fator[k % fator.length]).toFixed(2).replace(".", ",")]));
  const cot1 = await registrarCotacao(administrativo, reqB, { empresaId: deposito, prazoEntrega: 5, frete: "180", condicaoPagamento: "30 dias após a entrega", precos: precos([0.96, 1.04, 0.98, 1.02]) });
  const cot2 = await registrarCotacao(administrativo, reqB, { empresaId: materiaisB, prazoEntrega: 3, frete: "0", condicaoPagamento: "28 dias", precos: precos([1.01, 0.97, 1.03, 0.95]) });
  const mapa = await obterRequisicao(gestor, reqB);
  const doMenor = (cot: string) => mapa.itens.filter((i) => { const c = mapa.cotacoes.find((x) => x.id === cot)!; return c.precos[i.id] != null && c.precos[i.id] === mapa.menor[i.id]; }).map((i) => i.id);
  const ped1 = await emitirPedido(gestor, cot1, { itens: doMenor(cot1) });
  const ped2 = await emitirPedido(gestor, cot2, { itens: doMenor(cot2) });
  const p1 = await obterPedido(campo, ped1);
  await registrarRecebimento(campo, ped1, {
    data: hojeSp, notaFiscal: "18.233", notaQualidade: 5, notaAtendimento: 4, observacao: "Descarga na sala 7",
    itens: p1.itens.map((i, k) => {
      if (k === 0) return { pedidoItemId: i.id, quantidade: String(Math.round(i.quantidade * 0.6)) };
      if (k !== 1) return { pedidoItemId: i.id, quantidade: String(i.quantidade) };
      const recusada = Math.max(1, Math.round(i.quantidade * 0.05));
      return { pedidoItemId: i.id, quantidade: String(i.quantidade - recusada), recusada: String(recusada), motivo: "Sacos rasgados" };
    }),
  });
  const estB = (await painelSuprimentos(campo, idB)).estoque.filter((l) => l.saldo > 0);
  if (estB[0]) {
    await registrarMovimento(campo, idB, { tipo: "saida", materialId: estB[0].materialId, quantidade: String(Math.round(estB[0].saldo * 0.55)), data: hojeSp, itemServicoId: itB[0].id });
    await registrarMovimento(campo, idB, { tipo: "perda", materialId: estB[0].materialId, quantidade: String(Math.max(1, Math.round(estB[0].saldo * 0.04))), data: hojeSp, observacao: "Quebra no transporte interno" });
    await definirMinimo(campo, idB, estB[0].materialId, String(Math.round(estB[0].saldo * 0.6)));
  }
  void ped2;

  // Equipe própria da prefeitura na obra B (execução mista), com ASO e NR, horas e equipamentos.
  const cpfs = ["529.982.247-25", "111.444.777-35", "390.533.447-05", "123.456.789-09", "987.654.321-00", "286.255.878-87"];
  const equipePropria: [string, string, string][] = [
    ["Antônio Ferreira", "Encarregado", "38,50"], ["Rogério Alves", "Pedreiro", "27,80"], ["José Carlos", "Servente", "19,40"],
    ["Marcelo Dias", "Pintor", "26,90"], ["Luís Henrique", "Pedreiro", "27,80"], ["Wagner Souza", "Eletricista", "31,20"],
  ];
  const idsEquipe: string[] = [];
  for (const [k, [nome, funcao, custo]] of equipePropria.entries()) {
    const pid = await salvarPessoa(administrativo, null, { nome, cpf: cpfs[k], funcao, custoHora: custo });
    idsEquipe.push(pid);
    await registrarHabilitacao(administrativo, pid, { tipo: "aso", descricao: "Admissional", data: "2026-02-10", validade: k === 3 ? "2026-12-08" : "2027-02-10" });
    await registrarHabilitacao(administrativo, pid, { tipo: "treinamento", descricao: "NR-18 Integração na construção", data: "2026-10-28", validade: "2027-10-28", cargaHoraria: "6" });
    if (k === 1) await registrarHabilitacao(administrativo, pid, { tipo: "treinamento", descricao: "NR-35 Trabalho em altura", data: "2024-11-20", validade: "2026-11-20", cargaHoraria: "8" });
    if (k === 5) await registrarHabilitacao(administrativo, pid, { tipo: "treinamento", descricao: "NR-10 Segurança em eletricidade", data: "2025-03-01", validade: "2027-03-01", cargaHoraria: "40" });
  }
  for (const [k, pid] of idsEquipe.slice(0, 5).entries()) await alocarPessoa(engenheira, idB, { pessoaId: pid, inicio: "2026-11-03", funcao: equipePropria[k][1] });
  const betoneira = await salvarEquipamento(administrativo, null, { descricao: "Betoneira 400 L", identificacao: "PAT-0412", propriedade: "proprio", custoHora: "9,80" });
  await registrarManutencao(administrativo, betoneira, { data: "2026-10-20", tipo: "preventiva", descricao: "Troca de correia e lubrificação", proximaRevisao: "2027-01-20", custo: "180,00" });
  await alocarEquipamento(engenheira, idB, { equipamentoId: betoneira, inicio: "2026-11-03" });
  const locadora = await salvarEmpresa(gestor, { razaoSocial: "Locadora de Equipamentos Exemplo Ltda", cnpj: "31.415.926/0001-71", tipo: "fornecedor" });
  const andaime = await salvarEquipamento(administrativo, null, { descricao: "Andaime fachadeiro (12 módulos)", identificacao: "Contrato 77/2026", propriedade: "locado", empresaId: locadora, custoHora: "4,10" });
  await alocarEquipamento(engenheira, idB, { equipamentoId: andaime, inicio: "2026-11-03" });
  const compactador = await salvarEquipamento(administrativo, null, { descricao: "Compactador de solo tipo sapo", identificacao: "PAT-0388", propriedade: "proprio", custoHora: "14,50" });
  await registrarManutencao(administrativo, compactador, { data: "2026-05-15", tipo: "revisao", descricao: "Revisão do motor", proximaRevisao: "2026-11-15", custo: "420,00" });
  const diasHoras = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25"];
  for (const [k, data] of diasHoras.entries()) {
    const servico = data < "2026-11-20" ? itB[1].id : data < "2026-11-24" ? itB[2].id : itB[3].id;
    const linhas = idsEquipe.slice(0, 5).filter((_, j) => j !== 3 || data >= "2026-11-24").filter((_, j) => j !== 1 || data <= "2026-11-20")
      .map((pessoaId, j) => ({ pessoaId, normais: "8", extras: j === 0 && k % 3 === 0 ? "2" : "" }));
    await apontarHoras(campo, idB, { data, itemServicoId: servico, linhas });
    await apontarEquipamento(campo, idB, { data, equipamentoId: betoneira, itemServicoId: servico, horas: data === "2026-11-18" ? "4" : "6" });
    if (data <= "2026-11-20") await apontarEquipamento(campo, idB, { data, equipamentoId: andaime, itemServicoId: itB[1].id, horas: "8" });
  }
  await registrarDocumentoEmpresa(administrativo, reformas, { tipo: "cnd_federal", numero: "0A1B.2C3D.4E5F.6G7H", emissao: "2026-09-01", validade: "2027-02-28" });
  await registrarDocumentoEmpresa(administrativo, reformas, { tipo: "fgts", numero: "2026091512345678", emissao: "2026-10-12", validade: "2026-11-10" });
  await registrarDocumentoEmpresa(administrativo, reformas, { tipo: "trabalhista", numero: "45871/2026", emissao: "2026-09-20", validade: "2027-03-19" });
  await registrarDocumentoEmpresa(administrativo, construtora, { tipo: "cnd_federal", numero: "9Z8Y.7X6W.5V4U.3T2S", emissao: "2026-08-10", validade: "2026-12-07" });

  // Documentos (etapa 8). Arquivos PDF mínimos, só para demonstração.
  const pdf = (nome: string) => ({ nome, conteudo: Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${nome}\ntrailer << /Root 1 0 R >>\n%%EOF\n`) });
  const hojeDoc = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const emDias = (n: number) => new Date(Date.parse(`${hojeDoc}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  // Obra A, concluída: ART de execução com baixa.
  const artA = await enviarDocumento(engenheira, idA, { categoria: "art_rrt", tipo: "ART de execução", titulo: "ART de execução do muro", numero: "2020260000001", emissor: "CREA-RJ",
    emissao: "2026-02-27", exigencia: "art_execucao", contratoId: ctA, conselho: "CREA", profissional: "Eduardo Saraiva", registro: "CREA-RJ 2009123456", atividade: "Execução de muro de alvenaria, 120 m" }, pdf("art-execucao-muro.pdf"));
  await baixarArt(engenheira, artA, "2026-06-30");
  // Obra B, em execução: ARTs, projeto com revisão, alvará vencendo e licença dispensada; falta a ordem de serviço digitalizada.
  await enviarDocumento(engenheira, idB, { categoria: "art_rrt", tipo: "ART de projeto", titulo: "ART dos projetos de reforma", numero: "2020260003311", emissor: "CREA-RJ",
    emissao: "2026-07-14", exigencia: "art_projeto", conselho: "CREA", profissional: "Carla Nogueira", registro: "CREA-RJ 000000-0", atividade: "Projeto de reforma de edificação de saúde, 640 m²" }, pdf("art-projeto.pdf"));
  await enviarDocumento(administrativo, idB, { categoria: "art_rrt", tipo: "ART de execução", titulo: "ART de execução da contratada", numero: "2020260004128", emissor: "CREA-RJ",
    emissao: "2026-10-30", exigencia: "art_execucao", contratoId: ctB, conselho: "CREA", profissional: "Leonardo Bastos", registro: "CREA-RJ 2005778899", atividade: "Execução de reforma de edificação, 640 m²" }, pdf("art-execucao.pdf"));
  await enviarDocumento(fiscal, idB, { categoria: "art_rrt", tipo: "ART de fiscalização", titulo: "ART de fiscalização", numero: "2020260004302", emissor: "CREA-RJ",
    emissao: "2026-11-03", exigencia: "art_fiscalizacao", contratoId: ctB, conselho: "CREA", profissional: "Rafael Pinto", registro: "CREA-RJ 000001-0", atividade: "Fiscalização de obra de reforma" }, pdf("art-fiscalizacao.pdf"));
  const arqRev0 = await enviarDocumento(engenheira, idB, { categoria: "projeto", tipo: "Projeto arquitetônico", titulo: "Arquitetura: planta de reforma", numero: "ARQ-01", emissor: "Secretaria de Obras",
    emissao: "2026-07-10" }, pdf("arq-01-r00.pdf"));
  const arqRev1 = await enviarDocumento(engenheira, idB, { categoria: "projeto", tipo: "Projeto arquitetônico", titulo: "Arquitetura: planta de reforma (revisão geral)", numero: "ARQ-01A", emissor: "Secretaria de Obras",
    emissao: "2026-09-22" }, pdf("arq-01a-r00.pdf"));
  await novaVersao(engenheira, arqRev1, pdf("arq-01a-r01.pdf"), "R01: ajuste do layout da sala de vacinação");
  await superarDocumento(engenheira, arqRev0, arqRev1, "Revisão geral do layout pedida pela Secretaria de Saúde");
  await enviarDocumento(engenheira, idB, { categoria: "projeto", tipo: "Projeto elétrico", titulo: "Instalações elétricas", numero: "ELE-01", emissor: "Secretaria de Obras", emissao: "2026-07-18" }, pdf("ele-01.pdf"));
  await enviarDocumento(administrativo, idB, { categoria: "licenca", tipo: "Alvará de obra", titulo: "Alvará de reforma nº 1.284/2026", numero: "1.284/2026", emissor: "Secretaria de Urbanismo",
    emissao: emDias(-170), validade: emDias(12), exigencia: "alvara" }, pdf("alvara-1284.pdf"));
  await enviarDocumento(engenheira, idB, { categoria: "laudo", tipo: "Laudo de vistoria", titulo: "Vistoria cautelar das edificações vizinhas", emissor: "Carla Nogueira", emissao: "2026-10-28" }, pdf("vistoria-cautelar.pdf"));
  await dispensarExigencia(direcao, idB, "licenca_ambiental", "Reforma interna sem ampliação de área; enquadrada como dispensada pelo órgão ambiental municipal (ofício 77/2026).");
  // Obra C, execução direta: falta a ART de execução; licença vencida.
  await enviarDocumento(engenheira, idC, { categoria: "art_rrt", tipo: "ART de projeto", titulo: "ART do projeto de acessibilidade", numero: "2020260002877", emissor: "CREA-RJ",
    emissao: "2026-08-05", exigencia: "art_projeto", conselho: "CREA", profissional: "Carla Nogueira", registro: "CREA-RJ 000000-0", atividade: "Projeto de calçada acessível, 420 m" }, pdf("art-projeto-calcada.pdf"));
  await enviarDocumento(engenheira, idC, { categoria: "licenca", tipo: "Autorização de supressão vegetal", titulo: "Autorização de poda e supressão", numero: "ASV 15/2026", emissor: "Secretaria de Meio Ambiente",
    emissao: emDias(-200), validade: emDias(-8) }, pdf("asv-15.pdf"));

  // Obra D: orçamento em elaboração.
  const orcD = await criarOrcamento(engenheira, { obraId: idD, nome: "Orçamento básico", tabelaId });
  const prelim = await adicionarEtapa(engenheira, orcD, "Serviços preliminares");
  const loc = (await buscarComposicoes(engenheira, { tabelaId, busca: "locação" }))[0];
  if (loc) await adicionarComposicao(engenheira, orcD, loc.id, { etapaId: prelim, quantidade: "180", memoria: "Perímetro da praça" });
  await adicionarEtapa(engenheira, orcD, "Pavimentação");

  // Cotações de materiais: uma apurada, uma aguardando apuração e uma recebendo propostas.
  const dvCnpj = (d: string) => { const p = d.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const r = p.reduce((t, x, i) => t + x * Number(d[i]), 0) % 11; return r < 2 ? 0 : 11 - r; };
  const cnpjDe = (base: string) => { const d1 = dvCnpj(base); return `${base}${d1}${dvCnpj(base + d1)}`; };
  const madeireira = await salvarEmpresa(gestor, { razaoSocial: "Madeireira e Ferragens Boa Obra Ltda", cnpj: cnpjDe("273645180001"), tipo: "fornecedor", responsavel: "Paulo Mendes", email: "vendas@boaobra.exemplo", telefone: "(21) 3222-4400" });
  const atacado = await salvarEmpresa(gestor, { razaoSocial: "Atacado da Construção Fluminense S.A.", cnpj: cnpjDe("604518230001"), tipo: "fornecedor", responsavel: "Lúcia Prado", email: "cotacao@atacadofluminense.exemplo", telefone: "(21) 3555-9090" });
  const serraAzul = await salvarEmpresa(gestor, { razaoSocial: "Comercial Serra Azul Materiais Ltda", cnpj: cnpjDe("318840270001"), tipo: "fornecedor", responsavel: "Jorge Leal", email: "orcamento@serraazul.exemplo", telefone: "(21) 3777-1212" });
  const prazoCot = (dias: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(Date.now() + dias * 86400000)).replace(" ", "T");
  const fator = (v: string | null, f: number) => (Number(v ?? "10") * f).toFixed(2).replace(".", ",");
  const marcasDemo = ["Votoran", "Quartzolit", "Tigre", "Gerdau", "Suvinil", "Eliane", "Portobello", "Amanco"];
  async function cotacaoDemo(orc: string, d: Omit<Parameters<typeof criarSolicitacao>[2], "chaves" | "prazo">, de: number, ate: number, fornecedores: string[],
    respostas: ({ fatores: (number | null)[]; entrega: string; pagamento: string; garantia?: string } | "declinou" | null)[]) {
    const { materiais: mats } = await materiaisDoOrcamento(engenheira, orc);
    const id = await criarSolicitacao(engenheira, orc, { ...d, prazo: prazoCot(6), chaves: mats.slice(de, ate).map((m) => m.chave) });
    for (const f of fornecedores) await adicionarConvite(engenheira, id, { empresaId: f });
    await enviarSolicitacao(engenheira, id, null);
    const s = await obterSolicitacao(engenheira, id);
    for (const [k, f] of fornecedores.entries()) {
      const cv = s.convites.find((c) => c.empresaId === f)!;
      const token = cv.link!.replace("/cotacao/", "");
      const r = respostas[k];
      await paginaDoFornecedor(token, null);
      if (r === "declinou") await declinar(token, "Sem estoque para o prazo pedido.", null);
      else if (r) await enviarProposta(token, {
        cnpj: cv.cnpj, responsavelNome: cv.contato ?? "Setor de vendas", responsavelCargo: "Vendas", prazoEntrega: r.entrega, validadeDias: "30", pagamentoDias: r.pagamento, garantiaMeses: r.garantia,
        itens: Object.fromEntries(s.materiais.map((m, i) => { const x = r.fatores[i % r.fatores.length]; return [m.id, x == null ? { indisponivel: true } : { preco: fator(m.precoReferencia, x), marca: marcasDemo[(i + k) % marcasDemo.length] }]; })),
      }, null);
    }
    return id;
  }
  const cotApurada = await cotacaoDemo(orcB, { titulo: "Argamassa, tinta e revestimento das salas", criterio: "global", localEntrega: "Rua das Acácias, 120, Centro", validadeMinima: "30", sigilo: true }, 0, 6,
    [deposito, materiaisB, madeireira, atacado],
    [{ fatores: [0.94, 0.97, 1.02, 0.9, 0.96, 0.99], entrega: "7", pagamento: "30" }, { fatores: [0.91, 1.01, 0.95, 0.93, 1.04, 0.92], entrega: "10", pagamento: "28" },
      { fatores: [1.03, 0.98, null, 0.97, 1.01, 1.06], entrega: "5", pagamento: "15" }, "declinou"]);
  await encerrarAntes(engenheira, cotApurada);
  await homologar(direcao, cotApurada, {});
  const cotEncerrada = await cotacaoDemo(orcA, { titulo: "Blocos, cimento e areia do muro", criterio: "item", localEntrega: "Canteiro da obra", sigilo: true }, 0, 5,
    [deposito, materiaisB, atacado, madeireira, serraAzul],
    [{ fatores: [0.95, 1.0, 0.88, 0.97, 1.02], entrega: "5", pagamento: "30" }, { fatores: [0.99, 0.92, 0.94, 0.4, 0.96], entrega: "8", pagamento: "30" }, { fatores: [0.9, 0.97, 1.05, 0.95, null], entrega: "12", pagamento: "45" },
      { fatores: [1.04, 0.96, 0.99, 1.08, 0.93], entrega: "6", pagamento: "21" }, { fatores: [0.97, 1.03, 0.91, 1.0, 1.07], entrega: "9", pagamento: "30" }]);
  await encerrarAntes(engenheira, cotEncerrada);
  await cotacaoDemo(orcB, { titulo: "Instalações e acabamentos", criterio: "custo_beneficio", pesos: { preco: 70, prazo: 20, pagamento: 0, garantia: 10, historico: 0 }, sigilo: true }, 6, 11,
    [deposito, materiaisB, madeireira], [{ fatores: [0.96, 0.98, 1.0, 0.93, 0.97], entrega: "6", pagamento: "30", garantia: "12" }, null, null]);

  console.log("Dados de exemplo carregados: 1 órgão, 8 usuários, 4 obras, base de demonstração, 3 orçamentos, 2 contratos, 2 cronogramas, 3 medições, 2 aditivos, 1 apostilamento, 17 diários de obra, 3 cotações de materiais, inspeções, ensaios, não conformidades, ocorrências de segurança, compras, estoque, equipe própria, equipamentos e documentos das obras.");
  console.log("Logins: direcao, gestor, engenheira, fiscal, administrativo, financeiro, campo e contratada, todos @vilaexemplo.exemplo.");
  console.log("Senha: a definida em SENHA_DEMO no .env, ou a padrão que está no início de scripts/semear.ts.");
}

principal().finally(fecharPool);
