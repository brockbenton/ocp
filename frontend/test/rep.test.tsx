import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import RepCard from '@/components/features/member/RepCard';
import { api, renderWithQuery, OFFICER } from './harness';

describe('the member’s Rep card', () => {
  beforeEach(() => {
    api.routes['GET /club'] = { repHalfLifeSeconds: 180 * 86_400, guardian: { active: false } };
  });

  it('shows current Rep with its time, how it fades, and what is still on the way', async () => {
    api.routes[`GET /members/${OFFICER}/rep`] = {
      rep: '29986000000000000000',
      asOf: '2026-11-20T18:00:00.000Z',
      waiting: [
        { sessionId: '1', name: 'Kickoff', status: 'PENDING_APPROVAL' },
        { sessionId: '2', name: 'Workshop', status: 'AWAITING_CREDIT' },
      ],
      history: [],
    };
    renderWithQuery(<RepCard address={OFFICER} />);
    expect(await screen.findByText('29.98')).toBeTruthy();
    expect(screen.getByText(/as of/)).toBeTruthy();
    expect(await screen.findByText(/half of it every 180 days/)).toBeTruthy();
    expect(screen.getByText('Rep pending')).toBeTruthy();
    expect(screen.getByText('Approved, credit processing')).toBeTruthy();
    expect(screen.queryByText(/weekly|deferred/i)).toBeNull();
  });

  it('says so, rather than showing zero, when the chain cannot be read', async () => {
    api.routes[`GET /members/${OFFICER}/rep`] = { rep: null, asOf: null, waiting: [], history: [] };
    renderWithQuery(<RepCard address={OFFICER} />);
    expect(await screen.findByText(/Couldn.t read your Rep/)).toBeTruthy();
    expect(screen.queryByTestId('current-rep')).toBeNull();
  });
});
