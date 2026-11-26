-- Phase 5 (club DAO). Drops admin_roles: officer roles are read from the chain.

-- CreateEnum
CREATE TYPE "RepStatus" AS ENUM ('NONE', 'PENDING', 'CONFIRMED', 'REJECTED', 'CREDITED');

-- CreateEnum
CREATE TYPE "RelayKind" AS ENUM ('MINT_BATCH', 'CREDIT_PAGE', 'VOTE');

-- CreateEnum
CREATE TYPE "RelayStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'REVERTED', 'CANCELLED', 'DROPPED');

-- CreateEnum
CREATE TYPE "RepEventType" AS ENUM ('CREDIT', 'SKIPPED', 'GRANT', 'REVOKE', 'UNBLOCK', 'IMPORT');

-- AlterEnum
ALTER TYPE "TxStatus" ADD VALUE 'SUBMITTED';

-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "relay_tx_id" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "alerted_at" TIMESTAMP(3),
ADD COLUMN     "attendees" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "attendees_hash" TEXT,
ADD COLUMN     "closed_by" TEXT,
ADD COLUMN     "confirmed_by" TEXT,
ADD COLUMN     "credit_cursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "max_attendees" INTEGER,
ADD COLUMN     "metadata_cid" TEXT,
ADD COLUMN     "open_warned_at" TIMESTAMP(3),
ADD COLUMN     "recognized_at" TIMESTAMP(3),
ADD COLUMN     "rep_status" "RepStatus" NOT NULL DEFAULT 'NONE';

-- DropTable
DROP TABLE "admin_roles";

-- CreateTable
CREATE TABLE "relay_txs" (
    "id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "active_key" TEXT,
    "kind" "RelayKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_fee_per_gas" TEXT NOT NULL,
    "max_priority_fee_per_gas" TEXT NOT NULL,
    "gas" TEXT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "status" "RelayStatus" NOT NULL DEFAULT 'PREPARED',
    "error" TEXT,
    "last_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relay_txs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "proposal_id" TEXT NOT NULL,
    "governor" TEXT NOT NULL,
    "proposer" TEXT NOT NULL,
    "targets" TEXT[],
    "values" TEXT[],
    "calldatas" TEXT[],
    "description" TEXT NOT NULL,
    "vote_start" TIMESTAMP(3) NOT NULL,
    "vote_end" TIMESTAMP(3) NOT NULL,
    "operation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "queued_eta" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("proposal_id")
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "support" INTEGER NOT NULL,
    "weight" TEXT,
    "signature" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "relay_tx_id" TEXT,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rep_events" (
    "id" TEXT NOT NULL,
    "type" "RepEventType" NOT NULL,
    "account" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "nominal" TEXT,
    "recognized_at" TIMESTAMP(3),
    "reason" TEXT,
    "block_number" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rep_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_events" (
    "id" TEXT NOT NULL,
    "registry_address" TEXT NOT NULL,
    "session_id_onchain" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "minted" BOOLEAN NOT NULL,
    "skip_reason" INTEGER,
    "block_number" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "id" TEXT NOT NULL,
    "block_number" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "relay_txs_active_key_key" ON "relay_txs"("active_key");

-- CreateIndex
CREATE INDEX "relay_txs_status_idx" ON "relay_txs"("status");

-- CreateIndex
CREATE INDEX "proposals_operation_id_idx" ON "proposals"("operation_id");

-- CreateIndex
CREATE INDEX "votes_status_idx" ON "votes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "votes_proposal_id_voter_key" ON "votes"("proposal_id", "voter");

-- CreateIndex
CREATE INDEX "rep_events_account_idx" ON "rep_events"("account");

-- CreateIndex
CREATE UNIQUE INDEX "rep_events_tx_hash_log_index_key" ON "rep_events"("tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "token_events_account_idx" ON "token_events"("account");

-- CreateIndex
CREATE INDEX "token_events_registry_address_session_id_onchain_idx" ON "token_events"("registry_address", "session_id_onchain");

-- CreateIndex
CREATE UNIQUE INDEX "token_events_tx_hash_log_index_key" ON "token_events"("tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "check_ins_mint_status_idx" ON "check_ins"("mint_status");
