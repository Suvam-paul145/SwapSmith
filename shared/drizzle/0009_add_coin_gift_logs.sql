-- Migration: Add testnet coin gift logs table
-- Feature: Admin Panel - Testnet Coin Management & Gifting (#376)

DO $$ BEGIN
  CREATE TYPE "coin_gift_action_type" AS ENUM('gift', 'deduct', 'reset');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "coin_gift_logs" (
  "id"              serial PRIMARY KEY NOT NULL,
  "admin_id"        text NOT NULL,
  "admin_email"     text NOT NULL,
  "target_user_id"  integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "wallet_address"  text,
  "action"          "coin_gift_action_type" NOT NULL,
  "amount"          numeric(20, 2) NOT NULL,
  "balance_before"  numeric(20, 2) NOT NULL DEFAULT 0,
  "balance_after"   numeric(20, 2) NOT NULL DEFAULT 0,
  "note"            text,
  "created_at"      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_coin_gift_logs_target_user" ON "coin_gift_logs" ("target_user_id");
CREATE INDEX IF NOT EXISTS "idx_coin_gift_logs_admin"       ON "coin_gift_logs" ("admin_id");
CREATE INDEX IF NOT EXISTS "idx_coin_gift_logs_created_at"  ON "coin_gift_logs" ("created_at");
