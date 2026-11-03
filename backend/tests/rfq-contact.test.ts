import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seed, SEED_IDS } from '../prisma/seed';
import {
  RFQService,
  RFQValidationError,
  RFQStateMachineError,
  assertLegalTransition,
  canTransitionRFQ,
  generateRFQEmailContent,
  SupplierContactService,
  EmailSupplierContactProvider,
  MockSupplierContactProvider,
  mockSupplierContactProvider,
  SupplierContactError,
  SupplierCandidate,
  SupplierQualificationResult,
  CreateRFQInput,
  createRFQTool,
  sendRFQTool,
} from '../src/discovery/supplier';
import { toolRegistry } from '../src/agent/tools';

function createMockCandidate(overrides: Partial<SupplierCandidate> = {}): SupplierCandidate {
  return {
    id: 'cand_wholesale_99',
    name: 'Sahyadri Agro Direct Depot',
    formattedAddress: 'Plot 10, Industrial Estate, Pune',
    latitude: 18.5204,
    longitude: 73.8567,
    distanceKm: 4.2,
    distanceMeters: 4200,
    categories: ['commercial.wholesale'],
    source: 'geoapify',
    email: 'orders@sahyadriagro.example.com',
    phone: '+91 20 24009988',
    ...overrides,
  };
}

function createQualification(
  status: 'QUALIFIED' | 'REJECTED' | 'REQUIRES_RFQ',
  rejectionReasons: string[] = []
): SupplierQualificationResult {
  const candidate = createMockCandidate();
  return {
    candidateId: candidate.id,
    supplierName: candidate.name,
    status,
    reasons: status === 'REJECTED' ? (rejectionReasons as any) : ['DISTANCE_WITHIN_RADIUS'],
    rejectionReasons: rejectionReasons as any,
    matchedCategories: ['wholesale'],
    distanceKm: candidate.distanceKm,
    contactChannels: {
      phone: candidate.phone,
      email: candidate.email,
      hasViableContact: true,
    },
    source: candidate.source,
    qualifiedAt: new Date(),
    candidate,
  };
}

describe('Milestone 10 Phase 3 — RFQ & Supplier Contact Infrastructure', () => {
  let rfqService: RFQService;
  let mockContact: MockSupplierContactProvider;
  let contactService: SupplierContactService;

  const prisma = new PrismaClient();

  beforeAll(async () => {
    await seed(prisma);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mockContact = new MockSupplierContactProvider();
    contactService = new SupplierContactService();
    contactService.registerProvider(mockContact);
    rfqService = new RFQService(contactService);
  });

  describe('1. RFQ Validation & Privacy Boundary', () => {
    it('1. valid RFQ input passes validation and creates RFQ in READY status', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const quoteDeadline = new Date(now.getTime() + 2 * 3600 * 1000);
      const deliveryDeadline = new Date(now.getTime() + 12 * 3600 * 1000);

      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [
            { productName: 'Sharbati Whole Wheat Atta', quantity: 20, unit: 'KG' },
          ],
          deliveryArea: 'Greenview Residency Community Service Area, Pune',
          quoteDeadline,
          deliveryDeadline,
        },
        undefined,
        now
      );

      expect(rfq.id).toMatch(/^rfq_/);
      expect(rfq.status).toBe('READY');
      expect(rfq.lineItems).toHaveLength(1);
      expect(rfq.lineItems[0].quantity).toBe(20);
      expect(rfq.supplierName).toBe('Sahyadri Agro Direct Depot');
      expect(rfq.recipientContact).toBe('orders@sahyadriagro.example.com');
    });

    it('2. candidate with status REQUIRES_RFQ is permitted to receive an RFQ', async () => {
      const candidate = createMockCandidate();
      const qualification = createQualification('REQUIRES_RFQ');
      const now = new Date();

      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Basmati Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 8 * 3600 * 1000),
        },
        qualification,
        now
      );

      expect(rfq.status).toBe('READY');
    });

    it('3. candidate with status QUALIFIED is permitted to receive an RFQ for quote confirmation', async () => {
      const candidate = createMockCandidate();
      const qualification = createQualification('QUALIFIED');
      const now = new Date();

      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Sunflower Oil', quantity: 5, unit: 'LITRE' }],
          deliveryArea: 'Greenview Residency Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        qualification,
        now
      );

      expect(rfq.status).toBe('READY');
    });

    it('4. candidate with status REJECTED is strictly rejected and CANNOT receive an RFQ', async () => {
      const candidate = createMockCandidate();
      const qualification = createQualification('REJECTED', ['OUTSIDE_RADIUS', 'CATEGORY_MISMATCH']);
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Greenview Residency Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          qualification,
          now
        )
      ).rejects.toMatchObject({
        name: 'RFQValidationError',
        code: 'CANDIDATE_REJECTED',
      });
    });

    it('5. missing supplier candidate fails validation with MISSING_CANDIDATE', async () => {
      const now = new Date();
      await expect(
        rfqService.createRFQ(
          {
            candidate: null as any,
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'MISSING_CANDIDATE' });
    });

    it('6. candidate missing contact channel fails with MISSING_CONTACT_CHANNEL', async () => {
      const candidate = createMockCandidate({ email: undefined, phone: undefined });
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            contactMethod: 'email',
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'MISSING_CONTACT_CHANNEL' });
    });

    it('7. empty line items fails validation with EMPTY_LINE_ITEMS', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'EMPTY_LINE_ITEMS' });
    });

    it('8. zero or negative quantity fails validation with INVALID_QUANTITY', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Wheat', quantity: 0, unit: 'KG' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Wheat', quantity: -5, unit: 'KG' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    });

    it('9. missing product unit fails validation with INVALID_UNIT', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Wheat', quantity: 10, unit: '' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'INVALID_UNIT' });
    });

    it('10. expired delivery deadline fails with INVALID_DELIVERY_DEADLINE', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() - 1000), // Past
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_DEADLINE' });
    });

    it('11. quote deadline after delivery deadline fails with DEADLINE_INCOMPATIBLE', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Service Area',
            quoteDeadline: new Date(now.getTime() + 10 * 3600 * 1000), // 10h
            deliveryDeadline: new Date(now.getTime() + 5 * 3600 * 1000), // 5h (before quote!)
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'DEADLINE_INCOMPATIBLE' });
    });

    it('12. privacy filter rejects resident-specific housing/flat PII in deliveryArea', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      // Flat 402 leaking
      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Flat 402, Greenview Residency',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'PRIVACY_VIOLATION' });

      // Tower A leaking
      await expect(
        rfqService.createRFQ(
          {
            candidate,
            lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
            deliveryArea: 'Tower A, Greenview Residency',
            quoteDeadline: new Date(now.getTime() + 3600 * 1000),
            deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          },
          undefined,
          now
        )
      ).rejects.toMatchObject({ code: 'PRIVACY_VIOLATION' });
    });
  });

  describe('2. RFQ State Machine', () => {
    it('13. valid state transitions succeed deterministically', () => {
      expect(canTransitionRFQ('DRAFT', 'READY')).toBe(true);
      expect(canTransitionRFQ('READY', 'DISPATCHING')).toBe(true);
      expect(canTransitionRFQ('DISPATCHING', 'SENT')).toBe(true);
      expect(canTransitionRFQ('DISPATCHING', 'FAILED')).toBe(true);
      expect(canTransitionRFQ('FAILED', 'DISPATCHING')).toBe(true);
      expect(canTransitionRFQ('READY', 'CANCELLED')).toBe(true);

      // Assert does not throw
      expect(() => assertLegalTransition('READY', 'DISPATCHING')).not.toThrow();
    });

    it('14. invalid state transitions throw RFQStateMachineError', () => {
      expect(canTransitionRFQ('DRAFT', 'SENT')).toBe(false);
      expect(canTransitionRFQ('SENT', 'READY')).toBe(false);
      expect(canTransitionRFQ('CANCELLED', 'READY')).toBe(false);

      expect(() => assertLegalTransition('DRAFT', 'SENT')).toThrow(RFQStateMachineError);
      expect(() => assertLegalTransition('CANCELLED', 'DISPATCHING')).toThrow(RFQStateMachineError);
    });

    it('15. duplicate dispatch with same idempotency key does not recreate or duplicate RFQ', async () => {
      const candidate = createMockCandidate();
      const now = new Date();

      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          idempotencyKey: 'idemp_key_alpha',
        },
        undefined,
        now
      );

      // First dispatch
      const firstRes = await rfqService.sendRFQ(rfq.id, {
        preferredProvider: 'mock',
        idempotencyKey: 'idemp_key_alpha',
      });
      expect(firstRes.status).toBe('SENT');
      expect(firstRes.isDuplicate).toBeFalsy();

      // Second dispatch with same key
      const secondRes = await rfqService.sendRFQ(rfq.id, {
        preferredProvider: 'mock',
        idempotencyKey: 'idemp_key_alpha',
      });
      expect(secondRes.status).toBe('SENT');
      expect(secondRes.isDuplicate).toBe(true);
      // Provider called exactly once
      expect(mockContact.sentDispatches).toHaveLength(1);
    });

    it('16. failed dispatch transitions correctly to FAILED and records reason', async () => {
      mockContact.setMode('error', {
        errorCode: 'PROVIDER_ERROR',
        errorMessage: 'Connection refused by gateway',
      });

      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      await expect(
        rfqService.sendRFQ(rfq.id, { preferredProvider: 'mock' })
      ).rejects.toThrow('Connection refused by gateway');

      const updated = rfqService.getRFQ(rfq.id)!;
      expect(updated.status).toBe('FAILED');
      expect(updated.failureReason).toContain('Connection refused');
    });

    it('17. successful dispatch transitions state to SENT and records sentAt timestamp', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      const res = await rfqService.sendRFQ(rfq.id, { preferredProvider: 'mock' });

      expect(res.status).toBe('SENT');
      expect(res.success).toBe(true);
      expect(res.messageId).toMatch(/^mock_msg_/);

      const updated = rfqService.getRFQ(rfq.id)!;
      expect(updated.status).toBe('SENT');
      expect(updated.sentAt).toBeDefined();
    });
  });

  describe('3. Contact Provider Abstraction & Email (Resend)', () => {
    it('18. mock contact provider succeeds deterministically and records payloads', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Cooking Oil', quantity: 5, unit: 'LITRE' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      const res = await mockContact.sendRFQ({ rfq, idempotencyKey: 'k1' });
      expect(res.success).toBe(true);
      expect(mockContact.sentDispatches).toHaveLength(1);
      expect(mockContact.sentDispatches[0].rfq.id).toBe(rfq.id);
    });

    it('19. missing Resend API key throws MISSING_API_KEY without calling external network', async () => {
      const emailProvider = new EmailSupplierContactProvider({
        apiKey: '',
        fetchFn: vi.fn(),
      });

      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      await expect(
        emailProvider.sendRFQ({ rfq, idempotencyKey: 'k2' })
      ).rejects.toMatchObject({
        name: 'SupplierContactError',
        code: 'MISSING_API_KEY',
      });
    });

    it('20. provider timeout is handled safely with REQUEST_TIMEOUT', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      });

      const emailProvider = new EmailSupplierContactProvider({
        apiKey: 'dummy_key_for_unit_tests',
        fetchFn: mockFetch,
        timeoutMs: 50,
      });

      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      await expect(
        emailProvider.sendRFQ({ rfq, idempotencyKey: 'k3' })
      ).rejects.toMatchObject({
        name: 'SupplierContactError',
        code: 'REQUEST_TIMEOUT',
      });
    });

    it('21. Resend HTTP errors (401, 429, 500) produce structured SupplierContactError', async () => {
      const makeProvider = (status: number, body: unknown) =>
        new EmailSupplierContactProvider({
          apiKey: 'test_key',
          fetchFn: vi.fn().mockResolvedValue({
            ok: false,
            status,
            statusText: 'Error',
            json: async () => body,
            text: async () => JSON.stringify(body),
          } as Response),
        });

      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      // 401 Unauthorized
      await expect(
        makeProvider(401, { message: 'Invalid API key' }).sendRFQ({ rfq, idempotencyKey: 'k4' })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' });

      // 429 Rate Limit
      await expect(
        makeProvider(429, { message: 'Rate limit exceeded' }).sendRFQ({ rfq, idempotencyKey: 'k5' })
      ).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });

      // 500 Server Error
      await expect(
        makeProvider(500, { message: 'Internal error' }).sendRFQ({ rfq, idempotencyKey: 'k6' })
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('22. provider success is required before RFQ status becomes SENT', async () => {
      const mockFetchSuccess = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resend_email_id_7788' }),
      } as Response);

      const resendProvider = new EmailSupplierContactProvider({
        apiKey: 'test_key',
        fetchFn: mockFetchSuccess,
      });

      contactService.registerProvider(resendProvider);

      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Wheat Atta', quantity: 20, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      const res = await rfqService.sendRFQ(rfq.id, { preferredProvider: 'resend' });

      expect(res.status).toBe('SENT');
      expect(res.messageId).toBe('resend_email_id_7788');
      expect(rfqService.getRFQ(rfq.id)!.status).toBe('SENT');
    });
  });

  describe('4. Idempotency & Auditability', () => {
    it('23. same idempotency key produces exactly one external dispatch', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          idempotencyKey: 'fixed_key_100',
        },
        undefined,
        now
      );

      await rfqService.sendRFQ(rfq.id, { preferredProvider: 'mock', idempotencyKey: 'fixed_key_100' });
      await rfqService.sendRFQ(rfq.id, { preferredProvider: 'mock', idempotencyKey: 'fixed_key_100' });

      expect(mockContact.sentDispatches).toHaveLength(1);
    });

    it('24. concurrent duplicate dispatches remain safe and execute provider once', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
          idempotencyKey: 'concurrent_key_200',
        },
        undefined,
        now
      );

      const [res1, res2] = await Promise.all([
        contactService.sendRFQ({ rfq, idempotencyKey: 'concurrent_key_200' }, 'mock'),
        contactService.sendRFQ({ rfq, idempotencyKey: 'concurrent_key_200' }, 'mock'),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(mockContact.sentDispatches).toHaveLength(1);
    });

    it('25. RFQ creation emits RFQ_CREATED and RFQ_VALIDATED audit events', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      const events = rfqService.getRecordedAuditEvents();
      const types = events.map((e) => e.eventType);

      expect(types).toContain('RFQ_CREATED');
      expect(types).toContain('RFQ_VALIDATED');
      expect(events[0].rfqId).toBe(rfq.id);
    });

    it('26. successful dispatch emits RFQ_SENT audit event', async () => {
      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      await rfqService.sendRFQ(rfq.id, { preferredProvider: 'mock' });

      const events = rfqService.getRecordedAuditEvents();
      const types = events.map((e) => e.eventType);

      expect(types).toContain('RFQ_DISPATCH_STARTED');
      expect(types).toContain('RFQ_SENT');
    });

    it('27. failed dispatch emits RFQ_DISPATCH_FAILED audit event', async () => {
      mockContact.setMode('error', { errorCode: 'PROVIDER_ERROR', errorMessage: 'Downstream timeout' });

      const candidate = createMockCandidate();
      const now = new Date();
      const rfq = await rfqService.createRFQ(
        {
          candidate,
          lineItems: [{ productName: 'Rice', quantity: 10, unit: 'KG' }],
          deliveryArea: 'Greenview Residency Community Service Area',
          quoteDeadline: new Date(now.getTime() + 3600 * 1000),
          deliveryDeadline: new Date(now.getTime() + 6 * 3600 * 1000),
        },
        undefined,
        now
      );

      await expect(rfqService.sendRFQ(rfq.id, { preferredProvider: 'mock' })).rejects.toThrow();

      const events = rfqService.getRecordedAuditEvents();
      const types = events.map((e) => e.eventType);

      expect(types).toContain('RFQ_DISPATCH_FAILED');
    });
  });

  describe('5. Professional RFQ Email Content & Privacy Verification', () => {
    it('28. email content generates structured professional text without resident PII', () => {
      const candidate = createMockCandidate();
      const rfq = {
        id: 'rfq_test_001',
        candidateId: candidate.id,
        supplierName: candidate.name,
        candidate,
        contactMethod: 'email' as const,
        recipientContact: 'orders@sahyadriagro.example.com',
        lineItems: [
          { productName: 'Basmati Rice (Extra Long Grain)', quantity: 25, unit: 'KG', specification: 'Premium bulk bag' },
          { productName: 'Sunflower Cooking Oil', quantity: 10, unit: 'LITRE' },
        ],
        deliveryArea: 'Greenview Residency Community Service Area, Pune',
        deliveryDeadline: new Date('2026-10-31T18:00:00Z'),
        quoteDeadline: new Date('2026-10-31T08:00:00Z'),
        status: 'READY' as const,
        idempotencyKey: 'idemp_test_001',
        createdAt: new Date('2026-10-30T21:00:00Z'),
        updatedAt: new Date('2026-10-30T21:00:00Z'),
        dispatchAttempts: 0,
      };

      const email = generateRFQEmailContent(rfq);

      expect(email.subject).toContain('[Relay RFQ]');
      expect(email.subject).toContain('Basmati Rice');
      expect(email.text).toContain('Basmati Rice (Extra Long Grain) — 25 KG');
      expect(email.text).toContain('Greenview Residency Community Service Area');
      expect(email.text).toContain('Unit Price');
      expect(email.text).toContain('Available Quantity');

      // CRITICAL PRIVACY CHECKS:
      // Must NOT contain resident names, flat numbers, or internal pricing
      expect(email.text).not.toContain('Aarav');
      expect(email.text).not.toContain('Flat');
      expect(email.text).not.toContain('Tower');
      expect(email.text).not.toContain('mandate');
      expect(email.text).not.toContain('budget');
      expect(email.html).not.toContain('Flat');
    });

    it('30b. HTML email escapes untrusted product, specification, and supplier text', () => {
      const candidate = createMockCandidate();
      const rfq = {
        id: 'rfq_test_xss',
        candidateId: candidate.id,
        supplierName: 'Evil <img src=x onerror=alert(1)>',
        candidate,
        contactMethod: 'email' as const,
        recipientContact: 'orders@sahyadriagro.example.com',
        lineItems: [
          {
            productName: '<script>alert("rice")</script>',
            quantity: 25,
            unit: 'KG',
            specification: '"><svg onload=alert(2)>',
          },
        ],
        deliveryArea: 'Area <b>bold</b>',
        deliveryDeadline: new Date('2026-10-31T18:00:00Z'),
        quoteDeadline: new Date('2026-10-31T08:00:00Z'),
        status: 'READY' as const,
        idempotencyKey: 'idemp_test_xss',
        createdAt: new Date('2026-10-30T21:00:00Z'),
        updatedAt: new Date('2026-10-30T21:00:00Z'),
        dispatchAttempts: 0,
      };

      const email = generateRFQEmailContent(rfq);

      expect(email.html).not.toContain('<script>');
      expect(email.html).not.toContain('<img src=x');
      expect(email.html).not.toContain('<svg onload');
      expect(email.html).not.toContain('<b>bold</b>');
      expect(email.html).toContain('&lt;script&gt;');
      expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      // Plain-text part keeps the raw values (no HTML context to escape for).
      expect(email.text).toContain('<script>alert("rice")</script>');
    });

    it('29. Mock contact provider and Resend provider implement identical SupplierContactProvider interface', () => {
      const mock = new MockSupplierContactProvider();
      const resend = new EmailSupplierContactProvider({ apiKey: 'key', fetchFn: vi.fn() });

      expect(typeof mock.sendRFQ).toBe('function');
      expect(typeof resend.sendRFQ).toBe('function');
      expect(mock.providerName).toBe('mock');
      expect(resend.providerName).toBe('resend');
    });

    it('30. future contact providers can be substituted cleanly into SupplierContactService', async () => {
      class WhatsAppSupplierContactProvider {
        public readonly providerName = 'whatsapp';
        public async sendRFQ() {
          return {
            success: true,
            messageId: 'wa_msg_123',
            dispatchedAt: new Date(),
            providerName: 'whatsapp',
            recipient: '+91 99999 88888',
          };
        }
      }

      const customService = new SupplierContactService();
      customService.registerProvider(new WhatsAppSupplierContactProvider());

      expect(customService.getProvider('whatsapp').providerName).toBe('whatsapp');
    });
  });

  describe('6. Agent Tool Constrained Execution', () => {
    it('31. createRFQTool binds to a registered supplier and real contact details', async () => {
      expect(toolRegistry.has('createRFQ')).toBe(true);

      const res = await toolRegistry.execute(
        'createRFQ',
        {
          candidateId: SEED_IDS.suppliers.sahyadri,
          // Model-supplied identity is ignored: the registry record is
          // authoritative for name and contact details.
          candidateName: 'Attacker Chosen Name',
          candidateEmail: 'quotes@attacker.example.com',
          items: [
            { productName: 'Wheat Atta', quantity: 20, unit: 'KG' },
          ],
          quoteDeadlineHours: 2,
          deliveryDeadlineHours: 12,
        },
        {
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
        }
      );

      expect(res.success).toBe(true);
      expect(res.rfqId).toMatch(/^rfq_/);
      expect(res.supplierName).toBe('Sahyadri Agro Wholesalers');
      expect(res.status).toBe('READY');
    });

    it('31b. createRFQTool rejects unknown and inactive suppliers fail-closed', async () => {
      await expect(
        toolRegistry.execute(
          'createRFQ',
          {
            candidateId: 'sup_unknown_attacker',
            items: [{ productName: 'Rice', quantity: 15, unit: 'KG' }],
          },
          {
            residentId: SEED_IDS.residents.aarav,
            societyId: SEED_IDS.society.greenview,
          }
        )
      ).rejects.toThrow('Unknown supplier candidate');

      const dormant = await prisma.supplier.create({
        data: {
          name: 'Dormant Supplier',
          contactEmail: 'dormant@example.com',
          contactPhone: '+910000000000',
          address: 'Nowhere',
          city: 'Pune',
          state: 'Maharashtra',
          postalCode: '411001',
          status: 'INACTIVE',
        },
      });
      await expect(
        toolRegistry.execute(
          'createRFQ',
          {
            candidateId: dormant.id,
            items: [{ productName: 'Rice', quantity: 15, unit: 'KG' }],
          },
          {
            residentId: SEED_IDS.residents.aarav,
            societyId: SEED_IDS.society.greenview,
          }
        )
      ).rejects.toThrow('is not ACTIVE');
      await prisma.supplier.delete({ where: { id: dormant.id } });
    });

    it('32. sendRFQTool dispatches RFQ deterministically through tool registry', async () => {
      expect(toolRegistry.has('sendRFQ')).toBe(true);

      // Create an RFQ via createRFQ tool first
      const createRes = await toolRegistry.execute(
        'createRFQ',
        {
          candidateId: SEED_IDS.suppliers.sahyadri,
          items: [{ productName: 'Rice', quantity: 15, unit: 'KG' }],
          quoteDeadlineHours: 2,
          deliveryDeadlineHours: 12,
        },
        {
          residentId: SEED_IDS.residents.aarav,
          societyId: SEED_IDS.society.greenview,
        }
      );

      const res = await toolRegistry.execute(
        'sendRFQ',
        {
          rfqId: createRes.rfqId,
          preferredProvider: 'mock',
        },
        {
          residentId: '22222222-2222-4222-8222-222222222201',
          societyId: '11111111-1111-4111-8111-111111111111',
        }
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe('SENT');
      expect(res.messageId).toMatch(/^mock_msg_/);
    });
  });
});
