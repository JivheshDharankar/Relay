import type { AgentRunResponse, DeliverySnapshot, ReconciliationReport } from '@/types';

/**
 * Raw artifacts of one procurement run. Backend responses stored verbatim;
 * display mapping happens in stageEvidence.ts / runEvidence.ts.
 */

export type RunStatus = 'idle' | 'processing' | 'verifying' | 'complete' | 'failed';

export interface FullCyclePayment {
  success: boolean;
  orderId: string;
  residentOrderStatus: string;
  payment: {
    success: boolean;
    paymentId: string;
    providerReference: string | null;
    status: string;
    amount: number | string;
    currency: string;
    executedAt: string;
    isDuplicate: boolean;
  };
}

export interface FullCycleSupplierPO {
  success: boolean;
  poReference: string | null;
  supplierId: string;
  status: string;
  confirmedDeliveryEta: string | null;
  totalAmount: number | string;
  currency: string;
  isDuplicate: boolean;
}

export interface FullCycleResult {
  success: boolean;
  communityOrderId: string;
  payments: FullCyclePayment[];
  supplierPO: FullCycleSupplierPO | null;
  delivery: DeliverySnapshot | null;
  reconciliation: ReconciliationReport | null;
}

export interface RunError {
  message: string;
  code: string;
  detail?: string;
  timedOut: boolean;
  unauthorized: boolean;
}

export interface ProcurementRun {
  status: RunStatus;
  prompt: string;
  agentResponse: AgentRunResponse | null;
  fullCycle: FullCycleResult | null;
  residentOrderId: string | null;
  communityOrderId: string | null;
  error: RunError | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export const IDLE_RUN: ProcurementRun = {
  status: 'idle',
  prompt: '',
  agentResponse: null,
  fullCycle: null,
  residentOrderId: null,
  communityOrderId: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

export function runIdOf(run: ProcurementRun): string | null {
  return run.agentResponse?.runId ?? null;
}

/**
 * Where a terminal run should be presented: its autonomous run page.
 * Non-terminal runs and runs without a backend ID have no target.
 */
export function terminalTarget(run: ProcurementRun): string | null {
  if (run.status !== 'complete' && run.status !== 'failed') return null;
  const id = runIdOf(run);
  return id ? `/runs/${id}` : null;
}
