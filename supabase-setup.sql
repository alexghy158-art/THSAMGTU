-- ============================================================
-- Твой Ход СамГТУ — настройка базы (выполнить в SQL Editor)
-- ============================================================

-- 1. Участники (ник + пароль, БЕЗ email / Supabase Auth)
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  nickname text unique not null,
  password_hash text not null,
  display_name text not null,
  role text default 'участник',
  last_seen timestamptz default now(),
  created_at timestamptz default now()
);

alter table members enable row level security;
drop policy if exists "members_all" on members;
create policy "members_all" on members for all using (true) with check (true);

create index if not exists idx_members_nickname on members(nickname);

-- 2. Контент / задачи / идеи
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
  author_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table content_items enable row level security;
drop policy if exists "content_all" on content_items;
create policy "content_all" on content_items for all using (true) with check (true);

alter table content_items add column if not exists author text default '';
alter table content_items add column if not exists author_id uuid;
alter table content_items add column if not exists text_ready text;

create index if not exists idx_content_kind on content_items(kind);
create index if not exists idx_content_status on content_items(status);
create index if not exists idx_content_date on content_items(date);

-- 3. Лента активности
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  user_name text,
  action text not null,
  details text,
  created_at timestamptz default now()
);

alter table activity_log enable row level security;
drop policy if exists "activity_all" on activity_log;
create policy "activity_all" on activity_log for all using (true) with check (true);
