'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatEther, parseEther } from 'viem';
import { publicClient } from '@/lib/chain';
import { queryKeys } from '@/lib/api/queryKeys';
import { useEmbeddedAddress } from '@/hooks/useProfile';

const LOW_BALANCE = parseEther('0.0005');

/** The ETH a member or officer has for gas, with where to top it up. */
export default function WalletBalance() {
  const address = useEmbeddedAddress();
  const { data: balance } = useQuery({
    queryKey: queryKeys.ethBalance(address ?? ''),
    queryFn: () => publicClient.getBalance({ address: address as `0x${string}` }),
    enabled: !!address,
    refetchInterval: 30_000,
  });
  if (balance === undefined) return null;
  const low = balance < LOW_BALANCE;
  return (
    <p className={`text-xs ${low ? 'text-status-warn' : 'text-content-secondary'}`}>
      Your gas balance: <span className="font-mono">{Number(formatEther(balance)).toFixed(5)} ETH</span>
      {low && ' (too low for most transactions)'} ·{' '}
      <Link href="/wallet" className="text-cyan hover:text-content">
        Top up
      </Link>
    </p>
  );
}
