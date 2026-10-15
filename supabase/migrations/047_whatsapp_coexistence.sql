-- ============================================================
-- 047_whatsapp_coexistence.sql
--
-- Adds support for WhatsApp Coexistence mode:
-- 1. whatsapp_config:
--    - connection_mode: 'cloud_api' (default / manual) vs 'coexistence'
--    - sync statuses & progress tracking for contacts and history
--    - timestamps for onboarding and disconnection
-- 2. messages:
--    - source: 'wacrm' (default) vs 'business_app' (echoes from phone)
-- ============================================================

-- 1. whatsapp_config columns
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_mode TEXT DEFAULT 'cloud_api'
    CHECK (connection_mode IN ('cloud_api', 'coexistence')),
  ADD COLUMN IF NOT EXISTS contacts_sync_status TEXT DEFAULT 'pending'
    CHECK (contacts_sync_status IN ('pending', 'in_progress', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS history_sync_status TEXT DEFAULT 'pending'
    CHECK (history_sync_status IN ('pending', 'in_progress', 'completed', 'failed', 'declined')),
  ADD COLUMN IF NOT EXISTS history_sync_progress INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contacts_sync_request_id TEXT,
  ADD COLUMN IF NOT EXISTS history_sync_request_id TEXT,
  ADD COLUMN IF NOT EXISTS contacts_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coexistence_onboarded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coexistence_disconnected_at TIMESTAMPTZ;

-- 2. messages table: track message origin (wacrm vs phone app echoes)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'wacrm'
    CHECK (source IN ('wacrm', 'business_app'));

CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_connection_mode ON whatsapp_config(connection_mode);
