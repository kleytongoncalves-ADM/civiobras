-- Assistente de orçamento: SCO-Rio como base de preços, classificação de cada base,
-- assuntos para navegar, base e data-base por item e composição congelada com a origem de cada linha.

-- 1. SCO-Rio (Prefeitura do Rio de Janeiro). O valor novo só é usado depois desta migração.
alter type fonte_preco add value if not exists 'sco';

-- A carga das classificações grava em tabelas da base pública.
select set_config('app.carga_precos', 'sim', true);

-- 2. Classificação publicada por cada base (SCO-Rio: categoria > clã > família; SINAPI: grupo; SICRO: grupo do código).
create table classificacao (
  id uuid primary key default gen_random_uuid(),
  fonte fonte_preco not null,
  nivel smallint not null check (nivel between 1 and 3),
  codigo text not null check (btrim(codigo) <> ''),
  nome text not null check (btrim(nome) <> ''),
  pai_id uuid references classificacao(id),
  unique (fonte, codigo)
);
create index classificacao_por_pai on classificacao (pai_id);

alter table classificacao enable row level security; alter table classificacao force row level security;
create policy classificacao_leitura on classificacao for select using (true);
create policy classificacao_escrita on classificacao for all
  using (coalesce(current_setting('app.carga_precos', true), '') = 'sim')
  with check (coalesce(current_setting('app.carga_precos', true), '') = 'sim');

-- 3. Assuntos do CiviObras: o que a pessoa vai executar. Juntam as classificações das bases,
-- sem substituí-las: cada serviço continua com a fonte e a classificação de origem.
create table assunto (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  nome text not null,
  resumo text not null,
  icone text not null,
  ordem int not null unique
);

-- Regras que ligam um serviço a um assunto. A primeira regra que casar (menor prioridade) vale.
-- classe: expressão sobre "código nome" da classificação (ou o grupo da composição);
-- descricao: expressão sobre a descrição do serviço. Regra sem assunto tira o serviço da navegação
-- (composições auxiliares, como argamassas e custos horários), mas ele continua na pesquisa livre.
create table assunto_regra (
  id int generated always as identity primary key,
  prioridade int not null,
  fonte text not null,
  assunto_id text references assunto(id),
  classe text,
  descricao text,
  check (classe is not null or descricao is not null)
);


alter table composicao
  add column classificacao_id uuid references classificacao(id),
  add column assunto_id text references assunto(id);
create index composicao_por_assunto on composicao (assunto_id) where orgao_id is null;
create index composicao_por_classificacao on composicao (classificacao_id);

insert into assunto (id, nome, resumo, icone, ordem) values
  ('servicos-preliminares', 'Serviços preliminares e canteiro', 'Placa, tapume, instalações provisórias, locação e proteção coletiva', 'HardHat', 1),
  ('demolicoes', 'Demolições e remoções', 'Demolições, retiradas e remoção de entulho', 'Hammer', 2),
  ('movimento-terra', 'Movimento de terra', 'Escavação, aterro, reaterro e escoramento de valas', 'Shovel', 3),
  ('fundacoes', 'Fundações e contenções', 'Estacas, tubulões, sapatas, radier e contenções', 'Anchor', 4),
  ('estrutura', 'Estrutura', 'Fôrmas, armação, concreto, lajes e estruturas metálicas e de madeira', 'Columns3', 5),
  ('alvenaria', 'Alvenaria e vedações', 'Alvenaria de vedação e estrutural, vergas, drywall e divisórias', 'BrickWall', 6),
  ('cobertura', 'Cobertura', 'Estrutura de telhado, telhas, calhas e rufos', 'House', 7),
  ('impermeabilizacao', 'Impermeabilização e isolamento', 'Mantas, membranas, proteção mecânica e isolamento', 'Umbrella', 8),
  ('revestimentos', 'Revestimentos e forros', 'Chapisco, emboço, reboco, cerâmica de parede, gesso e forros', 'Layers', 9),
  ('pisos', 'Pisos', 'Contrapiso, pisos, rodapés e soleiras', 'Grid3x3', 10),
  ('esquadrias', 'Esquadrias e vidros', 'Portas, janelas, grades, guarda-corpos e vidros', 'DoorOpen', 11),
  ('pintura', 'Pintura', 'Pintura interna, externa, em madeira, metal e piso', 'PaintRoller', 12),
  ('hidrossanitarias', 'Instalações hidrossanitárias', 'Água fria e quente, esgoto, águas pluviais, louças e metais', 'Droplets', 13),
  ('eletricas', 'Instalações elétricas e lógica', 'Eletrodutos, cabos, quadros, tomadas, iluminação, SPDA e lógica', 'Zap', 14),
  ('incendio-gas', 'Incêndio e gás', 'Prevenção e combate a incêndio, detecção e gás', 'Flame', 15),
  ('climatizacao', 'Climatização', 'Ar-condicionado, dutos e exaustão', 'Fan', 16),
  ('drenagem', 'Drenagem e redes enterradas', 'Galerias, bueiros, poços de visita, caixas, sarjetas e redes de esgoto', 'WavesHorizontal', 17),
  ('pavimentacao', 'Pavimentação', 'Base, sub-base, imprimação, asfalto, concreto e intertravado', 'Route', 18),
  ('urbanizacao', 'Paisagismo e urbanização', 'Plantio, cercas, mobiliário urbano, quadras e acessibilidade', 'Trees', 19),
  ('sinalizacao', 'Sinalização viária', 'Sinalização horizontal e vertical e dispositivos de tráfego', 'TrafficCone', 20),
  ('iluminacao-publica', 'Iluminação pública', 'Postes, braços, luminárias e redes de iluminação pública', 'Lamp', 21),
  ('obras-especiais', 'Obras de arte, túneis e ferrovias', 'Pontes, viadutos, túneis e via permanente', 'TrainTrack', 22),
  ('transporte', 'Transporte, carga e descarga', 'Transporte de materiais, carga, descarga e momento de transporte', 'Truck', 23),
  ('equipamentos', 'Equipamentos e locações', 'Locação e operação de equipamentos', 'Forklift', 24),
  ('complementares', 'Serviços complementares e limpeza', 'Limpeza de obra, manutenção e serviços diversos', 'Sparkles', 25),
  ('administracao', 'Administração local e apoio técnico', 'Administração da obra, consultoria e serviços de escritório e campo', 'ClipboardList', 26);

-- SINAPI: pelo grupo da composição.
insert into assunto_regra (prioridade, fonte, assunto_id, classe) values
  (1, 'sinapi', null, '^(Livro SINAPI|Custos Hor|Deprecia|Argamassas$|Produção de Concreto|Graute e Armação$)'),
  (10, 'sinapi', 'climatizacao', 'ar condicionado'),
  (11, 'sinapi', 'incendio-gas', '(Gás|Incêndio|incêndio)'),
  (12, 'sinapi', 'pavimentacao', '(Asfalto|Aterros, Bases|Pavimento|Pavimentações|Recomposição de Pavimentos|Tratamentos Superficiais|Usinagens)'),
  (13, 'sinapi', 'drenagem', '(tubos de esgoto ou drenagem|Poços de Visita|Bocas para Bueiros|Canaletas|Drenos|Drenagem|Dissipadores|Galerias|Caixas Enterradas|Tunnel Liner|Perfuração Horizontal|Guias e sarjetas|Geodrenos|Esgoto em PVC e PEAD)'),
  (14, 'sinapi', 'servicos-preliminares', '(Canteiros|Locação de Obras|Proteção Coletiva|gruas|Mobilização|Supressão Vegetal)'),
  (15, 'sinapi', 'demolicoes', '(Demolições|Remoção de Entulho)'),
  (16, 'sinapi', 'movimento-terra', '(Escavação|Aterro|Escoramento|Esgotamento de Vala|^Lastro|Dragagem|Peneiramento)'),
  (17, 'sinapi', 'alvenaria', '(Alvenaria|Vergas|Drywall|Divisórias)'),
  (18, 'sinapi', 'fundacoes', '(Estacas|Tubulões|Fundações Rasas|Radier|Contenção|Grampo|Tirantes|Gabiões|Concreto Projetado)'),
  (19, 'sinapi', 'estrutura', '(Armação|Concretagem|Fôrmas|Protendido|Lajes|Estruturas Pré|Estruturas de Madeira|Paredes de Concreto|Escadas|Solda de Topo|Reservatórios de Concreto)'),
  (20, 'sinapi', 'cobertura', '(Cobertura|Telhamento)'),
  (21, 'sinapi', 'impermeabilizacao', 'Impermeabiliza'),
  (22, 'sinapi', 'pintura', 'Pintura'),
  (23, 'sinapi', 'pisos', '(^Pisos$|Contrapiso|Passeios de Concreto)'),
  (24, 'sinapi', 'revestimentos', '(Chapisco|Massa Única|Revestimentos Cerâmicos|Gesso|Forros|Monocapa|Fachadas|Pele de Vidro|Peitoris|Brises|Rasgos)'),
  (25, 'sinapi', 'esquadrias', '(Esquadrias|Vidros|Guarda-Corpo)'),
  (26, 'sinapi', 'iluminacao-publica', '(Postes|Luminárias Externas)'),
  (27, 'sinapi', 'eletricas', '(Elétric|Eletrocalhas|Iluminação Predial|Lógica|Descargas|Transformadores|Energia Solar|Quadros de automação)'),
  (28, 'sinapi', 'hidrossanitarias', '(Hidráulic|Água|Esgoto|Pluviais|PEX|PPR|Cobre|Louças|Válvulas|Fossas|Ligações Prediais|Bombas|Sistemas de Medição|Hospitalares|Tubulação Flangeada|PEAD)'),
  (29, 'sinapi', 'urbanizacao', '(Paisagismo|Mobiliário Urbano|Parquinhos|Quadras|Cercas|Acessibilidade)'),
  (30, 'sinapi', 'sinalizacao', '(Sinalização|Dispositivos Auxiliares Viários)'),
  (31, 'sinapi', 'transporte', 'Transporte'),
  (32, 'sinapi', 'complementares', 'Limpeza de Obra');

-- SCO-Rio: pela categoria (as duas letras do código); nas categorias mistas, pela descrição.
insert into assunto_regra (prioridade, fonte, assunto_id, classe, descricao) values
  (10, 'sco', 'eletricas', '^IT', '(el[eé]tric|cabo|disjuntor|eletroduto|tomada|interruptor|quadro de distribui|lumin[aá]ria|l[aâ]mpada|condutor|aterramento|para-raios|telef|l[oó]gica)'),
  (11, 'sco', 'incendio-gas', '^IT', '(inc[eê]ndio|hidrante|sprinkler|chuveiro autom|\mg[aá]s\M|extintor)'),
  (12, 'sco', 'climatizacao', '^IT', '(ar[- ]condicionado|split|exaust|ventila[cç])'),
  (13, 'sco', 'hidrossanitarias', '^IT', null),
  (14, 'sco', 'eletricas', '^AP', '(el[eé]tric|lumin[aá]ria|interruptor|tomada|motor)'),
  (15, 'sco', 'hidrossanitarias', '^AP', null),
  (16, 'sco', 'impermeabilizacao', '^CI', '(impermeabiliz|manta|isolamento|isolante)'),
  (17, 'sco', 'cobertura', '^CI', null),
  (18, 'sco', 'pisos', '^RV', '(\mpisos?\M|rodap[eé]|soleira|contrapiso|cimentado|ladrilho|porcelanato|granilite|assoalho|taco)'),
  (19, 'sco', null, '^RV', '^argamassa'),
  (20, 'sco', 'revestimentos', '^RV', null),
  (30, 'sco', 'administracao', '^(AD|CE|SE)', null),
  (31, 'sco', 'alvenaria', '^AL', null),
  (32, 'sco', 'pavimentacao', '^BP', null),
  (33, 'sco', 'servicos-preliminares', '^CO', null),
  (34, 'sco', 'drenagem', '^DR', null),
  (35, 'sco', 'equipamentos', '^EQ', null),
  (36, 'sco', 'esquadrias', '^ES', null),
  (37, 'sco', 'estrutura', '^ET', null),
  (38, 'sco', 'fundacoes', '^FD', null),
  (39, 'sco', 'iluminacao-publica', '^IP', null),
  (40, 'sco', 'complementares', '^(MP|SC)', null),
  (41, 'sco', 'movimento-terra', '^MT', null),
  (42, 'sco', 'urbanizacao', '^PJ', null),
  (43, 'sco', 'pintura', '^PT', null),
  (44, 'sco', 'sinalizacao', '^ST', null),
  (45, 'sco', 'transporte', '^TC', null);

-- SICRO: o arquivo do DNIT não traz o nome dos grupos; o assunto sai da descrição do serviço.
insert into assunto_regra (prioridade, fonte, assunto_id, descricao) values
  (10, 'sicro', 'transporte', '(^transporte|carga, transporte|carga e descarga|momento de transporte|\mDMT\M)'),
  (11, 'sicro', 'sinalizacao', '(sinaliza|tacha|defensa|faixa de pintura|pintura de faixa|placa de sinal|balizador|delineador)'),
  (12, 'sicro', 'obras-especiais', '(trilho|dormente|ferrovi|\mAMV\M|bitola|via permanente|t[uú]nel|ponte|viaduto|aparelho de apoio|junta de dilata)'),
  (13, 'sicro', 'drenagem', '(bueiro|\mBS[CT]C\M|\mBD[CT]C\M|\mBT[CT]C\M|\mBSCC\M|sarjeta|valeta|dreno|caixa coletora|boca de|descida d|dissipador|meio-fio|meio fio|galeria|po[cç]o de visita|sumidouro)'),
  (14, 'sicro', 'pavimentacao', '(pavimento|asf[aá]lt|imprima|tratamento superficial|sub-base|\mbase\M|pr[eé]-misturado|concreto betuminoso|\mCBUQ\M|fresagem|microrrevestimento|lama asf|reciclagem|usinagem|binder)'),
  (15, 'sicro', 'demolicoes', '(demoli|remo[cç][aã]o)'),
  (16, 'sicro', 'movimento-terra', '(escava|aterro|compacta|terraplen|desmatamento|destocamento|limpeza de camada|\mcorte\M|regulariza)'),
  (17, 'sicro', 'fundacoes', '(estaca|tubul[aã]o|cortina|tirante|grampo|gabi[aã]o|muro|solo grampeado|concreto projetado)'),
  (18, 'sicro', 'urbanizacao', '(plantio|grama|hidrossemeadura|revestimento vegetal|cerca)'),
  (19, 'sicro', 'estrutura', '(concreto|armadura|\mforma|f[oô]rma|a[cç]o CA|cimbramento|escoramento)'),
  (20, 'sicro', 'servicos-preliminares', '(canteiro|mobiliza|instala[cç][aã]o de|placa de obra)');

-- Classifica os serviços de uma base nos assuntos, pelas regras acima.
create function classificar_assuntos(p_fonte text) returns int language plpgsql set search_path = public, pg_temp as $$
declare n int;
begin
  update composicao k
     set assunto_id = (
       select r.assunto_id
         from assunto_regra r
         left join classificacao cl on cl.id = k.classificacao_id
        where r.fonte = p_fonte
          and (r.classe is null or coalesce(cl.codigo || ' ' || cl.nome, k.grupo, '') ~* r.classe)
          and (r.descricao is null or k.descricao ~* r.descricao)
        order by r.prioridade
        limit 1)
   where k.fonte::text = p_fonte and k.orgao_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- SINAPI e demonstração: um nível, o grupo da composição.
insert into classificacao (fonte, nivel, codigo, nome)
select distinct fonte, 1, grupo, grupo from composicao where orgao_id is null and grupo is not null and fonte in ('sinapi', 'demonstracao')
on conflict do nothing;
update composicao k set classificacao_id = cl.id
  from classificacao cl where cl.fonte = k.fonte and cl.nivel = 1 and cl.codigo = k.grupo and k.orgao_id is null;

-- SICRO: o grupo são os dois primeiros dígitos do código (só o número; o DNIT não publica o nome nos arquivos).
insert into classificacao (fonte, nivel, codigo, nome)
select distinct 'sicro'::fonte_preco, 1, left(codigo, 2), 'Grupo ' || left(codigo, 2) from composicao where orgao_id is null and fonte = 'sicro' and codigo ~ '^\d{7}$'
on conflict do nothing;
update composicao k set classificacao_id = cl.id
  from classificacao cl where cl.fonte = 'sicro' and cl.codigo = left(k.codigo, 2) and k.fonte = 'sicro' and k.orgao_id is null and k.codigo ~ '^\d{7}$';

-- Assuntos e regras são públicos e só mudam por migração.
alter table assunto enable row level security; alter table assunto force row level security;
create policy assunto_leitura on assunto for select using (true);
alter table assunto_regra enable row level security; alter table assunto_regra force row level security;
create policy assunto_regra_leitura on assunto_regra for select using (true);

select classificar_assuntos('sinapi');
select classificar_assuntos('sicro');

-- 4. Orçamento com mais de uma base: a base principal (tabela_id) e outras do mesmo período.
alter table orcamento
  add column tabelas_extras uuid[] not null default '{}',
  add column modo_montagem text check (modo_montagem in ('assunto', 'livre'));

-- Cada item guarda a sua base e data-base e o assunto em que foi escolhido.
alter table orcamento_item
  add column tabela_id uuid references tabela_preco(id),
  add column assunto_id text references assunto(id),
  add column classificacao text;

-- Cada linha congelada guarda a fonte e a composição auxiliar de onde veio (primeiro nível).
alter table orcamento_item_insumo
  add column fonte fonte_preco,
  add column ordem int,
  add column auxiliar_codigo text,
  add column auxiliar_descricao text,
  add column auxiliar_unidade text,
  add column auxiliar_coeficiente numeric(18,7);

-- Insumos de uma composição com a composição auxiliar de primeiro nível por onde entram.
create function insumos_por_auxiliar(p_comp uuid, p_mes date)
returns table (insumo_id uuid, coeficiente numeric, auxiliar_id uuid, auxiliar_coeficiente numeric, ordem int)
language sql stable set search_path = public, pg_temp as $$
  with recursive arvore (composicao_id, coef, nivel, aux, aux_coef, ord) as (
    select p_comp, 1::numeric, 0, null::uuid, null::numeric, 0
    union all
    select ci.subcomposicao_id, a.coef * ci.coeficiente, a.nivel + 1,
           coalesce(a.aux, ci.subcomposicao_id), coalesce(a.aux_coef, ci.coeficiente),
           case when a.nivel = 0 then ci.id::int else a.ord end
      from arvore a
      join composicao_item ci on ci.composicao_id = a.composicao_id and ci.subcomposicao_id is not null
       and ci.mes is not distinct from mes_da_estrutura(a.composicao_id, p_mes)
     where a.nivel < 12
  )
  select ci.insumo_id, sum(a.coef * ci.coeficiente), a.aux, max(a.aux_coef), min(case when a.nivel = 0 then ci.id::int else a.ord end)
    from arvore a
    join composicao_item ci on ci.composicao_id = a.composicao_id and ci.insumo_id is not null
     and ci.mes is not distinct from mes_da_estrutura(a.composicao_id, p_mes)
   group by ci.insumo_id, a.aux
$$;
