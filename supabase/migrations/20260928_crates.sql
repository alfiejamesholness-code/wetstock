-- Stage (b): Crates.
--
-- Additive only - doesn't touch products, stock_takes, or anything else
-- that already has data in it. A crate holds individual units (never
-- cases) of one product, at one location, and lives independently of any
-- single stock take - it's created/edited/recounted live as you go, and
-- stays there afterwards until it's next changed.

create table public.crate_colors (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  swatch text not null default '#9184d9', -- hex, shown as a visible swatch next to the label
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table public.crates (
  id uuid primary key default gen_random_uuid(),
  location text not null,
  tag text not null,
  color_id uuid references public.crate_colors(id) on delete set null,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric not null default 0,
  -- Which stock take (if any) this crate was created during - purely
  -- informational, the crate itself outlives that take.
  stock_take_id uuid references public.stock_takes(id) on delete set null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Duplicate tags at the same location are rejected at the database level,
-- not just in the UI. Archived crates don't count, so an old tag can be
-- reused once its crate is gone.
create unique index crates_unique_tag_per_location
  on public.crates (location, tag) where (archived = false);

alter table public.crate_colors enable row level security;
alter table public.crates enable row level security;

create policy "logged in users can read crate_colors" on public.crate_colors for select using (auth.uid() is not null);
create policy "logged in users can insert crate_colors" on public.crate_colors for insert with check (auth.uid() is not null);
create policy "logged in users can update crate_colors" on public.crate_colors for update using (auth.uid() is not null);

create policy "logged in users can read crates" on public.crates for select using (auth.uid() is not null);
create policy "logged in users can insert crates" on public.crates for insert with check (auth.uid() is not null);
create policy "logged in users can update crates" on public.crates for update using (auth.uid() is not null);
create policy "logged in users can delete crates" on public.crates for delete using (auth.uid() is not null);
