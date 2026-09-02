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

-- モデレーション状態。
--   auto     … 通報が集まれば自動で隠れてよい（既定）
--   restored … 運営が復旧した。以後は通報が集まっても自動では隠さない
--   forced   … 運営が隠した
-- 既存のテーブルにも足せるように alter で書く。
alter table public.tactic_posts
  add column if not exists moderation text not null default 'auto';
alter table public.tactic_posts drop constraint if exists tactic_posts_moderation_check;
alter table public.tactic_posts
  add constraint tactic_posts_moderation_check check (moderation in ('auto', 'restored', 'forced'));

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
-- 3. 通報（1 投稿につき 1 通報者 1 回まで）
--    いいねと同じ形。これが無いと 1 人が 5 回叩くだけで
--    どの投稿でも hidden にできてしまう。
-- ---------------------------------------------------------
create table if not exists public.tactic_reports (
  post_id    uuid not null references public.tactic_posts (id) on delete cascade,
  reporter   text not null check (char_length(reporter) <= 64),
  created_at timestamptz not null default now(),
  primary key (post_id, reporter)
);

-- 通報の理由と、その他を選んだときの短い補足。
-- 既存のテーブルにも足せるように alter で書く。
alter table public.tactic_reports add column if not exists reason text not null default 'other';
alter table public.tactic_reports drop constraint if exists tactic_reports_reason_check;
alter table public.tactic_reports add constraint tactic_reports_reason_check
  check (reason in ('spam', 'abuse', 'misleading', 'offtopic', 'other'));

alter table public.tactic_reports add column if not exists detail text not null default '';
alter table public.tactic_reports drop constraint if exists tactic_reports_detail_check;
alter table public.tactic_reports add constraint tactic_reports_detail_check
  check (char_length(detail) <= 200);

-- ---------------------------------------------------------
-- 4. 運営者
--    ポリシーを 1 つも作らないので、anon / authenticated からは
--    読むことも書くこともできない。追加と削除は Supabase の
--    SQL Editor（= service role）からのみ行う。
--    service role のキーはブラウザには置かない。
-- ---------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text not null default '',
  created_at timestamptz not null default now()
);

-- 運営者を足すとき（Supabase の SQL Editor で実行する）:
--   insert into public.admins (user_id, note)
--   select id, 'なぜ運営者なのか' from auth.users where email = 'you@example.com'
--   on conflict (user_id) do nothing;

-- ---------------------------------------------------------
-- 5. コミュニティの設定値
--    通報のしきい値をコードにベタ書きせず、ここで一元管理する。
--    読むのは誰でもよい（秘密ではない）。書けるのは運営者の RPC だけ。
-- ---------------------------------------------------------
create table if not exists public.community_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- 初期値は現行どおり 5。すでに値があるときは上書きしない（何度流しても同じ）。
insert into public.community_config (key, value)
values ('report_threshold', '5'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------
-- 6. モデレーションの監査ログ
--    運営操作の記録。読めるのは運営者だけ、書けるのは RPC だけ。
--    投稿や運営者が消えても記録は残したいので、外部キーは
--    on delete set null にしてある。
-- ---------------------------------------------------------
create table if not exists public.moderation_log (
  id             bigserial primary key,
  action         text not null,
  post_id        uuid references public.tactic_posts (id) on delete set null,
  admin_user_id  uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  old_value      jsonb,
  new_value      jsonb,
  moderator_note text not null default ''
);

alter table public.moderation_log drop constraint if exists moderation_log_action_check;
alter table public.moderation_log add constraint moderation_log_action_check
  check (action in ('restore', 'force_hide', 'set_threshold'));
alter table public.moderation_log drop constraint if exists moderation_log_note_check;
alter table public.moderation_log add constraint moderation_log_note_check
  check (char_length(moderator_note) <= 300);

create index if not exists moderation_log_created_idx on public.moderation_log (created_at desc);

-- ---------------------------------------------------------
-- 7. 保存したセットアップ（ログイン必須）
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
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- トリガからしか呼ばれない。REST の /rpc/ 経由で外から叩ける状態にしない。
-- 既定では PUBLIC に EXECUTE が付くので、そちらも落とす
-- （anon と authenticated は PUBLIC のメンバーなので、PUBLIC を残すと revoke が効かない）。
-- トリガの実行時に EXECUTE 権限は再チェックされないため、これで動作は変わらない。
revoke all on function public.touch_updated_at() from public;
revoke all on function public.touch_updated_at() from anon, authenticated;

drop trigger if exists saved_setups_touch on public.saved_setups;
create trigger saved_setups_touch
  before update on public.saved_setups
  for each row execute function public.touch_updated_at();

-- =========================================================
-- レート制限 — 匿名投稿の連投を防ぐ
-- 同一 IP から 1 時間あたり 10 件までに制限する。
-- =========================================================

-- digest() を使うため pgcrypto を有効化する。
-- 関数より先に置くこと（後述の search_path が extensions を指す前提になる）。
create extension if not exists pgcrypto with schema extensions;

create or replace function public.enforce_post_rate_limit()
returns trigger
language plpgsql
security definer
-- pgcrypto は extensions スキーマに入る。search_path を public だけに絞ると
-- digest() が見つからず、tactic_posts への insert が必ず失敗する。
-- （実際にこれで匿名投稿が丸ごと通らない状態になっていた）
set search_path = public, extensions
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

-- トリガからしか呼ばれない。REST の /rpc/ 経由で外から叩ける状態にしない。
-- PUBLIC の EXECUTE も落とす（残すと anon / authenticated への revoke が効かない）。
revoke all on function public.enforce_post_rate_limit() from public;
revoke all on function public.enforce_post_rate_limit() from anon, authenticated;

drop trigger if exists tactic_posts_rate_limit on public.tactic_posts;
create trigger tactic_posts_rate_limit
  before insert on public.tactic_posts
  for each row execute function public.enforce_post_rate_limit();

-- =========================================================
-- 運営者かどうか
-- 名簿そのものは見せず、「自分が運営者か」だけを返す。
-- RLS のポリシーからも呼ぶので authenticated に execute を渡す。
-- =========================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
-- Supabase は public スキーマの関数を既定で anon にも grant する。
-- 運営まわりは未ログインから呼べる必要がないので明示的に落とす。
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

-- =========================================================
-- 通報のしきい値
-- 設定が無い場合だけ 5 を使う。RPC はこの値を参照する。
-- =========================================================
create or replace function public.report_threshold()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (value #>> '{}')::int from public.community_config where key = 'report_threshold'),
    5
  );
$$;

revoke all on function public.report_threshold() from public;
grant execute on function public.report_threshold() to anon, authenticated;

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

-- いいねは未ログインでも押せる仕様なので、ここは意図して公開している。
-- Supabase の advisor が「anon から SECURITY DEFINER を呼べる」と警告するが、
-- 直接の読み書きを RLS で塞いだうえで、この RPC だけを入口にしているため意図どおり。
grant execute on function public.like_post(uuid, text) to anon, authenticated;

-- =========================================================
-- 通報用 RPC（荒らし対策）
-- 5 件そろった投稿は自動的に非表示にする。
-- 同じ通報者の 2 回目以降は数えない（tactic_reports の主キーで弾く）。
-- 戻り値の counted で「今回数えたか」が分かるので、
-- 画面側は「通報しました」と「すでに通報済みです」を出し分けられる。
-- =========================================================

-- 通報者を取らない旧版が残っていると呼び出しが曖昧になるので先に消す
drop function if exists public.report_post(uuid);

-- 理由を足したので引数が増えた。旧版が残ると呼び出しが曖昧になるので先に消す。
drop function if exists public.report_post(uuid, text);

create or replace function public.report_post(
  p_post_id  uuid,
  p_reporter text,
  p_reason   text default 'other',
  p_detail   text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted  int;
  v_threshold int := public.report_threshold();
  v_reason    text := coalesce(nullif(p_reason, ''), 'other');
  v_reports   int;
  v_hidden    boolean;
begin
  /* 知らない理由が来ても落とさず other にまとめる。
     画面の選択肢が増減しても DB 側で弾かれないようにするため。 */
  if v_reason not in ('spam', 'abuse', 'misleading', 'offtopic', 'other') then
    v_reason := 'other';
  end if;

  insert into public.tactic_reports (post_id, reporter, reason, detail)
  values (p_post_id, p_reporter, v_reason, left(coalesce(p_detail, ''), 200))
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    /* 運営が復旧した投稿（restored）は、通報が積み上がっても自動では隠さない。
       ここを (reports + 1) >= v_threshold だけにすると、
       復旧した直後に 1 件通報が来ただけでまた隠れてしまう。 */
    update public.tactic_posts
       set reports = reports + 1,
           hidden  = case when moderation = 'auto'
                          then (reports + 1) >= v_threshold
                          else hidden
                     end
     where id = p_post_id
     returning reports, hidden into v_reports, v_hidden;
  else
    select reports, hidden into v_reports, v_hidden
      from public.tactic_posts where id = p_post_id;
  end if;

  return jsonb_build_object(
    'counted',   v_inserted > 0,
    'reports',   coalesce(v_reports, 0),
    'hidden',    coalesce(v_hidden, false),
    'threshold', v_threshold
  );
end;
$$;

-- 通報も未ログインで押せる仕様なので、いいねと同じく意図して公開している。
grant execute on function public.report_post(uuid, text, text, text) to anon, authenticated;

-- =========================================================
-- 投稿ごとの通報の内訳（運営者のみ）
-- 通報者そのものは運営者にも見せない。理由と補足だけを返す。
-- =========================================================
create or replace function public.admin_report_breakdown(p_post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN' using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'post_id', p_post_id,
    'total', (select count(*) from public.tactic_reports where post_id = p_post_id),
    'by_reason', coalesce((
      select jsonb_object_agg(reason, n)
      from (select reason, count(*) as n from public.tactic_reports
             where post_id = p_post_id group by reason) x
    ), '{}'::jsonb),
    'details', coalesce((
      select jsonb_agg(jsonb_build_object('reason', reason, 'detail', detail, 'created_at', created_at)
                       order by created_at desc)
      from public.tactic_reports
      where post_id = p_post_id and detail <> ''
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.admin_report_breakdown(uuid) from public;
revoke all on function public.admin_report_breakdown(uuid) from anon;
grant execute on function public.admin_report_breakdown(uuid) to authenticated;

-- =========================================================
-- 運営操作
-- 画面に出す・出さないは当てにせず、必ずここで is_admin() を見る。
-- =========================================================
-- 運営メモを足したので引数が増えた。旧版は先に消す。
drop function if exists public.admin_set_hidden(uuid, boolean);

create or replace function public.admin_set_hidden(
  p_post_id uuid,
  p_hidden  boolean,
  p_note    text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     public.tactic_posts;
  v_id      uuid;
  v_hidden  boolean;
  v_reports int;
  v_mod     text;
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN' using errcode = 'insufficient_privilege';
  end if;

  select * into v_old from public.tactic_posts where id = p_post_id;
  if v_old.id is null then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;

  /* 復旧なら restored、運営が隠したなら forced。
     通報の履歴（tactic_reports）は消さない。消すと、同じ人がもう一度
     通報できるようになって復旧の意味がなくなるうえ、経緯も追えなくなる。 */
  update public.tactic_posts
     set hidden     = p_hidden,
         moderation = case when p_hidden then 'forced' else 'restored' end
   where id = p_post_id
   returning id, hidden, reports, moderation into v_id, v_hidden, v_reports, v_mod;

  insert into public.moderation_log (action, post_id, admin_user_id, old_value, new_value, moderator_note)
  values (
    case when p_hidden then 'force_hide' else 'restore' end,
    p_post_id,
    auth.uid(),
    jsonb_build_object('hidden', v_old.hidden, 'moderation', v_old.moderation, 'reports', v_old.reports),
    jsonb_build_object('hidden', v_hidden, 'moderation', v_mod, 'reports', v_reports),
    left(coalesce(p_note, ''), 300)
  );

  return jsonb_build_object('id', v_id, 'hidden', v_hidden,
                            'reports', v_reports, 'moderation', v_mod);
end;
$$;

revoke all on function public.admin_set_hidden(uuid, boolean, text) from public;
revoke all on function public.admin_set_hidden(uuid, boolean, text) from anon;
grant execute on function public.admin_set_hidden(uuid, boolean, text) to authenticated;

drop function if exists public.admin_set_report_threshold(int);

create or replace function public.admin_set_report_threshold(p_value int, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old int := public.report_threshold();
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN' using errcode = 'insufficient_privilege';
  end if;
  if p_value is null or p_value < 1 or p_value > 1000 then
    raise exception 'BAD_THRESHOLD' using errcode = 'check_violation';
  end if;

  insert into public.community_config (key, value, updated_at)
  values ('report_threshold', to_jsonb(p_value), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  insert into public.moderation_log (action, post_id, admin_user_id, old_value, new_value, moderator_note)
  values ('set_threshold', null, auth.uid(),
          jsonb_build_object('report_threshold', v_old),
          jsonb_build_object('report_threshold', p_value),
          left(coalesce(p_note, ''), 300));

  return jsonb_build_object('report_threshold', p_value);
end;
$$;

revoke all on function public.admin_set_report_threshold(int, text) from public;
revoke all on function public.admin_set_report_threshold(int, text) from anon;
grant execute on function public.admin_set_report_threshold(int, text) to authenticated;

-- =========================================================
-- RLS — 行レベルセキュリティ
-- anon key はブラウザに露出する前提なので、
-- 実際のアクセス制御はすべてここで行う。
-- =========================================================
alter table public.tactic_posts enable row level security;
alter table public.tactic_likes enable row level security;
alter table public.tactic_reports enable row level security;
alter table public.saved_setups enable row level security;
alter table public.admins enable row level security;
alter table public.community_config enable row level security;
alter table public.moderation_log enable row level security;

-- --- 投稿: 非表示でないものは誰でも読める ---
drop policy if exists tactic_posts_read on public.tactic_posts;
create policy tactic_posts_read
  on public.tactic_posts for select
  to anon, authenticated
  using (hidden = false);

-- --- 投稿: 運営者は隠れているものも読める（復旧するために要る） ---
drop policy if exists tactic_posts_admin_read on public.tactic_posts;
create policy tactic_posts_admin_read
  on public.tactic_posts for select
  to authenticated
  using (public.is_admin());

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

-- --- 通報: 誰が通報したかは本人にも見せない。RPC 経由のみ ---
drop policy if exists tactic_reports_none on public.tactic_reports;
create policy tactic_reports_none
  on public.tactic_reports for select
  to authenticated
  using (false);

-- --- 設定値: 読むのは誰でもよい。書き込みのポリシーは作らないので、
--     一般ユーザーからは変更できない（変更は運営 RPC 経由のみ） ---
drop policy if exists community_config_read on public.community_config;
create policy community_config_read
  on public.community_config for select
  to anon, authenticated
  using (true);

-- --- 監査ログ: 読めるのは運営者だけ。書き込みポリシーは作らないので、
--     入るのは SECURITY DEFINER の運営 RPC からだけ ---
drop policy if exists moderation_log_admin_read on public.moderation_log;
create policy moderation_log_admin_read
  on public.moderation_log for select
  to authenticated
  using (public.is_admin());

-- --- 運営者名簿: ポリシーを作らない。誰からも読めない ---

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
