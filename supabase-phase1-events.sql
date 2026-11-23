BEGIN;

-- Draft based on the v0.7.31 and v0.7.32 source migrations.
-- Apply to a staging database and verify grants and legacy event mapping first.
LOCK TABLE public.rps_events IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.rps_event_runtime (
  event_id uuid PRIMARY KEY REFERENCES public.rps_events(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  next_action_at timestamptz,
  retired_at timestamptz,
  replacement_event_id uuid REFERENCES public.rps_events(id) ON DELETE RESTRICT,
  prizes_enabled boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS rps_event_runtime_next_action_idx
  ON public.rps_event_runtime (next_action_at)
  WHERE retired_at IS NULL AND next_action_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.rps_event_aliases (
  name text PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.rps_event_runtime(event_id) ON DELETE RESTRICT
);

ALTER TABLE public.rps_event_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rps_event_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rps_event_runtime, public.rps_event_aliases FROM PUBLIC, anon, authenticated;

-- Adopt the legacy server's selection rule once. Later startups use the alias.
-- The old server stores its live game in memory. Cut over after the game ends.
DO $$
DECLARE
  legacy_id uuid;
  default_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.rps_event_aliases WHERE name = 'default') THEN
    RETURN;
  END IF;

  SELECT id INTO legacy_id FROM public.rps_events ORDER BY created_at DESC, id DESC LIMIT 1;
  default_id := legacy_id;
  -- Participant display IDs restart at P1. Never reuse an event with historical awards.
  IF legacy_id IS NULL
     OR EXISTS (SELECT 1 FROM public.rps_winners WHERE event_id = legacy_id)
     OR EXISTS (SELECT 1 FROM public.rps_prize_awards WHERE event_id = legacy_id) THEN
    default_id := gen_random_uuid();
    INSERT INTO public.rps_events (id, join_code, status)
      VALUES (default_id, replace(gen_random_uuid()::text, '-', ''), 'lobby');
    IF legacy_id IS NOT NULL THEN
      INSERT INTO public.rps_event_runtime (event_id, snapshot, retired_at, replacement_event_id)
        VALUES (legacy_id, '{}', now(), default_id);
    END IF;
  END IF;

  INSERT INTO public.rps_event_runtime (event_id, snapshot, prizes_enabled)
    VALUES (default_id, '{}', true);
  INSERT INTO public.rps_event_aliases (name, event_id) VALUES ('default', default_id);
END $$;

COMMIT;
