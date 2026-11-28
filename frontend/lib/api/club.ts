import { Club } from '@/types';
import { apiRequest } from './client';

export async function getClub(): Promise<Club> {
  return apiRequest<Club>('/club');
}
