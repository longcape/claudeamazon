-- =========================================================
-- VALORANT TACTICAL SETUP CARD — database schema
-- Supabase の SQL Editor にそのまま貼り付けて実行する。
-- 何度実行しても同じ状態になるよう冪等に書いてある。
-- =========================================================

-- ---------------------------------------------------------
-- 1. 投稿された戦術
-- ---------------------------------------------------------
create table if not exists public.tactic_posts (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- ログインして投稿した場合のみ埋まる。匿名投稿では null のまま。
  user_id        uuid default auth.uid() references auth.users (id) on delete set null,

  name           text not null check (char_length(name) between 1 and 60),
  map            text not null check (char_length(map) <= 24),
  side           text not null check (side in ('ATK', 'DEF', 'BOTH')),
  site           text not null default '-' check (char_length(site) <= 8),
  kind           text not null default 'execute' check (char_length(kind) <= 16),
  note           text not null default '' check (char_length(note) <= 600),

  author_name    text not null default 'ANONYMOUS' check (char_length(author_name) between 1 and 24),
  lang           text not null default 'ja' check (char_length(lang) <= 8),

  ally_comp      text[] not null default '{}' check (array_length(ally_comp, 1) is null or array_length(ally_comp, 1) <= 5),
  enemy_comp     text[] not null default '{}' check (array_length(enemy_comp, 1) is null or array_length(enemy_comp, 1) <= 5),

  analysis_score int check (analysis_score is null or analysis_score between 0 and 100),
  ai_review      text check (ai_review is null or char_length(ai_review) <= 1200),

  likes          int not null default 0,
  reports        int not null default 0,
  hidden         boolean not null default false,

  -- 匿名投稿のレート制限にのみ使う。生の IP は保存せずハッシュのみ。
  ip_hash        text
);

create index if not exists tactic_posts_created_idx on public.tactic_posts (created_at desc);
create index if not exists tactic_posts_likes_idx   on public.tactic_posts (likes desc, created_at desc);
create index if not exists tactic_posts_map_idx     on public.tactic_posts (map);
create index if not exists tactic_posts_user_idx    on public.tactic_posts (user_id);

-- ---------------------------------------------------------
-- 2. いいね（1 投稿につき 1 投票者 1 回まで）
-- ---------------------------------------------------------
create table if not exists public.tactic_likes (
  post_id    uuid not null references public.tactic_posts (id) on delete cascade,
  voter      text not null check (char_length(voter) <= 64),
  created_at timestamptz not null default now(),
  primary key (post_id, voter)
);

-- ---------------------------------------------------------
-- 3. 保存したセットアップ（ログイン必須）
-- ---------------------------------------------------------
create table if not exists public.saved_setups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_setups_user_idx on public.saved_setups (user_id, updated_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists saved_setups_touch on public.saved_setups;
create trigger saved_setups_touch
  before update on public.saved_setups
  for each row execute function public.touch_updated_at();

-- =========================================================
-- レート制限 — 匿名投稿の連投を防ぐ
-- 同一 IP から 1 時間あたり 10 件までに制限する。
-- =========================================================
create or replace function public.enforce_post_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip    text;
  v_count int;
begin
  v_ip := coalesce(
    split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1),
    'unknown'
  );
  new.ip_hash := encode(digest(v_ip, 'sha256'), 'hex');

  select count(*) into v_count
    from public.tactic_posts
   where ip_hash = new.ip_hash
     and created_at > now() - interval '1 hour';

  if v_count >= 10 then
    raise exception 'RATE_LIMIT: too many posts from this address, try again later'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- digest() を使うため pgcrypto を有効化する
create extension if not exists pgcrypto with schema extensions;

drop trigger if exists tactic_posts_rate_limit on public.tactic_posts;
create trigger tactic_posts_rate_limit
  before insert on public.tactic_posts
  for each row execute function public.enforce_post_rate_limit();

-- =========================================================
-- いいね用 RPC
-- 重複投票は無視し、実際に入った場合だけカウントを増やす。
-- =========================================================
create or replace function public.like_post(p_post_id uuid, p_voter text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int;
  v_likes    int;
begin
  insert into public.tactic_likes (post_id, voter)
  values (p_post_id, p_voter)
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    update public.tactic_posts
       set likes = likes + 1
     where id = p_post_id
     returning likes into v_likes;
  else
    select likes into v_likes from public.tactic_posts where id = p_post_id;
  end if;

  return coalesce(v_likes, 0);
end;
$$;

grant execute on function public.like_post(uuid, text) to anon, authenticated;

-- =========================================================
-- 通報用 RPC（荒らし対策）
-- 一定数を超えた投稿は自動的に非表示にする。
-- =========================================================
create or replace function public.report_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tactic_posts
     set reports = reports + 1,
         hidden  = (reports + 1) >= 5
   where id = p_post_id;
end;
$$;

grant execute on function public.report_post(uuid) to anon, authenticated;

-- =========================================================
-- RLS — 行レベルセキュリティ
-- anon key はブラウザに露出する前提なので、
-- 実際のアクセス制御はすべてここで行う。
-- =========================================================
alter table public.tactic_posts enable row level security;
alter table public.tactic_likes enable row level security;
alter table public.saved_setups enable row level security;

-- --- 投稿: 非表示でないものは誰でも読める ---
drop policy if exists tactic_posts_read on public.tactic_posts;
create policy tactic_posts_read
  on public.tactic_posts for select
  to anon, authenticated
  using (hidden = false);

-- --- 投稿: 誰でも投稿できる。ログイン時は自分の user_id しか入れられない ---
drop policy if exists tactic_posts_insert on public.tactic_posts;
create policy tactic_posts_insert
  on public.tactic_posts for insert
  to anon, authenticated
  with check (
    user_id is not distinct from auth.uid()
    and likes = 0
    and reports = 0
    and hidden = false
  );

-- --- 投稿: 編集・削除は本人のみ（匿名投稿は編集不可） ---
drop policy if exists tactic_posts_update on public.tactic_posts;
create policy tactic_posts_update
  on public.tactic_posts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists tactic_posts_delete on public.tactic_posts;
create policy tactic_posts_delete
  on public.tactic_posts for delete
  to authenticated
  using (user_id = auth.uid());

-- --- いいね: 直接の読み書きは禁止し、RPC 経由のみとする ---
drop policy if exists tactic_likes_none on public.tactic_likes;
create policy tactic_likes_none
  on public.tactic_likes for select
  to authenticated
  using (false);

-- --- 保存したセットアップ: 本人のみ全操作可能 ---
drop policy if exists saved_setups_all on public.saved_setups;
create policy saved_setups_all
  on public.saved_setups for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =========================================================
-- AI 寸評の利用記録（Edge Function から service role でのみ書き込む）
-- RLS を有効にしてポリシーを作らないことで、
-- anon / authenticated からは一切触れない状態にする。
-- =========================================================
create table if not exists public.ai_usage (
  id         bigserial primary key,
  actor      text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_actor_idx on public.ai_usage (actor, created_at desc);

alter table public.ai_usage enable row level security;
