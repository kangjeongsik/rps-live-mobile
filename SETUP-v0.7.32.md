# v0.7.32 deployment
1. Run `supabase-v0.7.31.sql` if not yet applied, then run `supabase-v0.7.32.sql` in Supabase SQL Editor. Preserve existing prize tables.
2. Replace repository root files with this ZIP and deploy via GitHub/Render. Keep `DATABASE_URL`, `SUPABASE_DB_CA` and VAPID keys. See `SETUP-v0.7.31.md` for initial VAPID setup.
3. Check admin auto-progress toggle, reset with a participant page already open, and the winner history after a tournament.
4. Browser ID is pseudonymous and can be reset by clearing site data or changing browsers. Old winners without device hashes cannot be matched retroactively.
5. Live Render/Supabase/mobile push tests have NOT been executed in this build environment. Tournament in-memory state is reset on server restart.
