import {
  SessionWithCount,
  Attendee,
  Session,
  MembersListResponse,
  AdminOverview,
  AdminMe,
  CloseList,
  MetadataPreview,
  ReviewItem,
} from '@/types';
import { apiRequest, API_BASE, ApiRequestError } from './client';

export async function getAdminMe(token: string): Promise<AdminMe> {
  return apiRequest<AdminMe>('/admin/me', { token });
}

export async function getAdminOverview(token: string): Promise<AdminOverview> {
  return apiRequest<AdminOverview>('/admin/overview', { token });
}

// Download a CSV from an admin export endpoint and trigger a browser save-file dialog.
// Must be called in a browser context (not SSR).
async function downloadCSV(path: string, fallbackFilename: string, token: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiRequestError('EXPORT_FAILED', 'CSV export failed', response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadSessionCSV(
  sessionId: string,
  registry: string,
  token: string,
): Promise<void> {
  await downloadCSV(
    `/admin/export/sessions/${encodeURIComponent(sessionId)}?registry=${registry}`,
    `session-${sessionId}-attendees.csv`,
    token,
  );
}

export async function downloadMembersCSV(token: string): Promise<void> {
  await downloadCSV('/admin/export/members', 'members.csv', token);
}

export async function listAdminSessions(token: string): Promise<SessionWithCount[]> {
  return apiRequest<SessionWithCount[]>('/admin/sessions', { token });
}

export async function getSessionAttendees(
  sessionId: string,
  registry: string,
  token: string,
): Promise<Attendee[]> {
  return apiRequest<Attendee[]>(
    `/admin/sessions/${encodeURIComponent(sessionId)}/attendees?registry=${registry}`,
    { token },
  );
}

/**
 * Mirrors an officer's own transaction without waiting for the indexer. The transaction
 * has already succeeded, so a failure here is not an error: resolves false, and the
 * indexer catches up shortly.
 */
export async function syncSession(sessionId: string, token: string): Promise<boolean> {
  try {
    await apiRequest<Session>(`/sessions/${encodeURIComponent(sessionId)}/sync`, {
      method: 'POST',
      token,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getSession(sessionId: string, token: string): Promise<Session> {
  return apiRequest<Session>(`/sessions/${encodeURIComponent(sessionId)}`, { token });
}

export async function getSessionDefaults(token: string): Promise<{ suggestedMaxAttendees: number }> {
  return apiRequest<{ suggestedMaxAttendees: number }>('/admin/session-defaults', { token });
}

export async function previewMetadata(
  input: { sessionId: string; name: string; date: string },
  token: string,
): Promise<MetadataPreview> {
  return apiRequest<MetadataPreview>('/admin/metadata/preview', {
    method: 'POST',
    body: JSON.stringify(input),
    token,
  });
}

export async function getCloseList(sessionId: string, token: string): Promise<CloseList> {
  return apiRequest<CloseList>(`/admin/sessions/${encodeURIComponent(sessionId)}/close-list`, {
    token,
  });
}

export async function getReviewQueue(token: string): Promise<ReviewItem[]> {
  return apiRequest<ReviewItem[]>('/admin/review', { token });
}

export async function listAdminMembers(token: string): Promise<MembersListResponse> {
  return apiRequest<MembersListResponse>('/admin/members', { token });
}

export async function toggleFoundingMember(
  memberId: string,
  founding: boolean,
  token: string,
): Promise<void> {
  await apiRequest<{ id: string; walletAddress: string; foundingMember: boolean }>(
    `/admin/members/${encodeURIComponent(memberId)}/founding-member`,
    { method: 'PATCH', body: JSON.stringify({ founding }), token },
  );
}

// A request that never settles would stall the projector's refresh, so it is abandoned.
const QR_REQUEST_TIMEOUT_MS = 15_000;

export async function getSessionQR(sessionId: string, token: string): Promise<string> {
  const result = await apiRequest<{ qr: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/qr`,
    { token, signal: AbortSignal.timeout(QR_REQUEST_TIMEOUT_MS) },
  );
  return result.qr;
}
