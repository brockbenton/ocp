'use client';

import { useCallback } from 'react';
import { useSendTransaction } from '@privy-io/react-auth';
import { encodeFunctionData, type Abi } from 'viem';
import { publicClient } from '@/lib/chain';
import { CHAIN } from '@/lib/constants';
import { useEmbeddedAddress } from '@/hooks/useProfile';

export interface ContractCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  /** Shown in the Privy confirmation, in plain words. */
  description: string;
}

/**
 * Sends a transaction from the member's own wallet, with Privy's confirmation shown,
 * and resolves once it has been mined successfully.
 */
export function useWalletTx() {
  const { sendTransaction } = useSendTransaction();
  const address = useEmbeddedAddress();

  return useCallback(
    async ({ address: to, abi, functionName, args = [], description }: ContractCall) => {
      if (!address) throw new Error('Your wallet is not ready yet. Try again in a moment.');
      // Fail with the contract's reason before asking for a signature.
      await publicClient.simulateContract({
        account: address as `0x${string}`,
        address: to,
        abi,
        functionName,
        args,
      });
      const { hash } = await sendTransaction(
        { to, data: encodeFunctionData({ abi, functionName, args }), chainId: CHAIN.id },
        { address, uiOptions: { showWalletUIs: true, description } },
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.');
      return hash;
    },
    [address, sendTransaction],
  );
}
