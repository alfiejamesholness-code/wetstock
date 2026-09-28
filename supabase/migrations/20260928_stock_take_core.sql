-- Stage (a): Stock Take core schema.
--
-- Additive only. Does not alter, drop, or write to any existing table -
-- products.stock / products.unsplit_stock are only ever touched by the
-- existing update_stock / update_unsplit_stock / set_stock RPCs, called
-- from application code once a stock take is confirmed. Nothing here
-- runs against live data by itself.
--
-- NOT included yet (later stages, per the agreed build order):
--   - crates / crate_colors (stage b)
--   - stock_adjustments, the structured "stocktake_adjustment" movement
--     rows, and the pre-confirm summary/comparison screen (stage c)

create table public.stock_takes (
  id uuid primary key default gen_random_uuid(),
  -- 'lc' | 'kc' | 'pw' today - matches products.stock's keys and
  -- sessions.venue, kept as free text rather than a fixed list since new
  -- sites can be added from the More screen.
  location text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'confirmed', 'abandoned')),
  started_at timestamptz not null default now(),
  started_by uuid,
  confirmed_at timestamptz,
  confirmed_by uuid
);

-- Only one open stock take per location at a time - the database half of
-- "lock the location while a take is in progress". The app additionally
-- blocks starting a new session load-out/return against a locked location.
create unique index stock_takes_one_open_per_location
  on public.stock_takes (location) where (status = 'in_progress');

-- Non-crate counting progress for one stock take. Cases + units mirrors
-- products.unsplit_stock / stock as they work today - kept as two
-- numbers, not collapsed into one - per your answer to keep cases visible
-- as their own pool. Upserted continuously as you count (one row per
-- product per take), so a dropped connection or closed tab loses nothing;
-- reopening the take just reads these rows back.
create table public.stock_take_lines (
  id uuid primary key default gen_random_uuid(),
  stock_take_id uuid not null references public.stock_takes(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  case_qty numeric not null default 0,
  unit_qty numeric not null default 0,
  -- Distinguishes "counted, and it's 0" from "haven't looked at this yet" -
  -- needed for the uncounted-items warning before confirming.
  counted boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (stock_take_id, product_id)
);

-- Snapshot of a product's stock at a location taken immediately before a
-- confirmed stock take replaces it. Never updated or deleted afterwards -
-- this is the permanent, readable archive the data-safety rules require,
-- so "replace on confirm" never actually destroys anything.
create table public.stock_archives (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  stock_take_id uuid not null references public.stock_takes(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  prior_case_qty numeric not null default 0,
  prior_unit_qty numeric not null default 0,
  archived_at timestamptz not null default now()
);

alter table public.stock_takes enable row level security;
alter table public.stock_take_lines enable row level security;
alter table public.stock_archives enable row level security;

-- Same "any signed-in user" style as sessions/events - stock takes are
-- run on the floor by whoever's counting, not manager-only.
create policy "logged in users can read stock_takes" on public.stock_takes for select using (auth.uid() is not null);
create policy "logged in users can insert stock_takes" on public.stock_takes for insert with check (auth.uid() is not null);
create policy "logged in users can update stock_takes" on public.stock_takes for update using (auth.uid() is not null);

create policy "logged in users can read stock_take_lines" on public.stock_take_lines for select using (auth.uid() is not null);
create policy "logged in users can insert stock_take_lines" on public.stock_take_lines for insert with check (auth.uid() is not null);
create policy "logged in users can update stock_take_lines" on public.stock_take_lines for update using (auth.uid() is not null);
create policy "logged in users can delete stock_take_lines" on public.stock_take_lines for delete using (auth.uid() is not null);

-- Archive rows are write-once, read-many - no update/delete policy, so
-- once written nothing (short of a manual DB console session) can alter
-- what a stock take is recorded as having replaced.
create policy "logged in users can read stock_archives" on public.stock_archives for select using (auth.uid() is not null);
create policy "logged in users can insert stock_archives" on public.stock_archives for insert with check (auth.uid() is not null);
