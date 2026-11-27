-- An on-chain session id is only unique within one registry (#56). Existing rows get
-- an empty registry here and are assigned the configured one when the server starts.
ALTER TABLE "sessions" ADD COLUMN "registry_address" TEXT NOT NULL DEFAULT '';

DROP INDEX "sessions_session_id_onchain_key";

CREATE UNIQUE INDEX "sessions_registry_address_session_id_onchain_key" ON "sessions"("registry_address", "session_id_onchain");
