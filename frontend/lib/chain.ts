import { createPublicClient, http } from 'viem';
import { CHAIN, RPC_URL } from '@/lib/constants';

// Reads straight from the chain, not through the club's backend, so members can check
// for themselves what happened (for example, whether their vote landed).
export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
