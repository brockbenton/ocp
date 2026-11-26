import { BaseError, ContractFunctionRevertedError, InsufficientFundsError } from 'viem';

const REVERTS: Record<string, string> = {
  SameOfficer: 'A different officer has to confirm: you closed this session.',
  NotPending: 'This session is no longer waiting for approval.',
  SessionAlreadyExists: 'A session with this id already exists.',
  SessionNotActive: 'This session is already closed.',
  NotAttendee: 'Someone on the list does not hold this session’s token. Reload the list.',
  TooManyAttendees: 'The list is longer than the number of tokens minted. Reload it.',
  InvalidMaxAttendees: 'Maximum attendees must be between 1 and 300.',
  PauseCooldown: 'You can pause once every 30 days. Another officer can pause now.',
  AlreadyApproved: 'You already approved. A second officer has to unpause.',
  MintingNotPaused: 'Minting is not paused.',
  OfficerFloor: 'The club must always have at least two officers.',
  AccessControlUnauthorizedAccount: 'This wallet does not have the role needed for that.',
  NotOfficerOrTimelock: 'Only officers can do that.',
  GovernorInsufficientProposerVotes: 'You do not have enough Rep to propose.',
  GovernorAlreadyCastVote: 'This member already voted.',
  GovernorInvalidSignature: 'That signature is not valid for this member and choice.',
  GovernorUnexpectedProposalState: 'The proposal is not in the right state for that.',
  TimelockUnexpectedOperationState: 'The Timelock is not ready for that yet.',
  ImportNotFinalized: 'Proposals open once the attendance import is finalized.',
};

/** A sentence for a failed transaction, using the contract's own reason when there is one. */
export function txErrorMessage(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? '';
      return REVERTS[name] ?? `The contract rejected this${name ? ` (${name})` : ''}.`;
    }
    if (error.walk((e) => e instanceof InsufficientFundsError)) {
      return 'Not enough ETH for gas. Top up your wallet and try again.';
    }
    return error.shortMessage;
  }
  const message = error instanceof Error ? error.message : '';
  if (/insufficient funds/i.test(message)) return 'Not enough ETH for gas. Top up your wallet and try again.';
  return message.slice(0, 200) || 'Something went wrong. Please try again.';
}
