-- カフェ共有アプリ 初期スキーマ
-- テーブルは RLS で直接アクセスを禁止し、合言葉ハッシュ(p_key)を検証する RPC 関数経由でのみ操作する。

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null,
  color text not null,
  created_at timestamptz not null default now(),
  unique (room_id, name)
);

create table if not exists public.cafes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  source_url text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'error')),
  error text,
  name text,
  summary text,
  genre text,
  area text,
  address text,
  lat double precision,
  lng double precision,
  hours text,
  holidays text,
  price text,
  phone text,
  access text,
  links jsonb not null default '[]'::jsonb,   -- [{type, label, url}]
  photos jsonb not null default '[]'::jsonb,  -- [url]
  memo text,
  visited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists cafes_room_created_idx on public.cafes (room_id, created_at desc);

alter table public.rooms enable row level security;
alter table public.members enable row level security;
alter table public.cafes enable row level security;
-- ポリシーは作らない = anon / authenticated からの直接アクセスは不可

-- ---------------------------------------------------------------------------
-- 内部ヘルパー
-- ---------------------------------------------------------------------------
create or replace function public._room_id(p_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
begin
  select id into rid from rooms where key_hash = p_key;
  if rid is null then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  return rid;
end;
$$;

revoke all on function public._room_id(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 公開 RPC
-- ---------------------------------------------------------------------------

-- 合言葉ハッシュで部屋に入る（なければ作る）。同じ名前なら同じメンバーとして扱う。
create or replace function public.join_room(p_key text, p_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
  m members;
  palette text[] := array['#E0694F', '#2F8F8B', '#7A5AC8', '#D39B1F', '#3F7FD1', '#C2527F'];
  n int;
begin
  if p_key is null or length(p_key) < 32 then
    raise exception 'invalid key';
  end if;
  if p_name is null or length(trim(p_name)) = 0 or length(p_name) > 30 then
    raise exception 'invalid name';
  end if;

  insert into rooms (key_hash) values (p_key) on conflict (key_hash) do nothing;
  select id into rid from rooms where key_hash = p_key;

  select * into m from members where room_id = rid and name = trim(p_name);
  if m.id is null then
    select count(*) into n from members where room_id = rid;
    insert into members (room_id, name, color)
    values (rid, trim(p_name), palette[(n % array_length(palette, 1)) + 1])
    returning * into m;
  end if;

  return json_build_object('room_id', rid, 'member', row_to_json(m));
end;
$$;

create or replace function public.list_members(p_key text)
returns setof public.members
language sql
security definer
set search_path = public
as $$
  select * from members where room_id = _room_id(p_key) order by created_at;
$$;

create or replace function public.update_member(p_key text, p_member_id uuid, p_name text, p_color text)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  m members;
begin
  update members set
    name = coalesce(nullif(trim(p_name), ''), name),
    color = case when p_color ~ '^#[0-9A-Fa-f]{6}$' then p_color else color end
  where id = p_member_id and room_id = _room_id(p_key)
  returning * into m;
  return m;
end;
$$;

create or replace function public.list_cafes(p_key text)
returns setof public.cafes
language sql
security definer
set search_path = public
as $$
  select * from cafes where room_id = _room_id(p_key) order by created_at desc;
$$;

create or replace function public.add_cafe(p_key text, p_member_id uuid, p_url text, p_memo text default null)
returns public.cafes
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid := _room_id(p_key);
  c cafes;
begin
  if not exists (select 1 from members where id = p_member_id and room_id = rid) then
    raise exception 'member not in room';
  end if;
  if p_url !~* '^https?://' then
    raise exception 'invalid url';
  end if;
  insert into cafes (room_id, member_id, source_url, memo)
  values (rid, p_member_id, trim(p_url), nullif(trim(p_memo), ''))
  returning * into c;
  return c;
end;
$$;

-- p_patch に含まれるキーだけを更新する
create or replace function public.update_cafe(p_key text, p_id uuid, p_patch jsonb)
returns public.cafes
language plpgsql
security definer
set search_path = public
as $$
declare
  c cafes;
begin
  update cafes set
    name     = case when p_patch ? 'name'     then p_patch->>'name'     else name end,
    summary  = case when p_patch ? 'summary'  then p_patch->>'summary'  else summary end,
    genre    = case when p_patch ? 'genre'    then p_patch->>'genre'    else genre end,
    area     = case when p_patch ? 'area'     then p_patch->>'area'     else area end,
    address  = case when p_patch ? 'address'  then p_patch->>'address'  else address end,
    hours    = case when p_patch ? 'hours'    then p_patch->>'hours'    else hours end,
    holidays = case when p_patch ? 'holidays' then p_patch->>'holidays' else holidays end,
    price    = case when p_patch ? 'price'    then p_patch->>'price'    else price end,
    phone    = case when p_patch ? 'phone'    then p_patch->>'phone'    else phone end,
    access   = case when p_patch ? 'access'   then p_patch->>'access'   else access end,
    memo     = case when p_patch ? 'memo'     then p_patch->>'memo'     else memo end,
    links    = case when p_patch ? 'links'  and jsonb_typeof(p_patch->'links')  = 'array' then p_patch->'links'  else links end,
    photos   = case when p_patch ? 'photos' and jsonb_typeof(p_patch->'photos') = 'array' then p_patch->'photos' else photos end,
    visited  = case when p_patch ? 'visited' then (p_patch->>'visited')::boolean else visited end,
    lat      = case when p_patch ? 'lat' then nullif(p_patch->>'lat', '')::double precision else lat end,
    lng      = case when p_patch ? 'lng' then nullif(p_patch->>'lng', '')::double precision else lng end,
    updated_at = now()
  where id = p_id and room_id = _room_id(p_key)
  returning * into c;
  return c;
end;
$$;

create or replace function public.delete_cafe(p_key text, p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from cafes where id = p_id and room_id = _room_id(p_key);
$$;

-- 情報の再収集用に状態を pending に戻す
create or replace function public.reset_cafe(p_key text, p_id uuid)
returns public.cafes
language plpgsql
security definer
set search_path = public
as $$
declare
  c cafes;
begin
  update cafes set status = 'pending', error = null, updated_at = now()
  where id = p_id and room_id = _room_id(p_key)
  returning * into c;
  return c;
end;
$$;

grant execute on function
  public.join_room(text, text),
  public.list_members(text),
  public.update_member(text, uuid, text, text),
  public.list_cafes(text),
  public.add_cafe(text, uuid, text, text),
  public.update_cafe(text, uuid, jsonb),
  public.delete_cafe(text, uuid),
  public.reset_cafe(text, uuid)
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 写真用ストレージ（公開読み取り、アップロードは誰でも可）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "photos upload" on storage.objects;
create policy "photos upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'photos');
