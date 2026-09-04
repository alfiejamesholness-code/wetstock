-- Activity log: who did what. Managers only, both to read and write.
-- Safe to run more than once — extends the table if it already exists.

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id),
  actor_label text not null,
  action text not null,
  detail text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table activity_log add column if not exists metadata jsonb;

alter table activity_log enable row level security;

drop policy if exists "managers can read activity" on activity_log;
create policy "managers can read activity" on activity_log
  for select using (
    exists (select 1 from profiles where id = auth.uid() and role = 'manager')
  );

drop policy if exists "managers can write activity" on activity_log;
create policy "managers can write activity" on activity_log
  for insert with check (
    exists (select 1 from profiles where id = auth.uid() and role = 'manager')
  );
