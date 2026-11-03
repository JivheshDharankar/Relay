import { describe, expect, it } from 'vitest';
import { reconReportToEvidence } from '@/lib/workflow/reconAdapter';
import type { ReconciliationReport } from '@/types';

function report(): ReconciliationReport {
  return {
    communityOrderId: 'c1',
    status: 'RECONCILED',
    isReconciled: true,
    quantityReconciliation: { passed: true, communityTotal: '4', residentSum: '4', difference: '0' },
    financialReconciliation: {
      passed: true,
      communityTotal: '1234.50',
      residentSum: '1234.50',
      difference: '0.00',
    },
    productIntegrity: { passed: true, discrepancies: [] },
    societyIntegrity: { passed: true, societyId: 'soc-1' },
    discrepancies: [],
  };
}

describe('reconReportToEvidence', () => {
  it('passes backend values through verbatim', () => {
    const ev = reconReportToEvidence(report());
    expect(ev.isReconciled).toBe(true);
    expect(ev.financial.community).toBe('1234.50');
    expect(ev.financial.residents).toBe('1234.50');
    expect(ev.financial.difference).toBe('0.00');
    expect(ev.quantity.difference).toBe('0');
    expect(ev.productPassed).toBe(true);
    expect(ev.societyPassed).toBe(true);
  });

  it('builds pillar display entries from authoritative totals', () => {
    const ev = reconReportToEvidence(report());
    expect(ev.pillars.map((p) => p.label)).toEqual(['Community demand', 'Resident allocations']);
    expect(ev.source).toBe('reconcileOrder');
  });
});
