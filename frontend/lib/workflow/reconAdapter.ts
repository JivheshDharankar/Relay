import type { ReconciliationReport } from '@/types';
import type { ReconEvidence } from '@/lib/workflow/runEvidence';

function dec(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Adapts a backend ReconciliationReport (e.g. from POST
 * /api/procurement/reconcile) to the pillar display model. Values pass
 * through verbatim.
 */
export function reconReportToEvidence(report: ReconciliationReport): ReconEvidence {
  const q = report.quantityReconciliation;
  const f = report.financialReconciliation;
  const communityDemand = dec(f.communityTotal) ?? dec(q.communityTotal);
  const residentSum = dec(f.residentSum) ?? dec(q.residentSum);
  return {
    status: report.status,
    isReconciled: report.isReconciled,
    quantity: {
      passed: q.passed,
      community: dec(q.communityTotal),
      residents: dec(q.residentSum),
      difference: dec(q.difference),
    },
    financial: {
      passed: f.passed,
      community: dec(f.communityTotal),
      residents: dec(f.residentSum),
      difference: dec(f.difference),
    },
    productPassed: report.productIntegrity.passed,
    societyPassed: report.societyIntegrity.passed,
    discrepancies: [...report.discrepancies],
    pillars: [
      ...(communityDemand !== null
        ? [{ label: 'Community demand', value: communityDemand, source: 'reconciliation' }]
        : []),
      ...(residentSum !== null
        ? [{ label: 'Resident allocations', value: residentSum, source: 'reconciliation' }]
        : []),
    ],
    source: 'reconcileOrder',
  };
}
