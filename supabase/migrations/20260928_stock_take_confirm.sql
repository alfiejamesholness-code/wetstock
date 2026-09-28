-- Confirms a stock take in one atomic transaction:
--   1. Archives every carried-at-this-location product's CURRENT stock
--      (case + unit) into stock_archives, before anything is overwritten.
--      This runs for every relevant product, not just counted ones, since
--      an uncounted product is about to be zeroed below and its prior
--      number must stay recoverable.
--   2. Replaces stock for every product carried at this location: a
--      counted product gets exactly what was counted; anything never
--      counted is recorded as 0 - a stock take is a clean-sheet,
--      definitive count, confirmed by you on 2026-09-28.
--   3. Marks the stock take confirmed.
-- Single round trip, single transaction - no partial-write risk if the
-- connection drops halfway through 144 products.
create or replace function public.confirm_stock_take(p_stock_take_id uuid, p_confirmed_by uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location text;
  v_status text;
begin
  select location, status into v_location, v_status from stock_takes where id = p_stock_take_id;
  if v_location is null then
    raise exception 'Stock take not found';
  end if;
  if v_status <> 'in_progress' then
    raise exception 'Stock take is not in progress';
  end if;

  insert into stock_archives (location, stock_take_id, product_id, prior_case_qty, prior_unit_qty)
  select v_location, p_stock_take_id, p.id,
         coalesce((p.unsplit_stock->>v_location)::numeric, 0),
         coalesce((p.stock->>v_location)::numeric, 0)
  from products p
  where p.sites is null or jsonb_array_length(p.sites) = 0 or p.sites @> to_jsonb(v_location);

  update products p
  set stock = jsonb_set(
        coalesce(p.stock, '{}'::jsonb), array[v_location],
        to_jsonb(coalesce((
          select l.unit_qty from stock_take_lines l
          where l.stock_take_id = p_stock_take_id and l.product_id = p.id and l.counted
        ), 0))
      ),
      unsplit_stock = jsonb_set(
        coalesce(p.unsplit_stock, '{}'::jsonb), array[v_location],
        to_jsonb(coalesce((
          select l.case_qty from stock_take_lines l
          where l.stock_take_id = p_stock_take_id and l.product_id = p.id and l.counted
        ), 0))
      )
  where p.sites is null or jsonb_array_length(p.sites) = 0 or p.sites @> to_jsonb(v_location);

  update stock_takes set status = 'confirmed', confirmed_at = now(), confirmed_by = p_confirmed_by
  where id = p_stock_take_id;
end;
$$;

grant execute on function public.confirm_stock_take(uuid, uuid) to authenticated;
