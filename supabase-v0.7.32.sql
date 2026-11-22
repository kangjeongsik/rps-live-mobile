-- Execute after supabase-v0.7.31.sql. Safe to re-run.
alter table rps_winners add column if not exists device_hash text;
alter table rps_winners alter column access_hash drop not null;
create index if not exists rps_winners_device_history_idx on rps_winners(device_hash,created_at desc);
-- Past winners without stored device hashes cannot be matched retroactively.
