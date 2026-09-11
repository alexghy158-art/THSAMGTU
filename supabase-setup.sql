-- ============================================================
-- Твой Ход СамГТУ — полная настройка базы (выполнить в SQL Editor)
-- ============================================================

-- 1. Профили пользователей
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text default 'участник', -- участник | координатор
  last_seen timestamptz default now(),
  created_at timestamptz default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select using (true);

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles for update using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles for insert with check (auth.uid() = id);

-- 2. Контент / задачи / идеи (единая таблица)
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('post', 'story', 'idea', 'task')),
  date date,
  day text,
  title text not null,
  format text,
  status text not null default 'Запланировано',
  notes text,
  text_ready text,
  author text default '',
  author_id uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table content_items enable row level security;

drop policy if exists "content_all" on content_items;
create policy "content_all" on content_items for all using (true) with check (true);

create index if not exists idx_content_kind on content_items(kind);
create index if not exists idx_content_status on content_items(status);
create index if not exists idx_content_date on content_items(date);

-- 3. Лента активности
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  user_name text,
  action text not null,
  details text,
  created_at timestamptz default now()
);

alter table activity_log enable row level security;

drop policy if exists "activity_all" on activity_log;
create policy "activity_all" on activity_log for all using (true) with check (true);

-- Автосоздание профиля при регистрации
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'участник'
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
