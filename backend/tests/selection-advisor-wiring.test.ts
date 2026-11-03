/**
 * Phase 17.2 Correction 2 — the autonomous executor uses the existing
 * comparator + selection advisor instead of first-eligible.
 *
 * White-box drives WorkflowExecutor.executeSelect with fabricated workflow
 * state plus REAL RFQ/normalization services, asserting the winner follows
 * the intended lowest-cost eligible algorithm under deterministic validation.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { ProductUnit } from '@prisma/client';
import { RFQService } from '../src/discovery/supplier/rfq/RFQService';
import { SupplierResponseService } from '../src/discovery/supplier/quote/provider/SupplierResponseService';
import { QuoteNormalizationService } from '../src/discovery/supplier/quote/QuoteNormalizationService';
import {
  SupplierCandidate,
  Quote,
  selectionValidator,
} from '../src/discovery/supplier';
import { WorkflowExecutor } from '../src/orchestration/WorkflowExecutor';

const PRODUCT = 'maida';
const QUANTITY = 2;

function candidate(i: number): SupplierCandidate {
  return {
    id: `cand_sel_${i}`,
    name: `Selection Supplier ${i}`,
    address: `${i} Audit Market, Pune`,
    latitude: 18.5 + i * 0.001,
    longitude: 73.85 + i * 0.001,
    categories: ['commercial.supermarket'],
    email: `sel${i}@example.com`,
    phone: `+9198765432${10 + i}`,
  };
}

interface QuoteSpec {
  unitPrice: number;
  fee?: number;
  eta?: number;
  quantity?: number;
}

async function buildQuotes(
  services: {
    rfqService: RFQService;
    responseService: SupplierResponseService;
    normalizationService: QuoteNormalizationService;
  },
  specs: QuoteSpec[]
): Promise<{ rfqId: string; quotes: Quote[] }> {
  const now = new Date();
  const quotes: Quote[] = [];
  let rfqId = '';
  for (const [i, spec] of specs.entries()) {
    const cand = candidate(i);
    const rfq = await services.rfqService.createRFQ({
      candidate: cand,
      lineItems: [{ productName: PRODUCT, quantity: QUANTITY, unit: ProductUnit.KG }],
      deliveryArea: 'Greenview Residency Central Depot',
      deliveryDeadline: new Date(now.getTime() + 12 * 3600 * 1000),
      quoteDeadline: new Date(now.getTime() + 4 * 3600 * 1000),
      idempotencyKey: `sel_${randomUUID()}`,
    });
    if (i === 0) rfqId = rfq.id;
    const resp = await services.responseService.ingestResponse({
      rfqId: rfq.id,
      candidateId: cand.id,
      supplierName: cand.name,
      channel: 'manual',
      lineItems: [
        {
          productName: PRODUCT,
          quotedQuantity: spec.quantity ?? QUANTITY,
          unit: ProductUnit.KG,
          unitPrice: spec.unitPrice,
        },
      ],
      deliveryFee: spec.fee ?? 40,
      deliveryEtaHours: spec.eta ?? 6,
    });
    quotes.push((await services.normalizationService.normalizeResponse(resp)).quote);
  }
  return { rfqId, quotes };
}

function freshServices() {
  const rfqService = new RFQService();
  return {
    rfqService,
    responseService: new SupplierResponseService(rfqService),
    normalizationService: new QuoteNormalizationService(),
  };
}

async function runSelect(rfqService: RFQService, rfqId: string, quotes: Quote[]) {
  const executor = new WorkflowExecutor(undefined, undefined, undefined, rfqService);
  const workflow = {
    currentStage: 'NEGOTIATE',
    status: 'NEGOTIATING',
    entities: { rfqId },
    _normalizedQuotes: quotes,
  } as never;
  await (executor as unknown as { executeSelect(w: unknown): Promise<void> }).executeSelect(
    workflow
  );
  return workflow as unknown as {
    status: string;
    currentStage: string;
    failureReason?: string;
    entities: { selectedQuoteId?: string };
    _selectedQuote?: Quote;
  };
}

describe('Phase 17.2 — advisor-wired selection', () => {
  it('1. A later cheaper quote beats the first-qualified expensive quote', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [
      { unitPrice: 100 },
      { unitPrice: 60 },
      { unitPrice: 30 },
    ]);
    expect(quotes[0].total).toBeGreaterThan(quotes[2].total);
    const result = await runSelect(services.rfqService, rfqId, quotes);
    expect(result.currentStage).toBe('SELECT');
    expect(result.entities.selectedQuoteId).toBe(quotes[2].id);
  });

  it('2. Lowest eligible total wins over first position and faster ETA', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [
      { unitPrice: 100, eta: 4 },
      { unitPrice: 30, eta: 6 },
    ]);
    // Price gap (₹140+) far exceeds the advisor's ₹20 fastest-trade-off band.
    const result = await runSelect(services.rfqService, rfqId, quotes);
    expect(result.entities.selectedQuoteId).toBe(quotes[1].id);
  });

  it('3. Ineligible first quote cannot win', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [
      { unitPrice: 10, eta: 20 },
      { unitPrice: 60, eta: 6 },
    ]);
    const result = await runSelect(services.rfqService, rfqId, quotes);
    expect(result.entities.selectedQuoteId).toBe(quotes[1].id);
  });

  it('4. All >12h quotes → BLOCKED (no winner)', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [
      { unitPrice: 10, eta: 20 },
      { unitPrice: 60, eta: 18 },
    ]);
    const result = await runSelect(services.rfqService, rfqId, quotes);
    expect(result.status).toBe('BLOCKED');
    expect(result.failureReason).toMatch(/NO_ELIGIBLE_SELECTION/);
    expect(result.entities.selectedQuoteId).toBeUndefined();
  });

  it('5. Partial-only quotes cannot silently win as single-supplier selection', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [
      { unitPrice: 10, quantity: 1 },
      { unitPrice: 12, quantity: 1 },
    ]);
    const result = await runSelect(services.rfqService, rfqId, quotes);
    // Split-order and reject-all outcomes both fail closed at execution.
    expect(result.status).toBe('BLOCKED');
    expect(result.entities.selectedQuoteId).toBeUndefined();
  });

  it('6. Recommendation for an unknown quote is rejected by the validator', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [{ unitPrice: 30 }]);
    const rfq = services.rfqService.getRFQ(rfqId)!;
    const verdict = selectionValidator.validateRecommendation(
      {
        decision: 'SELECT_SUPPLIER',
        supplierId: 'cand_ghost',
        quoteId: 'quote_ghost',
        reason: 'fabricated probe',
      },
      rfq,
      quotes
    );
    expect(verdict.valid).toBe(false);
  });

  it('7. Validator remains authoritative over tampered eligible-bypass recommendations', async () => {
    const services = freshServices();
    const { rfqId, quotes } = await buildQuotes(services, [
      { unitPrice: 10, eta: 20 },
      { unitPrice: 60, eta: 6 },
    ]);
    const rfq = services.rfqService.getRFQ(rfqId)!;
    // Attempt to force-select the ineligible (SLA-breaching) first quote.
    const verdict = selectionValidator.validateRecommendation(
      {
        decision: 'SELECT_SUPPLIER',
        supplierId: quotes[0].candidateId,
        quoteId: quotes[0].id,
        reason: 'tamper probe',
      },
      rfq,
      quotes
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join(';')).toMatch(/INELIGIBLE_QUOTE|SLA_DEADLINE_EXCEEDED/);
  });
});
