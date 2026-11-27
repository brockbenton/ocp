import { describe, it, expect, vi, beforeEach } from 'vitest';

const chain = vi.hoisted(() => ({ receiptStatus: 'success' as 'success' | 'reverted' }));

vi.mock('../src/lib/contract', () => ({
  publicClient: { waitForTransactionReceipt: async () => ({ status: chain.receiptStatus }) },
  adminWalletClient: { writeContract: async () => '0xclose' },
  relayWalletClient: { writeContract: async () => '0xmint' },
  adminAccount: { address: '0x1111111111111111111111111111111111111111' },
  relayAccount: { address: '0x2222222222222222222222222222222222222222' },
  defaultAdminWalletClient: null,
  defaultAdminAccount: null,
  chain: {},
}));

import { closeSessionOnChain, mintOnChain } from '../src/services/relay.service';

beforeEach(() => {
  chain.receiptStatus = 'success';
});

describe('transaction confirmation', () => {
  it('returns the hash when the receipt succeeded', async () => {
    await expect(closeSessionOnChain('1')).resolves.toBe('0xclose');
  });

  it.each([
    ['closeSession', () => closeSessionOnChain('1')],
    ['mint', () => mintOnChain('0x3333333333333333333333333333333333333333', '1')],
  ])('throws when a mined %s reverted', async (action, send) => {
    chain.receiptStatus = 'reverted';
    await expect(send()).rejects.toThrow(`${action} reverted on-chain`);
  });
});
