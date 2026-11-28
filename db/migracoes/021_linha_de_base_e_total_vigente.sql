-- Linha de base do cronograma por contrato (antes era uma por obra, o que impedia
-- dois contratos da mesma obra de terem cada um a sua). A linha de base passa a ser
-- gravada na assinatura do contrato e uma nova versão é aberta a cada aditivo assinado.
drop index if exists cronograma_uma_linha_base;
create unique index cronograma_uma_linha_base on cronograma (contrato_id) where situacao = 'linha_base';

-- Total vigente do item com a mesma regra do orçamento (arredondar ou truncar), para que a soma
-- dos itens seja igual ao valor do contrato e à planilha impressa.
create or replace function total_vigente(item uuid) returns numeric language sql stable set search_path = public, pg_temp as $$
  select case when q = i.quantidade then i.total
              when o.arredondamento = 'truncar' then trunc(q * i.preco_unitario, 2)
              else round(q * i.preco_unitario, 2) end
    from item_servico i
    join contrato k on k.id = i.contrato_id
    join orcamento o on o.id = k.orcamento_id,
    lateral (select quantidade_vigente(i.id) as q) v
   where i.id = item
$$;

-- Base de demonstração só para contas de teste. Os órgãos reais não a veem mais.
alter table orgao add column if not exists demonstracao boolean not null default false;
comment on column orgao.demonstracao is 'Conta de teste: vê a base de preços de demonstração.';
update orgao set demonstracao = true where nome in ('Prefeitura Teste CiviObras', 'Empresa de Teste');

create or replace function orgao_ve_demonstracao() returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce((select demonstracao from orgao where id = ctx_orgao()), false)
$$;

drop policy if exists tabela_preco_leitura on tabela_preco;
create policy tabela_preco_leitura on tabela_preco for select
  using ((orgao_id is null and (fonte <> 'demonstracao' or orgao_ve_demonstracao())) or orgao_id = ctx_orgao());
