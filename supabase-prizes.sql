-- Execute in Supabase SQL Editor once. Keep DATABASE_URL secret on Render.
create table if not exists public.rps_prize_cards(
 id uuid primary key,
 type text not null check(type in ('google','valorant','kakao','oliveyoung')),
 serial text not null,
 pin text not null,
 award_id uuid unique,
 created_at timestamptz not null default now(),
 unique(type,serial)
);
create table if not exists public.rps_prize_awards(
 id uuid primary key,
 event_id uuid not null,
 player_id text not null,
 player_name text not null,
 card_id uuid not null unique references public.rps_prize_cards(id) on delete restrict,
 claimed_at bigint not null,
 unique(event_id,player_id)
);
alter table public.rps_prize_cards add constraint rps_prize_cards_award_fk
 foreign key (award_id) references public.rps_prize_awards(id) deferrable initially deferred;
alter table public.rps_prize_cards enable row level security;
alter table public.rps_prize_awards enable row level security;
revoke all on public.rps_prize_cards, public.rps_prize_awards from anon, authenticated;
-- DB connection used by Render must have INSERT/SELECT/UPDATE/DELETE grants as appropriate.
