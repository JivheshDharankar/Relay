import { describe, it, expect } from 'vitest';
import {
  DeterministicQualificationService,
  CategoryMappingRegistry,
  SupplierCandidate,
  SupplierQualificationCriteria,
} from '../src/discovery/supplier';

// Helper to create a base valid candidate for testing
function createCandidate(overrides: Partial<SupplierCandidate> = {}): SupplierCandidate {
  return {
    id: 'cand_123',
    name: 'Reliable Wholesale Staples Ltd',
    formattedAddress: 'Plot 42, Market Yard Sector 1',
    latitude: 18.5204,
    longitude: 73.8567,
    distanceKm: 3.5,
    distanceMeters: 3500,
    categories: ['commercial.wholesale', 'commercial.food_and_drink'],
    source: 'geoapify',
    phone: '+91 20 24001122',
    email: 'sales@reliablestaples.example.com',
    website: 'https://reliablestaples.example.com',
    ...overrides,
  };
}

describe('Milestone 10 Phase 2 — Deterministic Supplier Qualification', () => {
  const service = new DeterministicQualificationService();

  describe('1. Location & Geographic Rules', () => {
    it('1. candidate inside radius passes geographic check with DISTANCE_WITHIN_RADIUS', () => {
      const candidate = createCandidate({ distanceMeters: 4500 });
      const criteria: SupplierQualificationCriteria = { maxRadiusMeters: 5000 };

      const result = service.qualifyCandidate(candidate, criteria);

      expect(result.reasons).toContain('DISTANCE_WITHIN_RADIUS');
      expect(result.rejectionReasons).not.toContain('OUTSIDE_RADIUS');
      expect(result.status).not.toBe('REJECTED');
    });

    it('2. candidate outside radius is rejected with OUTSIDE_RADIUS', () => {
      const candidate = createCandidate({ distanceMeters: 8500 });
      const criteria: SupplierQualificationCriteria = { maxRadiusMeters: 5000 };

      const result = service.qualifyCandidate(candidate, criteria);

      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReasons).toContain('OUTSIDE_RADIUS');
      expect(result.reasons).toContain('OUTSIDE_RADIUS');
    });

    it('3. exact boundary behavior is deterministic (distanceMeters === maxRadiusMeters passes)', () => {
      const candidate = createCandidate({ distanceMeters: 5000 });
      const criteria: SupplierQualificationCriteria = { maxRadiusMeters: 5000 };

      const result = service.qualifyCandidate(candidate, criteria);

      expect(result.reasons).toContain('DISTANCE_WITHIN_RADIUS');
      expect(result.rejectionReasons).not.toContain('OUTSIDE_RADIUS');
    });

    it('4. invalid candidate coordinates are rejected safely with INVALID_COORDINATES', () => {
      const invalidLat = createCandidate({ latitude: 95.0 });
      const resLat = service.qualifyCandidate(invalidLat, {});
      expect(resLat.status).toBe('REJECTED');
      expect(resLat.rejectionReasons).toContain('INVALID_COORDINATES');

      const nanLon = createCandidate({ longitude: NaN });
      const resLon = service.qualifyCandidate(nanLon, {});
      expect(resLon.status).toBe('REJECTED');
      expect(resLon.rejectionReasons).toContain('INVALID_COORDINATES');
    });

    it('5. invalid distance is rejected safely with INVALID_DISTANCE', () => {
      const negDist = createCandidate({ distanceMeters: -100 });
      const resNeg = service.qualifyCandidate(negDist, {});
      expect(resNeg.status).toBe('REJECTED');
      expect(resNeg.rejectionReasons).toContain('INVALID_DISTANCE');

      const nanDist = createCandidate({ distanceMeters: NaN });
      const resNan = service.qualifyCandidate(nanDist, {});
      expect(resNan.status).toBe('REJECTED');
      expect(resNan.rejectionReasons).toContain('INVALID_DISTANCE');
    });
  });

  describe('2. Category & Product Relevance Rules', () => {
    it('6. relevant category is eligible with CATEGORY_MATCH', () => {
      const candidate = createCandidate({
        categories: ['commercial.supermarket', 'commercial.wholesale'],
      });
      const criteria: SupplierQualificationCriteria = {
        productName: 'Basmati Rice',
        procurementCategory: 'Grains & Staples',
      };

      const result = service.qualifyCandidate(candidate, criteria);

      expect(result.reasons).toContain('CATEGORY_MATCH');
      expect(result.matchedCategories).toContain('wholesale');
      expect(result.rejectionReasons).not.toContain('CATEGORY_MISMATCH');
    });

    it('7. clearly irrelevant category is rejected with CATEGORY_MISMATCH', () => {
      const cinema = createCandidate({
        categories: ['entertainment.cinema', 'leisure.movie_theater'],
      });
      const criteria: SupplierQualificationCriteria = {
        productName: 'Sunflower Cooking Oil',
        procurementCategory: 'Oils & Ghee',
      };

      const result = service.qualifyCandidate(cinema, criteria);

      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReasons).toContain('CATEGORY_MISMATCH');
    });

    it('8. unknown or generic category information results in REQUIRES_RFQ (CATEGORY_UNKNOWN)', () => {
      const genericCandidate = createCandidate({
        categories: ['commercial'], // Only generic uninformative tag
      });
      const criteria: SupplierQualificationCriteria = {
        productName: 'Eco Clean Laundry Detergent Powder',
        procurementCategory: 'Household Cleaning',
      };

      const result = service.qualifyCandidate(genericCandidate, criteria);

      expect(result.status).toBe('REQUIRES_RFQ');
      expect(result.reasons).toContain('CATEGORY_UNKNOWN');
      expect(result.rejectionReasons).not.toContain('CATEGORY_MISMATCH');
    });

    it('9. multiple categories are handled correctly and extract matching tokens', () => {
      const mixed = createCandidate({
        categories: ['service.courier', 'commercial.wholesale', 'office.logistics'],
      });
      const criteria: SupplierQualificationCriteria = {
        productName: 'Sharbati Whole Wheat Atta',
      };

      const result = service.qualifyCandidate(mixed, criteria);

      expect(result.reasons).toContain('CATEGORY_MATCH');
      expect(result.matchedCategories).toContain('wholesale');
      expect(result.status).not.toBe('REJECTED');
    });
  });

  describe('3. Contactability Rules', () => {
    it('10. phone available satisfies contactability with CONTACT_METHOD_AVAILABLE', () => {
      const candidate = createCandidate({
        phone: '+91 98765 43210',
        email: undefined,
        website: undefined,
      });

      const result = service.qualifyCandidate(candidate, {});

      expect(result.reasons).toContain('CONTACT_METHOD_AVAILABLE');
      expect(result.contactChannels.phone).toBe('+91 98765 43210');
      expect(result.contactChannels.hasViableContact).toBe(true);
    });

    it('11. email available satisfies contactability with CONTACT_METHOD_AVAILABLE', () => {
      const candidate = createCandidate({
        phone: undefined,
        email: 'orders@wholesaler.com',
        website: undefined,
      });

      const result = service.qualifyCandidate(candidate, {});

      expect(result.reasons).toContain('CONTACT_METHOD_AVAILABLE');
      expect(result.contactChannels.email).toBe('orders@wholesaler.com');
      expect(result.contactChannels.hasViableContact).toBe(true);
    });

    it('12. website available satisfies contactability with CONTACT_METHOD_AVAILABLE', () => {
      const candidate = createCandidate({
        phone: undefined,
        email: undefined,
        website: 'https://wholesale-direct.in',
      });

      const result = service.qualifyCandidate(candidate, {});

      expect(result.reasons).toContain('CONTACT_METHOD_AVAILABLE');
      expect(result.contactChannels.website).toBe('https://wholesale-direct.in');
      expect(result.contactChannels.hasViableContact).toBe(true);
    });

    it('13. no contact method emits NO_CONTACT_METHOD and requires RFQ verification', () => {
      const noContactCandidate = createCandidate({
        phone: undefined,
        email: undefined,
        website: undefined,
      });

      const result = service.qualifyCandidate(noContactCandidate, {});

      expect(result.reasons).toContain('NO_CONTACT_METHOD');
      expect(result.contactChannels.hasViableContact).toBe(false);
      // Missing contact method does not silently qualify or reject; it requires RFQ contact discovery
      expect(result.status).toBe('REQUIRES_RFQ');
    });
  });

  describe('4. SLA & Delivery Rules', () => {
    it('14. known impossible SLA is rejected with SLA_IMPOSSIBLE', () => {
      // Negative SLA requested
      const candidate = createCandidate();
      const resZeroSla = service.qualifyCandidate(candidate, { maxSlaHours: 0 });
      expect(resZeroSla.status).toBe('REJECTED');
      expect(resZeroSla.rejectionReasons).toContain('SLA_IMPOSSIBLE');

      // Delivery deadline already in the past
      const pastDeadline = new Date(Date.now() - 3600 * 1000);
      const resPast = service.qualifyCandidate(candidate, {
        deliveryDeadline: pastDeadline,
        referenceTime: new Date(),
      });
      expect(resPast.status).toBe('REJECTED');
      expect(resPast.rejectionReasons).toContain('SLA_IMPOSSIBLE');

      // Known partner turnaround exceeds SLA
      const resExceed = service.qualifyCandidate(candidate, {
        maxSlaHours: 6,
        verifiedDeliveryHours: 14,
      });
      expect(resExceed.status).toBe('REJECTED');
      expect(resExceed.rejectionReasons).toContain('SLA_IMPOSSIBLE');
    });

    it('15. unknown delivery capability yields REQUIRES_RFQ, never falsely QUALIFIED', () => {
      const candidate = createCandidate();
      // No verified delivery hours provided (raw discovered candidate)
      const result = service.qualifyCandidate(candidate, { maxSlaHours: 12 });

      expect(result.status).toBe('REQUIRES_RFQ');
      expect(result.reasons).toContain('DELIVERY_CAPABILITY_UNKNOWN');
      expect(result.rejectionReasons).toHaveLength(0);
    });

    it('16. does NOT infer delivery time from distance alone (short distance is still unknown)', () => {
      // Even if candidate is 200m away, Relay does NOT invent a delivery time
      const candidate = createCandidate({ distanceMeters: 200, distanceKm: 0.2 });
      const result = service.qualifyCandidate(candidate, {});

      expect(result.reasons).toContain('DELIVERY_CAPABILITY_UNKNOWN');
      expect(result.status).toBe('REQUIRES_RFQ');
    });
  });

  describe('5. General Architectural Invariants', () => {
    it('17. Geoapify candidate is qualified without Geoapify-specific logic in the qualification engine', () => {
      const geoapifyCandidate = createCandidate({ source: 'geoapify' });
      const result = service.qualifyCandidate(geoapifyCandidate, {
        productName: 'Cooking Oil',
      });

      expect(result.source).toBe('geoapify');
      expect(result.status).toBe('REQUIRES_RFQ');
    });

    it('18. Mock candidate follows the exact same qualification path', () => {
      const mockCandidate = createCandidate({
        id: 'mock_sup_1',
        source: 'mock',
        name: 'Local Agro Wholesale Direct',
      });
      const result = service.qualifyCandidate(mockCandidate, {
        productName: 'Wheat',
      });

      expect(result.source).toBe('mock');
      expect(result.status).toBe('REQUIRES_RFQ');
    });

    it('19. qualification reasons are deterministic and reproducible', () => {
      const candidate = createCandidate();
      const criteria: SupplierQualificationCriteria = {
        maxRadiusMeters: 8000,
        productName: 'Basmati Rice',
        referenceTime: new Date('2026-10-30T12:00:00Z'),
      };

      const result1 = service.qualifyCandidate(candidate, criteria);
      const result2 = service.qualifyCandidate(candidate, criteria);

      expect(result1.status).toBe(result2.status);
      expect(result1.reasons).toEqual(result2.reasons);
      expect(result1.rejectionReasons).toEqual(result2.rejectionReasons);
    });

    it('20. qualification produces no fake supplier data (preserves original candidate)', () => {
      const original = createCandidate({ name: 'Real Local Wholesaler', phone: '+91 9988776655' });
      const result = service.qualifyCandidate(original, {});

      expect(result.supplierName).toBe('Real Local Wholesaler');
      expect(result.contactChannels.phone).toBe('+91 9988776655');
      expect(result.candidate).toBe(original);
    });

    it('21. fully verified candidate achieves QUALIFIED status', () => {
      const candidate = createCandidate({
        distanceMeters: 3000,
        categories: ['commercial.wholesale'],
        phone: '+91 20 12345678',
      });
      const criteria: SupplierQualificationCriteria = {
        productName: 'Rice',
        maxRadiusMeters: 5000,
        maxSlaHours: 12,
        verifiedDeliveryHours: 6, // Verified turnaround within SLA
      };

      const result = service.qualifyCandidate(candidate, criteria);

      expect(result.status).toBe('QUALIFIED');
      expect(result.rejectionReasons).toHaveLength(0);
      expect(result.reasons).toContain('DISTANCE_WITHIN_RADIUS');
      expect(result.reasons).toContain('CATEGORY_MATCH');
      expect(result.reasons).toContain('CONTACT_METHOD_AVAILABLE');
      expect(result.reasons).toContain('SLA_FEASIBLE');
    });

    it('22. batch qualification and helper filters partition results accurately', () => {
      const qualified = createCandidate({
        id: 'c1',
        distanceMeters: 2000,
        categories: ['commercial.wholesale'],
      });
      const requiresRfq = createCandidate({
        id: 'c2',
        distanceMeters: 3000,
        categories: ['commercial.supermarket'],
      });
      const rejected = createCandidate({
        id: 'c3',
        distanceMeters: 25000, // Outside radius
        categories: ['commercial.wholesale'],
      });

      const criteria: SupplierQualificationCriteria = {
        maxRadiusMeters: 5000,
        verifiedDeliveryHours: 6,
      };

      // Set c2 to have no verified delivery hours so it requires RFQ
      const resQualified = service.qualifyCandidate(qualified, criteria);
      const resRequiresRfq = service.qualifyCandidate(requiresRfq, {
        maxRadiusMeters: 5000,
        // no verified delivery hours -> REQUIRES_RFQ
      });
      const resRejected = service.qualifyCandidate(rejected, criteria);

      const all = [resQualified, resRequiresRfq, resRejected];

      expect(service.filterQualified(all).map((s) => s.candidateId)).toEqual(['c1']);
      expect(service.filterRequiresRfq(all).map((s) => s.candidateId)).toEqual(['c2']);
      expect(service.filterRejected(all).map((s) => s.candidateId)).toEqual(['c3']);
    });

    it('23. operates location-agnostically across global coordinates (Pune, Bangalore, London, Tokyo)', () => {
      const locations = [
        { lat: 18.5204, lon: 73.8567, city: 'Pune' },
        { lat: 12.9716, lon: 77.5946, city: 'Bangalore' },
        { lat: 51.5074, lon: -0.1278, city: 'London' },
        { lat: 35.6762, lon: 139.6503, city: 'Tokyo' },
      ];

      for (const loc of locations) {
        const candidate = createCandidate({
          latitude: loc.lat,
          longitude: loc.lon,
          distanceMeters: 2500,
        });

        const result = service.qualifyCandidate(candidate, { maxRadiusMeters: 5000 });
        expect(result.status).toBe('REQUIRES_RFQ');
        expect(result.reasons).toContain('DISTANCE_WITHIN_RADIUS');
      }
    });

    it('24. CategoryMappingRegistry supports clean custom extensions', () => {
      CategoryMappingRegistry.register('artisanal cheese', {
        relevantTokens: ['fromagerie', 'dairy', 'cheese', 'gourmet'],
        incompatibleTokens: ['restaurant', 'bar'],
      });

      const dairy = createCandidate({
        categories: ['specialty.fromagerie', 'commercial.dairy'],
      });

      const result = service.qualifyCandidate(dairy, {
        productName: 'Artisanal Cheese',
      });

      expect(result.reasons).toContain('CATEGORY_MATCH');
      expect(result.matchedCategories).toContain('fromagerie');
    });
  });
});

