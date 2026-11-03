import { apiClient } from './client';
import { AgentRunRequest, AgentRunResponse } from '@/types';

export async function runAgent(payload: AgentRunRequest): Promise<AgentRunResponse> {
  return apiClient<AgentRunResponse>('/api/agent/run', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 120000,
  });
}
