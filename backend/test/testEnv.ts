// Shared env for the test harness. Points at a throwaway DB and uses well-known
// Anvil dev keys (valid 32-byte hex so viem account construction succeeds).
export const TEST_ENV: Record<string, string> = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgresql://brock.benton@localhost:5432/ocp_test',
  ALCHEMY_API_KEY: 'test',
  // Nothing in the unit tests may reach a chain: tests mock the on-chain services.
  RPC_URL: 'http://127.0.0.1:1',
  CONTRACT_ADDRESS: '0x0000000000000000000000000000000000000001',
  REP_ADDRESS: '0x0000000000000000000000000000000000000002',
  GOVERNOR_ADDRESS: '0x0000000000000000000000000000000000000003',
  TIMELOCK_ADDRESS: '0x0000000000000000000000000000000000000004',
  INDEXER_START_BLOCK: '0',
  RELAY_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  QR_SIGNER_PRIVATE_KEY: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  PRIVY_APP_ID: 'test-app-id',
  PRIVY_APP_SECRET: 'test-app-secret',
  CHAIN_ID: '84532',
  PUBLIC_API_URL: 'http://localhost:3001',
  CORS_ORIGINS: 'http://localhost:3000,https://app.example.com/',
};
