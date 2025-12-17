-- Maketon / Upside-Down Survivor Network
-- Migration: add persisted streak + check-ins + danger-zone support
-- Run in Supabase SQL editor.

begin;

-- Extend existing users table (your project currently has: id, name, status, created_at)
alter table if exists public.users
  add column if not exists streak integer not null default 0,
  add column if not exists last_check_in_at timestamptz null,
  add column if not exists last_check_in_day_key text null,
  add column if not exists last_lat double precision null,
  add column if not exists last_lng double precision null,
  add column if not exists missing_since timestamptz null;

-- Check-ins table (one row per user per UTC day)
create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  day_key text not null,
  checked_in_at timestamptz not null default now(),
  lat double precision null,
  lng double precision null,
  note varchar(180) null,
  created_at timestamptz not null default now(),
  unique (user_id, day_key)
);

create index if not exists checkins_user_time_idx
  on public.checkins(user_id, checked_in_at desc);

-- Optional: Persist computed danger zones (the server can also compute them on the fly)
create table if not exists public.danger_zones (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  reason text not null default 'streak-broken',
  name varchar(60) not null,
  lat double precision null,
  lng double precision null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists danger_zones_user_time_idx
  on public.danger_zones(user_id, created_at desc);

commit;
