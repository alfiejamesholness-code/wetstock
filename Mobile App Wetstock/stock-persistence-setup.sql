-- Step 6 (simplified): make stock quantities actually persist.
-- Stock is stored as JSON on the product itself, keyed by site id
-- (e.g. {"lc": 12, "kc": 3}) — simpler than a separate table, and
-- enough for what the app needs right now. Safe to run more than once.

alter table products add column if not exists stock jsonb not null default '{}'::jsonb;

-- Adjust stock by a delta (e.g. -4 when loading out, +4 when returning).
-- Any logged-in user (manager or staff) can call this — it only ever
-- touches the stock field, nothing else on the product.
create or replace function public.update_stock(p_product_id uuid, p_site_id text, p_delta integer)
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
  set stock = jsonb_set(
    coalesce(stock, '{}'::jsonb),
    array[p_site_id],
    to_jsonb(greatest(0, coalesce((stock->>p_site_id)::int, 0) + p_delta))
  )
  where id = p_product_id;
end;
$$;

grant execute on function public.update_stock(uuid, text, integer) to authenticated;

-- Set stock to an exact number (used by Recount, which is authoritative).
create or replace function public.set_stock(p_product_id uuid, p_site_id text, p_quantity integer)
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
  set stock = jsonb_set(coalesce(stock, '{}'::jsonb), array[p_site_id], to_jsonb(greatest(0, p_quantity)))
  where id = p_product_id;
end;
$$;

grant execute on function public.set_stock(uuid, text, integer) to authenticated;
