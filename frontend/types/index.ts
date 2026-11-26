// Session from the backend API
export interface Session {
  id: string;
  sessionId: string;
  name: string;
  date: string;
  semester: string;
  createdBy: string;
  txHash: string | null;
  closeTxHash: string | null;
  onchainStatus: TxStatus;
  closedAt: string | null;
  createdAt: string;
  registryAddress: string;
  isCurrentRegistry: boolean;
  maxAttendees: number | null;
  metadataCid: string | null;
  repStatus: RepStatus;
  closedBy: string | null;
  confirmedBy: string | null;
  recognizedAt: string | null;
  listedCount: number;
  creditCursor: number;
}

export type TxStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
export type RepStatus = 'NONE' | 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CREDITED';

/** Where one attendance stands on its way to becoming voting power. */
export type TokenRepStatus =
  | 'LEGACY'
  | 'OPEN'
  | 'PENDING_APPROVAL'
  | 'AWAITING_CREDIT'
  | 'CREDITED'
  | 'REJECTED'
  | 'NOT_LISTED';

// Session with attendee count (admin list endpoint)
export interface SessionWithCount extends Session {
  attendeeCount: number;
}

// Attendee entry from admin sessions/:id/attendees endpoint
export interface Attendee {
  walletAddress: string;
  checkedInAt: string;
  mintStatus: TxStatus;
  failureReason: string | null;
  txHash: string | null;
}

// Member stats from GET /api/v1/admin/members
export interface MemberStats {
  id: string;
  walletAddress: string;
  linkedAccount: string | null;
  foundingMember: boolean;
  tokensEarned: number;
  allTimeAttendancePct: number;
  currentSemesterAttendancePct: number;
  lastSeen: string | null;
  joinedAt: string;
  currentStreak: number;
  /** Attendance at each session in `recentSessions`, same order (oldest → newest). */
  recentAttendance: boolean[];
}

// A meeting in the trailing window the members-table attendance matrix renders.
export interface RecentSession {
  sessionIdOnchain: string;
  name: string;
  date: string;
}

export interface MembersListResponse {
  members: MemberStats[];
  totalSessions: number;
  currentSemester: string | null;
  recentSessions: RecentSession[];
}

// Attendance token in a member's vault (GET /api/v1/members/:address/tokens)
export interface VaultToken {
  tokenId: string;
  sessionIdOnchain: string;
  name: string;
  date: string;
  semester: string;
  meetingNumber: number;
  mintStatus: TxStatus;
  repStatus: TokenRepStatus;
  txHash: string | null;
  imageUrl: string;
  metadataUri: string | null;
}

export interface MemberVault {
  walletAddress: string;
  found: boolean;
  tokenCount: number;
  tokens: VaultToken[];
}

export interface SemesterStat {
  semester: string;
  attended: number;
  total: number;
  pct: number;
}

// Personal attendance stats (GET /api/v1/members/:address/stats)
export interface PersonalStats {
  walletAddress: string;
  found: boolean;
  foundingMember: boolean;
  tokensEarned: number;
  totalSessions: number;
  allTimeAttendancePct: number;
  currentSemester: string | null;
  currentSemesterTotal: number;
  currentSemesterAttendancePct: number;
  meetingsLast30Days: number;
  meetingsLast90Days: number;
  meetingsLast180Days: number;
  currentStreak: number;
  longestStreak: number;
  lastSeen: string | null;
  semesterBreakdown: SemesterStat[];
  badgeUrl: string | null;
}

// Admin overview from GET /api/v1/admin/overview
export interface OverviewSessionPoint {
  sessionIdOnchain: string;
  name: string;
  date: string;
  semester: string;
  headcount: number;
  eligibleMembers: number;
  attendanceRate: number;
}

export interface AdminOverview {
  totalMembers: number;
  totalSessions: number;
  currentSemester: string | null;
  avgHeadcount: number;
  series: OverviewSessionPoint[];
  latest: { headcount: number; attendanceRate: number } | null;
  previous: { headcount: number; attendanceRate: number } | null;
  wow: { headcountDelta: number; attendanceRateDelta: number } | null;
}

// GET /api/v1/admin/me — admin-gate probe
export interface AdminMe {
  isAdmin: boolean;
  walletAddress: string;
}

// Check-in response from POST /api/v1/check-in
export interface CheckInResponse {
  checkInId: string;
  sessionId: string;
  memberAddress: string;
  status: 'PENDING';
}

// Error body returned by the backend API
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// A ranked row on the leaderboard, derived from the public member directory.
export interface LeaderboardEntry {
  rank: number;
  rankLabel: string;
  handle: string;
  avatarSeed: string;
  streak: number;
  tokens: number;
  attendancePct: number;
  /** Current decayed Rep (18 decimals), or null if the chain could not be read. */
  rep: string | null;
  isYou: boolean;
}

export interface Leaderboard {
  entries: LeaderboardEntry[];
  /** When every Rep figure was read. */
  repAsOf: string | null;
}

// GET /api/v1/members/:address/rep
export interface MemberRep {
  walletAddress: string;
  rep: string | null;
  totalSupply: string | null;
  asOf: string | null;
  waiting: { sessionId: string; name: string; status: TokenRepStatus }[];
  history: {
    type: 'CREDIT' | 'SKIPPED' | 'GRANT' | 'REVOKE' | 'UNBLOCK' | 'IMPORT';
    amount: string;
    nominal: string | null;
    recognizedAt: string | null;
    reason: string | null;
    occurredAt: string;
    txHash: string;
  }[];
}

// GET /api/v1/club
export interface Club {
  chainId: number;
  officers: { walletAddress: string; username: string | null }[];
  pause: { paused: boolean; pausedUntil: number; unpauseApprover: string | null };
  guardian: { address: string; active: boolean; expiresAt: number };
  importFinalized: boolean;
  proposalThreshold: string;
  votingDelaySeconds: number;
  votingPeriodSeconds: number;
  quorumNumerator: number;
  timelockDelaySeconds: number;
  repHalfLifeSeconds: number;
  openSessionWarnHours: number;
}

// GET /api/v1/admin/review
export interface ReviewItem extends Omit<Session, 'listedCount'> {
  attendees: { walletAddress: string; username: string | null }[];
  flags: { code: string; message: string; wallets?: string[] }[];
  canConfirm: boolean;
}

export interface CloseList {
  sessionId: string;
  attendees: `0x${string}`[];
  waiting: number;
  failed: number;
}

export interface MetadataPreview {
  metadata: {
    name: string;
    description: string;
    image: string;
    attributes: { trait_type: string; value: string | number }[];
  };
  cid: string | null;
}

export type ProposalState =
  | 'Pending'
  | 'Active'
  | 'Canceled'
  | 'Defeated'
  | 'Succeeded'
  | 'Queued'
  | 'Expired'
  | 'Executed';

// GET /api/v1/governance/proposals
export interface Proposal {
  proposalId: string;
  proposer: string;
  targets: string[];
  values: string[];
  calldatas: string[];
  description: string;
  createdAt: string;
  queuedEta: string | null;
  state: ProposalState;
  snapshot: number;
  deadline: number;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  /** Null until the snapshot has passed. */
  quorum: string | null;
}

export interface SignedVote {
  proposalId: string;
  voter: string;
  support: number;
  signature: `0x${string}`;
}

export interface RelayedVote extends SignedVote {
  status: TxStatus;
  failureReason: string | null;
  txHash: string | null;
}

// Editable member profile (GET/PATCH /members/me). avatarColor indexes the
// avatar palette (lib/tokenArt.ts); null means fall back to the seed-derived color.
export interface MemberProfile {
  walletAddress: string;
  username: string | null;
  avatarColor: number | null;
  bio: string | null;
  notifyEmail: boolean;
}
