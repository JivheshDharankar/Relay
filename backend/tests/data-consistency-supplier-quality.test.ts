import { describe, it, expect } from 'vitest';
import { DeterministicQualificationService } from '../src/discovery/supplier/qualification/DeterministicQualificationService';
import { SupplierCandidate } from '../src/discovery/supplier/types';
import { WorkflowExecutor } from '../src/orchestration/WorkflowExecutor';
import { SEED_IDS } from '../src/config/seedConstants';

describe('Data Consistency Phase 4: Supplier Discovery Quality & Qualification', () => {
  const qualificationService = new DeterministicQualificationService();
  const executor = new WorkflowExecutor();

  const mockNonGroceryCandidates: SupplierCandidate[] = [
    {
      id: 'poi_1',
      name: 'Department of Computer Science & Engineering',
      latitude: 18.5204,
      longitude: 73.8567,
      distanceMeters: 500,
      distanceKm: 0.5,
      categories: ['education.university', 'amenity'],
    },
    {
      id: 'poi_2',
      name: 'COEP Hostel Canteen',
      latitude: 18.521,
      longitude: 73.857,
      distanceMeters: 700,
      distanceKm: 0.7,
      categories: ['catering.cafe', 'amenity'],
    },
    {
      id: 'poi_3',
      name: 'Seoul Beats K-Pop Fan Store',
      latitude: 18.522,
      longitude: 73.858,
      distanceMeters: 900,
      distanceKm: 0.9,
      categories: ['commercial.clothing', 'entertainment'],
    },
    {
      id: 'poi_4',
      name: 'City Care Hospital & Pharmacy',
      latitude: 18.523,
      longitude: 73.859,
      distanceMeters: 1100,
      distanceKm: 1.1,
      categories: ['healthcare.hospital', 'healthcare.pharmacy'],
    },
  ];

  const mockValidGroceryCandidate: SupplierCandidate = {
    id: 'poi_valid',
    name: 'Nature Fresh Supermarket & Groceries',
    latitude: 18.524,
    longitude: 73.86,
    distanceMeters: 1200,
    distanceKm: 1.2,
    categories: ['commercial.supermarket', 'commercial.marketplace'],
    phone: '+91 20 25559999',
  };

  it('1. rejects non-grocery establishments based on name keywords and incompatible categories', () => {
    for (const nonGrocery of mockNonGroceryCandidates) {
      const result = qualificationService.qualifyCandidate(nonGrocery, {
        productName: 'Rice (Sona Masoori)',
        procurementCategory: 'grains & staples',
      });
      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReasons).toContain('CATEGORY_MISMATCH');
    }
  });

  it('2. qualifies legitimate grocery/supermarket candidates', () => {
    const result = qualificationService.qualifyCandidate(mockValidGroceryCandidate, {
      productName: 'Rice (Sona Masoori)',
      procurementCategory: 'grains & staples',
    });
    expect(['QUALIFIED', 'REQUIRES_RFQ']).toContain(result.status);
    expect(result.rejectionReasons.length).toBe(0);
  });

  it('3. falls back to verified catalog suppliers when fewer than 2 qualify from discovery', async () => {
    // Construct a synthetic workflow state at stage DISCOVER where only 1 candidate was discovered
    const workflow: any = {
      id: 'wf_test_qualify',
      currentStage: 'DISCOVER',
      status: 'DISCOVERING_SUPPLIERS',
      location: {
        latitude: 18.5204,
        longitude: 73.8567,
        address: 'Flat 402, Greenview Residency, Pune',
      },
      intent: {
        productName: 'Rice (Sona Masoori)',
        quantity: 2,
        unit: 'kg',
      },
      entities: {},
      _discoveredCandidates: [mockValidGroceryCandidate, ...mockNonGroceryCandidates],
    };

    // Transition to QUALIFY
    await (executor as any).executeQualify(workflow);

    expect(workflow.currentStage).toBe('QUALIFY');
    const qualified: SupplierCandidate[] = workflow._qualifiedCandidates;

    // Must have at least 2 qualified suppliers
    expect(qualified.length).toBeGreaterThanOrEqual(2);

    // NONE of the disqualified POIs should be promoted
    for (const nonGrocery of mockNonGroceryCandidates) {
      expect(qualified.some((q) => q.id === nonGrocery.id)).toBe(false);
    }

    // Must include the valid discovered candidate and fallback to verified catalog supplier
    expect(qualified.some((q) => q.id === mockValidGroceryCandidate.id)).toBe(true);
    expect(
      qualified.some(
        (q) =>
          q.id === SEED_IDS.suppliers.sahyadri ||
          q.id === SEED_IDS.suppliers.deccan ||
          q.id === SEED_IDS.suppliers.puneBulk
      )
    ).toBe(true);
  });
});
