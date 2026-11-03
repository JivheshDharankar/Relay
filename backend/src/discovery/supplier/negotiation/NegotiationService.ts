import { randomUUID } from 'crypto';
import { env } from '../../../config/env';
import { eventBus } from '../../../events';
import { SupplierContactService, supplierContactService } from '../rfq/contact/SupplierContactService';
import { RFQService, rfqService } from '../rfq/RFQService';
import { QuoteNormalizationService, quoteNormalizationService } from '../quote/QuoteNormalizationService';
import { IngestResponseInput } from '../quote/provider/types';
import { SupplierResponseService } from '../quote/provider/SupplierResponseService';
import { Quote } from '../quote/types';
import { QuoteComparisonService, quoteComparisonService } from './QuoteComparisonService';
import { DeterministicNegotiationValidator, deterministicNegotiationValidator } from './DeterministicNegotiationValidator';
import { NegotiationAIAdvisor, negotiationAIAdvisor } from './NegotiationAIAdvisor';
import { NegotiationMessageBuilder, negotiationMessageBuilder } from './NegotiationMessageBuilder';
import { assertLegalNegotiationTransition } from './stateMachine';
import {
  Negotiation,
  NegotiationPolicy,
  NegotiationProposal,
  NegotiationRequestedChanges,
  NegotiationRound,
  NegotiationStrategy,
  NegotiationTermsSnapshot,
  QuoteFactualComparison,
} from './types';
import { NegotiationDispatchResponse } from '../rfq/contact/types';

export interface StartNegotiationInput {
  rfqId: string;
  quoteId: string;
  candidateId?: string;
  maxRounds?: number;
  idempotencyKey?: string;
}

export interface CreateProposalInput {
  negotiationId: string;
  strategy: NegotiationStrategy;
  requestedChanges: NegotiationRequestedChanges;
  rationale: string;
  expectedBenefit: string;
  supplierFacingMessage?: string;
  idempotencyKey?: string;
}

export interface ProcessCounterofferInput {
  negotiationId: string;
  responseInput: IngestResponseInput;
  supplierResponseService?: SupplierResponseService;
}

export class NegotiationValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Negotiation proposal validation failed: ${errors.join('; ')}`);
    this.name = 'NegotiationValidationError';
  }
}

export class NegotiationService {
  private negotiations = new Map<string, Negotiation>();
  private negotiationsByRfq = new Map<string, Negotiation[]>();
  private proposals = new Map<string, NegotiationProposal>();
  private idempotencyStore = new Map<string, NegotiationProposal | Negotiation>();
  private inFlightNegotiations = new Map<string, Promise<unknown>>();

  private readonly policy: NegotiationPolicy;

  constructor(
    private readonly quoteService: QuoteNormalizationService = quoteNormalizationService,
    private readonly rfqSvc: RFQService = rfqService,
    private readonly contactService: SupplierContactService = supplierContactService,
    private readonly comparisonService: QuoteComparisonService = quoteComparisonService,
    private readonly validator: DeterministicNegotiationValidator = deterministicNegotiationValidator,
    private readonly advisor: NegotiationAIAdvisor = negotiationAIAdvisor,
    private readonly messageBuilder: NegotiationMessageBuilder = negotiationMessageBuilder,
    customPolicy?: Partial<NegotiationPolicy>
  ) {
    this.policy = {
      maxRounds: customPolicy?.maxRounds ?? (env.MAX_NEGOTIATION_ROUNDS || 3),
      minPriceImprovementPercent:
        customPolicy?.minPriceImprovementPercent ?? (env.MIN_PRICE_IMPROVEMENT_PERCENT || 1),
      minPriceImprovementAbsolute: customPolicy?.minPriceImprovementAbsolute ?? 5,
      minDeliveryHoursImprovement: customPolicy?.minDeliveryHoursImprovement ?? 1,
      maxDiscountPercent: customPolicy?.maxDiscountPercent ?? 35,
    };
  }

  public getPolicy(): NegotiationPolicy {
    return { ...this.policy };
  }

  /**
   * Initializes a new negotiation tracking aggregate for an RFQ and Quote.
   */
  public async startNegotiation(input: StartNegotiationInput): Promise<Negotiation> {
    const dedupeKey = input.idempotencyKey || `nego_start_${input.rfqId}_${input.quoteId}`;
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey) as Negotiation;
    }

    // 1. Verify RFQ
    const rfq = this.rfqSvc.getRFQ(input.rfqId);
    if (!rfq) {
      throw new Error(`RFQ '${input.rfqId}' not found`);
    }
    if (rfq.status === 'CANCELLED' || rfq.status === 'EXPIRED') {
      throw new Error(`Cannot start negotiation: RFQ is in '${rfq.status}' status`);
    }

    // 2. Verify Quote
    const quote = this.quoteService.getQuote(input.quoteId);
    if (!quote) {
      throw new Error(`Quote '${input.quoteId}' not found`);
    }
    if (
      quote.status === 'INVALID' ||
      quote.status === 'EXPIRED' ||
      quote.validUntil.getTime() <= Date.now()
    ) {
      throw new Error(`Cannot start negotiation: Quote has expired or is in '${quote.status}' status`);
    }

    const candidateId = input.candidateId || quote.candidateId;
    const negotiationId = `nego_${randomUUID().slice(0, 8)}`;
    const now = new Date();

    const negotiation: Negotiation = {
      id: negotiationId,
      rfqId: input.rfqId,
      candidateId,
      supplierName: quote.supplierName,
      initialQuoteId: quote.id,
      currentQuoteId: quote.id,
      currentBestQuoteId: quote.id,
      status: 'READY',
      currentRoundNumber: 0,
      maxRounds: input.maxRounds ?? this.policy.maxRounds,
      rounds: [],
      idempotencyKey: dedupeKey,
      createdAt: now,
      updatedAt: now,
    };

    this.negotiations.set(negotiationId, negotiation);
    this.idempotencyStore.set(dedupeKey, negotiation);

    const existingList = this.negotiationsByRfq.get(input.rfqId) || [];
    this.negotiationsByRfq.set(input.rfqId, [...existingList, negotiation]);

    this.emitAudit('NEGOTIATION_STARTED', negotiationId, {
      rfqId: negotiation.rfqId,
      quoteId: quote.id,
      candidateId: quote.candidateId,
      maxRounds: negotiation.maxRounds,
    });

    return negotiation;
  }

  /**
   * Deterministically validates and creates a negotiation proposal for the next round.
   */
  public async createProposal(input: CreateProposalInput): Promise<NegotiationProposal> {
    const negotiation = this.negotiations.get(input.negotiationId);
    if (!negotiation) {
      throw new Error(`Negotiation '${input.negotiationId}' not found`);
    }

    const nextRoundNumber = negotiation.currentRoundNumber + 1;
    const dedupeKey =
      input.idempotencyKey || `nego_prop_${input.negotiationId}_round_${nextRoundNumber}`;

    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey) as NegotiationProposal;
    }

    // Check round limits deterministically
    if (nextRoundNumber > negotiation.maxRounds) {
      assertLegalNegotiationTransition(negotiation.status, 'STOPPED');
      negotiation.status = 'STOPPED';
      negotiation.stopReason = 'MAX_ROUNDS_REACHED';
      this.emitAudit('NEGOTIATION_STOPPED', negotiation.id, {
        reason: 'MAX_ROUNDS_REACHED',
        round: negotiation.currentRoundNumber,
      });
      throw new Error(`Maximum negotiation rounds (${negotiation.maxRounds}) reached`);
    }

    assertLegalNegotiationTransition(negotiation.status, 'PROPOSED');

    const rfq = this.rfqSvc.getRFQ(negotiation.rfqId)!;
    const currentQuote = this.quoteService.getQuote(negotiation.currentQuoteId)!;

    // Snapshot current verified terms
    const currentTerms: NegotiationTermsSnapshot = {
      unitPrice: currentQuote.lineItems[0]?.unitPrice ?? currentQuote.total,
      deliveryFee: currentQuote.deliveryFee,
      tax: currentQuote.tax,
      otherCharges: currentQuote.otherCharges,
      total: currentQuote.total,
      deliveryEtaHours: currentQuote.deliveryEtaHours,
      confirmedDeliveryEta: currentQuote.confirmedDeliveryEta,
      availableQuantity: currentQuote.lineItems.reduce(
        (acc, li) => acc + li.quotedQuantity,
        0
      ),
      lineItems: currentQuote.lineItems.map((li) => ({
        productName: li.productName,
        unitPrice: li.unitPrice,
        quotedQuantity: li.quotedQuantity,
        requestedQuantity: li.requestedQuantity,
        isPartial: li.isPartial,
        lineSubtotal: li.lineSubtotal,
      })),
    };

    const proposalId = `prop_${randomUUID().slice(0, 8)}`;

    const supplierFacingMessage =
      input.supplierFacingMessage ||
      this.messageBuilder.buildSupplierMessage(currentQuote, {
        rfqId: rfq.id,
        quoteId: currentQuote.id,
        roundNumber: nextRoundNumber,
        requestedChanges: input.requestedChanges,
      });

    const proposal: NegotiationProposal = {
      id: proposalId,
      negotiationId: negotiation.id,
      rfqId: negotiation.rfqId,
      candidateId: negotiation.candidateId,
      quoteId: currentQuote.id,
      roundNumber: nextRoundNumber,
      strategy: input.strategy,
      currentTerms,
      requestedChanges: input.requestedChanges,
      rationale: input.rationale,
      expectedBenefit: input.expectedBenefit,
      supplierFacingMessage,
      status: 'DRAFT',
      createdAt: new Date(),
    };

    // Get competitor candidates to verify confidentiality
    const competitorCandidates = this.rfqSvc
      .listRFQs()
      .filter(
        (r) =>
          r.id !== rfq.id &&
          r.candidateId !== rfq.candidateId &&
          r.supplierName.toLowerCase() !== rfq.supplierName.toLowerCase()
      )
      .map((r) => r.supplierName);

    // Deterministic validation
    const validationResult = this.validator.validateProposal(
      proposal,
      rfq,
      currentQuote,
      this.policy,
      competitorCandidates
    );

    if (!validationResult.valid) {
      proposal.status = 'REJECTED';
      proposal.validationErrors = validationResult.errors;
      this.emitAudit('NEGOTIATION_FAILED', negotiation.id, {
        errors: validationResult.errors,
      });
      throw new NegotiationValidationError(validationResult.errors);
    }

    proposal.status = 'VALIDATED';
    negotiation.status = 'PROPOSED';
    negotiation.currentRoundNumber = nextRoundNumber;
    negotiation.updatedAt = new Date();

    const round: NegotiationRound = {
      roundNumber: nextRoundNumber,
      proposal,
      supplierResponseStatus: 'PENDING',
    };
    negotiation.rounds.push(round);

    this.proposals.set(proposalId, proposal);
    this.idempotencyStore.set(dedupeKey, proposal);

    this.emitAudit('NEGOTIATION_PROPOSAL_CREATED', negotiation.id, {
      proposalId,
      roundNumber: nextRoundNumber,
      strategy: proposal.strategy,
    });
    this.emitAudit('NEGOTIATION_VALIDATED', negotiation.id, {
      proposalId,
      roundNumber: nextRoundNumber,
    });

    return proposal;
  }

  /**
   * Dispatches the validated negotiation proposal to the supplier via the SupplierContactService.
   */
  public async sendProposal(
    proposalId: string,
    preferredProvider?: string
  ): Promise<NegotiationDispatchResponse> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal '${proposalId}' not found`);
    }

    const negotiation = this.negotiations.get(proposal.negotiationId);
    if (!negotiation) {
      throw new Error(`Negotiation '${proposal.negotiationId}' not found`);
    }

    const dedupeKey = `dispatch_${proposalId}`;
    if (this.inFlightNegotiations.has(dedupeKey)) {
      return (await this.inFlightNegotiations.get(dedupeKey)) as NegotiationDispatchResponse;
    }

    const rfq = this.rfqSvc.getRFQ(proposal.rfqId)!;
    const recipientEmail = rfq.recipientContact || rfq.candidate.email;

    // Idempotency: If already dispatched, return duplicate response without re-sending
    if (proposal.status === 'DISPATCHED') {
      const currentRound = negotiation.rounds.find((r) => r.roundNumber === proposal.roundNumber);
      return {
        success: true,
        messageId: currentRound?.dispatchMessageId || `msg_${proposal.id}`,
        dispatchedAt: proposal.dispatchedAt || new Date(),
        providerName: 'mock',
        recipient: recipientEmail || 'mock-recipient',
        isDuplicate: true,
      };
    }

    assertLegalNegotiationTransition(negotiation.status, 'SENT');

    const dispatchPromise = (async () => {
      try {
        const dispatchResponse = await this.contactService.sendNegotiation(
          {
            proposalId: proposal.id,
            negotiationId: negotiation.id,
            roundNumber: proposal.roundNumber,
            rfqId: rfq.id,
            supplierName: negotiation.supplierName,
            recipientEmail,
            recipientName: negotiation.supplierName,
            formattedMessage: proposal.supplierFacingMessage,
            idempotencyKey: dedupeKey,
          },
          preferredProvider
        );

        proposal.status = 'DISPATCHED';
        proposal.dispatchedAt = new Date();

        negotiation.status = 'SENT';
        assertLegalNegotiationTransition(negotiation.status, 'WAITING_FOR_RESPONSE');
        negotiation.status = 'WAITING_FOR_RESPONSE';
        negotiation.updatedAt = new Date();

        const currentRound = negotiation.rounds.find((r) => r.roundNumber === proposal.roundNumber);
        if (currentRound) {
          currentRound.dispatchedAt = new Date();
          currentRound.dispatchMessageId = dispatchResponse.messageId;
        }

        this.emitAudit('NEGOTIATION_SENT', negotiation.id, {
          proposalId: proposal.id,
          messageId: dispatchResponse.messageId,
          recipient: dispatchResponse.recipient,
        });

        return dispatchResponse;
      } finally {
        this.inFlightNegotiations.delete(dedupeKey);
      }
    })();

    this.inFlightNegotiations.set(dedupeKey, dispatchPromise);
    return dispatchPromise;
  }

  /**
   * Processes a supplier counteroffer payload, ingesting it through Phase 4 response ingestion
   * and normalization, before evaluating it with the AI advisor.
   */
  public async processSupplierCounteroffer(input: ProcessCounterofferInput): Promise<{
    quote: Quote;
    evaluation: { outcome: 'ACCEPTABLE' | 'ANOTHER_ROUND' | 'STOPPED'; reason: string };
  }> {
    const negotiation = this.negotiations.get(input.negotiationId);
    if (!negotiation) {
      throw new Error(`Negotiation '${input.negotiationId}' not found`);
    }

    assertLegalNegotiationTransition(negotiation.status, 'COUNTERED');
    negotiation.status = 'COUNTERED';

    const rfq = this.rfqSvc.getRFQ(negotiation.rfqId)!;
    const currentRound = negotiation.rounds.find(
      (r) => r.roundNumber === negotiation.currentRoundNumber
    );

    // 1. Ingest Response via Phase 4 Provider
    const responseService = input.supplierResponseService || new SupplierResponseService(this.rfqSvc);
    const rawResponse = await responseService.ingestResponse({
      ...input.responseInput,
      rfqId: rfq.id,
      candidateId: negotiation.candidateId,
      supplierName: negotiation.supplierName,
    });

    this.emitAudit('NEGOTIATION_RESPONSE_RECEIVED', negotiation.id, {
      responseId: rawResponse.id,
      channel: rawResponse.channel,
    });

    // 2. Normalize Quote via Phase 4 Normalization Service
    const normalizationResult = await this.quoteService.normalizeResponse(rawResponse);
    const counterofferQuote = normalizationResult.quote;

    assertLegalNegotiationTransition(negotiation.status, 'REVIEWING');
    negotiation.status = 'REVIEWING';

    const originalQuote = this.quoteService.getQuote(negotiation.initialQuoteId)!;
    const remainingRounds = negotiation.maxRounds - negotiation.currentRoundNumber;

    // 3. AI Advisor Evaluation
    const evaluation = await this.advisor.evaluateCounteroffer(
      originalQuote,
      counterofferQuote,
      currentRound!.proposal,
      remainingRounds
    );

    // 4. Update Round Details
    currentRound!.supplierResponseStatus = 'COUNTEROFFERED';
    currentRound!.counterofferResponseId = rawResponse.id;
    currentRound!.counterofferQuoteId = counterofferQuote.id;
    currentRound!.counterofferQuote = counterofferQuote;
    currentRound!.evaluatedAt = new Date();
    currentRound!.evaluationOutcome = evaluation.outcome;
    currentRound!.evaluationNotes = evaluation.reason;

    negotiation.currentQuoteId = counterofferQuote.id;
    negotiation.updatedAt = new Date();

    if (evaluation.outcome === 'ACCEPTABLE') {
      assertLegalNegotiationTransition(negotiation.status, 'ACCEPTABLE');
      negotiation.status = 'ACCEPTABLE';
      negotiation.currentBestQuoteId = counterofferQuote.id;
      negotiation.stopReason = 'ACCEPTABLE_TERMS_ACHIEVED';
      negotiation.completedAt = new Date();

      this.emitAudit('NEGOTIATION_ACCEPTABLE', negotiation.id, {
        quoteId: counterofferQuote.id,
        total: counterofferQuote.total,
      });
    } else if (evaluation.outcome === 'ANOTHER_ROUND') {
      assertLegalNegotiationTransition(negotiation.status, 'ANOTHER_ROUND');
      negotiation.status = 'ANOTHER_ROUND';

      this.emitAudit('NEGOTIATION_COUNTEROFFERED', negotiation.id, {
        quoteId: counterofferQuote.id,
        savings: counterofferQuote.total,
      });
    } else {
      assertLegalNegotiationTransition(negotiation.status, 'STOPPED');
      negotiation.status = 'STOPPED';
      negotiation.stopReason = evaluation.reason;
      negotiation.completedAt = new Date();

      this.emitAudit('NEGOTIATION_STOPPED', negotiation.id, {
        reason: evaluation.reason,
      });
    }

    this.emitAudit('NEGOTIATION_ROUND_COMPLETED', negotiation.id, {
      roundNumber: currentRound!.roundNumber,
      outcome: evaluation.outcome,
    });

    return {
      quote: counterofferQuote,
      evaluation,
    };
  }

  /**
   * Deterministically compares quotes for an RFQ using QuoteComparisonService.
   */
  public compareQuotesForRFQ(rfqId: string): QuoteFactualComparison {
    const rfq = this.rfqSvc.getRFQ(rfqId);
    if (!rfq) {
      throw new Error(`RFQ '${rfqId}' not found`);
    }
    const quotes = this.quoteService.getQuotesForRFQ(rfqId);
    return this.comparisonService.compareQuotes(rfq, quotes);
  }

  public getNegotiation(id: string): Negotiation | undefined {
    return this.negotiations.get(id);
  }

  public getNegotiationsForRFQ(rfqId: string): Negotiation[] {
    return this.negotiationsByRfq.get(rfqId) || [];
  }

  public getProposal(id: string): NegotiationProposal | undefined {
    return this.proposals.get(id);
  }

  public reset(): void {
    this.negotiations.clear();
    this.negotiationsByRfq.clear();
    this.proposals.clear();
    this.idempotencyStore.clear();
    this.inFlightNegotiations.clear();
  }

  private emitAudit(eventType: string, aggregateId: string, payload: Record<string, unknown>): void {
    eventBus
      .publish({
        id: randomUUID(),
        name: eventType,
        aggregateId,
        timestamp: new Date().toISOString(),
        payload,
      })
      .catch(() => {});
  }
}

export const negotiationService = new NegotiationService();
