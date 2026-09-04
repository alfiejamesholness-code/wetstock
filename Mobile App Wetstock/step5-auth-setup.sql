-- Step 5: real logins. Safe to run more than once.

alter table products enable row level security;
alter table profiles enable row level security;

drop policy if exists "logged in users can read products" on products;
create policy "logged in users can read products" on products
  for select using (auth.uid() is not null);

drop policy if exists "managers can insert products" on products;
create policy "managers can insert products" on products
  for insert with check (
    exists (select 1 from profiles where id = auth.uid() and role = 'manager')
  );

drop policy if exists "managers can update products" on products;
create policy "managers can update products" on products
  for update using (
    exists (select 1 from profiles where id = auth.uid() and role = 'manager')
  );

drop policy if exists "managers can delete products" on products;
create policy "managers can delete products" on products
  for delete using (
    exists (select 1 from profiles where id = auth.uid() and role = 'manager')
  );

drop policy if exists "users can read their own profile" on profiles;
create policy "users can read their own profile" on profiles
  for select using (id = auth.uid());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data ->> 'full_name', 'staff')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------
-- After creating logins in Authentication -> Users, run this to
-- promote them from the default 'staff' to 'manager':
--
-- update profiles set role = 'manager'
-- where id in (
--   select id from auth.users
--   where email in ('you@example.com', 'colleague@example.com')
-- );
-- ---------------------------------------------------------------
