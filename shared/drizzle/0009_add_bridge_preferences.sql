-- Add bridge preferences to user settings
-- This migration adds bridge-specific preferences to the user_settings table

ALTER TABLE user_settings 
ADD COLUMN IF NOT EXISTS preferred_bridges text[] DEFAULT ARRAY[]::text[],
ADD COLUMN IF NOT EXISTS avoid_bridges text[] DEFAULT ARRAY[]::text[],
ADD COLUMN IF NOT EXISTS bridge_priority text DEFAULT 'balanced' CHECK (bridge_priority IN ('speed', 'cost', 'reliability', 'balanced')),
ADD COLUMN IF NOT EXISTS instant_bridge_only boolean DEFAULT false;

-- Create index for bridge preferences
CREATE INDEX IF NOT EXISTS idx_user_settings_bridge_priority ON user_settings(bridge_priority);

-- Create table for bridge preferences (alternative approach - more flexible)
CREATE TABLE IF NOT EXISTS bridge_preferences (
  id SERIAL PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES user_settings(user_id) ON DELETE CASCADE,
  preferred_bridges text[] DEFAULT ARRAY[]::text[],
  avoid_bridges text[] DEFAULT ARRAY[]::text[],
  priority text DEFAULT 'balanced' CHECK (priority IN ('speed', 'cost', 'reliability', 'balanced')),
  max_slippage real DEFAULT 0.5,
  instant_only boolean DEFAULT false,
  updated_at timestamp NOT NULL DEFAULT NOW(),
  created_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bridge_preferences_user_id ON bridge_preferences(user_id);

-- Create table for bridge quotes history (for analytics)
CREATE TABLE IF NOT EXISTS bridge_quotes_history (
  id SERIAL PRIMARY KEY,
  user_id text,
  from_chain text NOT NULL,
  to_chain text NOT NULL,
  from_token text NOT NULL,
  to_token text NOT NULL,
  amount text NOT NULL,
  bridge text NOT NULL,
  to_amount text NOT NULL,
  total_fee text NOT NULL,
  estimated_time_min integer,
  estimated_time_max integer,
  confidence integer,
  created_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bridge_quotes_history_user_id ON bridge_quotes_history(user_id);
CREATE INDEX IF NOT EXISTS idx_bridge_quotes_history_created_at ON bridge_quotes_history(created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_quotes_history_chain_pair ON bridge_quotes_history(from_chain, to_chain);

-- Create table for bridge orders (for tracking)
CREATE TABLE IF NOT EXISTS bridge_orders (
  id SERIAL PRIMARY KEY,
  user_id text,
  telegram_id bigint,
  bridge text NOT NULL,
  order_id text NOT NULL UNIQUE,
  from_chain text NOT NULL,
  to_chain text NOT NULL,
  from_token text NOT NULL,
  to_token text NOT NULL,
  from_amount text NOT NULL,
  to_amount text NOT NULL,
  deposit_address text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
  tx_hash text,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp,
  completed_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_bridge_orders_user_id ON bridge_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_telegram_id ON bridge_orders(telegram_id);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_status ON bridge_orders(status);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_bridge ON bridge_orders(bridge);
