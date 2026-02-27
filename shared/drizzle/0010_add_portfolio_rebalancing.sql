-- Migration: Add Portfolio Rebalancing Tables
-- Created for Smart Portfolio Rebalancing feature

-- Create portfolio_targets table
CREATE TABLE IF NOT EXISTS portfolio_targets (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  telegram_id BIGINT,
  name TEXT NOT NULL,
  assets JSONB NOT NULL,
  drift_threshold REAL NOT NULL DEFAULT 5.0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  auto_rebalance BOOLEAN NOT NULL DEFAULT FALSE,
  last_rebalanced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for portfolio_targets
CREATE INDEX IF NOT EXISTS idx_portfolio_targets_user_id ON portfolio_targets(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_targets_telegram_id ON portfolio_targets(telegram_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_targets_is_active ON portfolio_targets(is_active);

-- Create rebalance_history table
CREATE TABLE IF NOT EXISTS rebalance_history (
  id SERIAL PRIMARY KEY,
  portfolio_target_id INTEGER NOT NULL REFERENCES portfolio_targets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  telegram_id BIGINT,
  trigger_type TEXT NOT NULL,
  total_portfolio_value NUMERIC(20, 8) NOT NULL,
  swaps_executed JSONB NOT NULL,
  total_fees NUMERIC(20, 8) NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for rebalance_history
CREATE INDEX IF NOT EXISTS idx_rebalance_history_user_id ON rebalance_history(user_id);
CREATE INDEX IF NOT EXISTS idx_rebalance_history_portfolio_target_id ON rebalance_history(portfolio_target_id);
CREATE INDEX IF NOT EXISTS idx_rebalance_history_status ON rebalance_history(status);
CREATE INDEX IF NOT EXISTS idx_rebalance_history_created_at ON rebalance_history(created_at);
