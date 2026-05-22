-- ================================================================
-- Family Financial Command Center — Supabase Schema
-- Run this entire script in: Supabase Dashboard → SQL Editor → Run
-- ================================================================

-- 1. User state — stores the entire dashboard S object as JSONB
CREATE TABLE IF NOT EXISTS user_state (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  state       jsonb       NOT NULL DEFAULT '{}',
  updated_at  timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id)
);

-- 2. SimpleFIN config — stores the claimed access URL per user
CREATE TABLE IF NOT EXISTS simplefin_config (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  access_url  text,
  last_synced timestamptz,
  created_at  timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id)
);

-- Enable Row Level Security
ALTER TABLE user_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE simplefin_config ENABLE ROW LEVEL SECURITY;

-- RLS: users can only see and modify their own rows
CREATE POLICY "own state"   ON user_state      FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own simplefin" ON simplefin_config FOR ALL USING (auth.uid() = user_id);

-- Auto-update updated_at on save
CREATE OR REPLACE FUNCTION _update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_user_state_updated_at ON user_state;
CREATE TRIGGER trg_user_state_updated_at
  BEFORE UPDATE ON user_state
  FOR EACH ROW EXECUTE FUNCTION _update_updated_at();

-- ================================================================
-- DONE. Tables created with RLS enabled.
-- Next step: Go to Supabase Auth → Settings and disable
-- "Enable email confirmations" so you can sign up immediately.
-- ================================================================
