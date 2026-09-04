-- Adds case-based ("unsplit") stock alongside the existing individual-unit
-- ("split") stock. A product bought as a case of 24 sits in unsplit_stock
-- as whole cases until someone opens one — that conversion isn't wired up
-- yet, this just gives it somewhere to live. Safe to run more than once.

alter table products add column if not exists case_size integer;
alter table products add column if not exists unsplit_stock jsonb not null default '{}'::jsonb;

create or replace function public.update_unsplit_stock(p_product_id uuid, p_site_id text, p_delta integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  update products
  set unsplit_stock = jsonb_set(
    coalesce(unsplit_stock, '{}'::jsonb),
    array[p_site_id],
    to_jsonb(greatest(0, coalesce((unsplit_stock->>p_site_id)::int, 0) + p_delta))
  )
  where id = p_product_id;
end;
$$;

grant execute on function public.update_unsplit_stock(uuid, text, integer) to authenticated;

create or replace function public.set_unsplit_stock(p_product_id uuid, p_site_id text, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  update products
  set unsplit_stock = jsonb_set(coalesce(unsplit_stock, '{}'::jsonb), array[p_site_id], to_jsonb(greatest(0, p_quantity)))
  where id = p_product_id;
end;
$$;

grant execute on function public.set_unsplit_stock(uuid, text, integer) to authenticated;
