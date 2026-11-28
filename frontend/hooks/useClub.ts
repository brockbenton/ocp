'use client';

import { useQuery } from '@tanstack/react-query';
import { getClub } from '@/lib/api/club';
import { queryKeys } from '@/lib/api/queryKeys';

/** Officers, pause state, guardian and governance settings. */
export function useClub() {
  // Pause state and officers change on-chain, so re-read them while a page is open.
  return useQuery({ queryKey: queryKeys.club(), queryFn: getClub, refetchInterval: 15_000 });
}
