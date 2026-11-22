-- Run once in Supabase SQL Editor. Requires existing supabase-prizes.sql.
create table if not exists rps_events (id uuid primary key,join_code text not null unique,status text not null default 'lobby',created_at timestamptz not null default now());
create table if not exists rps_device_blocks(device_hash text primary key,reason text,expires_at timestamptz,created_at timestamptz not null default now());
create table if not exists rps_push_subscriptions(id uuid primary key,device_hash text unique not null,subscription jsonb not null,created_at timestamptz not null default now());
create table if not exists rps_winners(id uuid primary key,event_id uuid not null,player_id text not null,player_name text not null,access_hash text not null unique,created_at timestamptz not null default now(),unique(event_id,player_id));
create table if not exists rps_inquiries(id uuid primary key,owner_hash text not null,event_id uuid,player_name text,category text not null,message text not null,reply text,created_at timestamptz not null default now());
alter table rps_events enable row level security;alter table rps_device_blocks enable row level security;alter table rps_push_subscriptions enable row level security;alter table rps_winners enable row level security;alter table rps_inquiries enable row level security;
revoke all on rps_events,rps_device_blocks,rps_push_subscriptions,rps_winners,rps_inquiries from anon,authenticated;
