import { describe, it, expect } from 'vitest';
import { computeFlags, type ReviewFacts } from '../src/services/review.service';
import { tokenRepStatus } from '../src/services/rep.service';
import { bumpedFees, isRevert } from '../src/services/relay.service';
import { CallExecutionError, ExecutionRevertedError, HttpRequestError, TimeoutError } from 'viem';

const wallets = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** An unremarkable meeting: everyone known, checked in and returning. */
const ordinary = (count = 20): ReviewFacts => ({
  attendees: wallets(count),
  previousCounts: [20, 22, 18, 21],
  firstTimers: [],
  recentWallets: [],
  unknownWallets: [],
  checkedIn: wallets(count),
  closedInPreviousDay: 0,
});

const codes = (facts: ReviewFacts) => computeFlags(facts).map((f) => f.code);

describe('anomaly flags', () => {
  it('flags nothing on an ordinary meeting', () => {
    expect(codes(ordinary())).toEqual([]);
  });

  it('flags attendance far above the trailing median', () => {
    expect(codes(ordinary(31))).toEqual(['HIGH_ATTENDANCE']);
    expect(codes(ordinary(30))).toEqual([]);
  });

  it('needs three earlier meetings, and ignores small absolute jumps', () => {
    expect(codes({ ...ordinary(90), previousCounts: [3, 3] })).toEqual([]);
    expect(codes({ ...ordinary(7), previousCounts: [3, 3, 3] })).toEqual([]);
  });

  it('flags many first-time attendees, new accounts and unknown wallets', () => {
    expect(codes({ ...ordinary(), firstTimers: wallets(6) })).toEqual(['MANY_FIRST_TIME']);
    expect(codes({ ...ordinary(), firstTimers: wallets(5) })).toEqual([]);
    expect(codes({ ...ordinary(), recentWallets: ['w1'] })).toEqual(['RECENT_WALLETS']);
    expect(codes({ ...ordinary(), unknownWallets: ['x'] })).toEqual(['UNKNOWN_WALLETS']);
  });

  it('flags a list that differs from recorded check-ins, in either direction', () => {
    const added = computeFlags({ ...ordinary(), attendees: [...wallets(20), 'stranger'] });
    expect(added.map((f) => f.code)).toEqual(['LIST_MISMATCH']);
    expect(added[0].wallets).toEqual(['stranger']);
    const omitted = computeFlags({ ...ordinary(), attendees: wallets(19) });
    expect(omitted[0]).toMatchObject({ code: 'LIST_MISMATCH', wallets: ['w19'] });
  });

  it('flags repeated sessions within a day', () => {
    expect(codes({ ...ordinary(), closedInPreviousDay: 1 })).toEqual([]);
    expect(codes({ ...ordinary(), closedInPreviousDay: 2 })).toEqual(['REPEATED_SESSIONS']);
  });
});

describe('a token’s Rep status', () => {
  const current = '0x0000000000000000000000000000000000000001';
  const base = {
    registryAddress: current,
    repStatus: 'NONE' as const,
    attendees: ['a', 'b'],
    creditCursor: 0,
    closeTxHash: '0xclose',
  };

  it('follows the sign-off', () => {
    expect(tokenRepStatus(base, 'a')).toBe('OPEN');
    expect(tokenRepStatus({ ...base, repStatus: 'PENDING' }, 'a')).toBe('PENDING_APPROVAL');
    expect(tokenRepStatus({ ...base, repStatus: 'REJECTED' }, 'a')).toBe('REJECTED');
    expect(tokenRepStatus({ ...base, repStatus: 'PENDING' }, 'z')).toBe('NOT_LISTED');
    expect(tokenRepStatus({ ...base, repStatus: 'CREDITED' }, 'a')).toBe('CREDITED');
  });

  it('does not call anyone unlisted before the list has been indexed', () => {
    const unindexed = { ...base, repStatus: 'PENDING' as const, attendees: [], closeTxHash: null };
    expect(tokenRepStatus(unindexed, 'a')).toBe('PENDING_APPROVAL');
  });

  it('is awaiting credit until the wallet’s page lands', () => {
    const paged = { ...base, repStatus: 'CONFIRMED' as const, creditCursor: 1 };
    expect(tokenRepStatus(paged, 'a')).toBe('CREDITED');
    expect(tokenRepStatus(paged, 'b')).toBe('AWAITING_CREDIT');
  });

  it('marks history from an earlier registry as legacy', () => {
    expect(tokenRepStatus({ ...base, registryAddress: '0xold' }, 'a')).toBe('LEGACY');
  });
});

describe('replacement fees', () => {
  const previous = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };

  it('raises both fees by at least a tenth, following the market upwards', () => {
    expect(bumpedFees(previous, previous, 10_000n)).toEqual({ maxFeePerGas: 1251n, maxPriorityFeePerGas: 126n });
    expect(bumpedFees(previous, { maxFeePerGas: 3000n, maxPriorityFeePerGas: 50n }, 10_000n)).toEqual({
      maxFeePerGas: 3000n,
      maxPriorityFeePerGas: 126n,
    });
  });

  it('never exceeds the ceiling, and gives up if the ceiling prevents a valid replacement', () => {
    expect(bumpedFees(previous, previous, 1150n)?.maxFeePerGas).toBe(1150n);
    expect(bumpedFees(previous, previous, 1099n)).toBeNull();
    expect(bumpedFees(previous, { maxFeePerGas: 9000n, maxPriorityFeePerGas: 9000n }, 2000n)).toEqual({
      maxFeePerGas: 2000n,
      maxPriorityFeePerGas: 2000n,
    });
  });
});

describe('which relay failures count against the work', () => {
  const call = (cause: Parameters<typeof CallExecutionError.prototype.constructor>[0]) =>
    new CallExecutionError(cause, {});

  it('counts a revert, even when wrapped', () => {
    expect(isRevert(call(new ExecutionRevertedError({ message: 'nope' })))).toBe(true);
  });

  it('does not count outages, timeouts or unknown errors', () => {
    expect(isRevert(call(new HttpRequestError({ url: 'http://rpc', status: 503 })))).toBe(false);
    expect(isRevert(new TimeoutError({ body: {}, url: 'http://rpc' }))).toBe(false);
    expect(isRevert(new Error('database is down'))).toBe(false);
  });
});
