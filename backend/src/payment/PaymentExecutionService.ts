import { randomUUID } from 'crypto';
import { PurchaseOrder } from '../discovery/supplier/selection/types';
import { MandateService, mandateService } from './mandate/MandateService';
import { PaymentAuditService, paymentAuditService } from './PaymentAuditService';
import { MockPaymentProvider, mockPaymentProvider } from './provider/MockPaymentProvider';
import { PaymentProvider } from './provider/PaymentProvider';
import { assertLegalPaymentTransition } from './stateMachine';
import {
  Payment,
  PaymentAttempt,
  PaymentAuthorization,
  PaymentExecutionRequest,
} from './types';

export interface ExecutePaymentInput {
  authorization: PaymentAuthorization;
  purchaseOrder: PurchaseOrder;
  provider?: PaymentProvider;
  idempotencyKey?: string;
}

/**
 * Failure codes where Relay cannot prove whether the provider charged the
 * transaction: the response was lost after submission. Retrying such an
 * outcome requires explicit operator acknowledgement (see retryPayment).
 * Definitive provider rejections (e.g. GATEWAY_DECLINED) are NOT uncertain:
 * the provider authoritatively answered "no".
 */
const UNCERTAIN_FAILURE_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
]);

export function isUncertainAttempt(attempt: PaymentAttempt): boolean {
  if (attempt.status === 'TIMEOUT') return true;
  return !!attempt.failureCode && UNCERTAIN_FAILURE_CODES.has(attempt.failureCode);
}

export class PaymentExecutionService {
  private payments = new Map<string, Payment>();
  private paymentsByCommitment = new Map<string, Payment[]>();
  private idempotencyStore = new Map<string, Payment>();
  private inFlightExecutions = new Map<string, Promise<Payment>>();
  private inFlightRetries = new Map<string, Promise<Payment>>();

  constructor(
    private readonly defaultProvider: PaymentProvider = mockPaymentProvider,
    private readonly mandateSvc: MandateService = mandateService,
    private readonly auditSvc: PaymentAuditService = paymentAuditService,
    /**
     * Maximum time to await a provider response before treating the attempt
     * as a provider timeout (uncertain outcome: terminal FAILED with
     * TIMEOUT_NO_RESPONSE, retryable only after the operator inspects
     * provider state and acknowledges). Guards against hung providers.
     */
    private readonly providerTimeoutMs: number = 30000
  ) {}

  /**
   * Awaits a provider call, failing closed when the provider never settles:
   * a hung provider rejects with code PROVIDER_TIMEOUT (uncertain outcome —
   * Relay cannot prove whether the provider charged the transaction).
   */
  private async awaitProvider(
    provider: PaymentProvider,
    providerRequest: PaymentExecutionRequest
  ): Promise<import('./types').PaymentProviderResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.authorizeAndCapture(providerRequest),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(
              `Provider '${provider.providerName}' did not respond within ${this.providerTimeoutMs}ms`
            );
            (err as any).code = 'PROVIDER_TIMEOUT';
            reject(err);
          }, this.providerTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Executes payment for an already-authorized commercial transaction against a supplier.
   * Strictly concurrency-protected and idempotent.
   */
  public async executePayment(input: ExecutePaymentInput): Promise<Payment> {
    // Only a live AUTHORIZED record may advance to provider execution.
    // Rejected/expired records fail closed here, and an authorization past
    // its 15-minute window is marked EXPIRED with its mandate reservation
    // released (never left orphaned).
    if (input.authorization.status !== 'AUTHORIZED') {
      throw new Error(
        `AUTHORIZATION_NOT_EXECUTABLE: Authorization '${input.authorization.id}' has status '${input.authorization.status}'; only AUTHORIZED records may execute`
      );
    }
    if (input.authorization.expiresAt.getTime() <= Date.now()) {
      input.authorization.status = 'EXPIRED';
      this.mandateSvc.releaseReservation(input.authorization.mandateId, input.authorization.amount);
      this.auditSvc.emit('PAYMENT_AUTHORIZATION_EXPIRED', input.authorization.id, {
        commitmentId: input.authorization.commitmentId,
        purchaseOrderId: input.authorization.purchaseOrderId,
        amount: input.authorization.amount,
        currency: input.authorization.currency,
      });
      throw new Error(
        `AUTHORIZATION_EXPIRED: Authorization '${input.authorization.id}' expired at ${input.authorization.expiresAt.toISOString()}`
      );
    }

    const dedupeKey =
      input.idempotencyKey ||
      `pay_${input.authorization.commitmentId}_${input.authorization.supplierId}_${input.authorization.purpose}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    // 2. Concurrency Lock Check
    if (this.inFlightExecutions.has(dedupeKey)) {
      return this.inFlightExecutions.get(dedupeKey)!;
    }

    const executionPromise = (async () => {
      const now = new Date();
      const paymentId = `pmt_${randomUUID().slice(0, 8)}`;
      const provider = input.provider || this.defaultProvider;

      // 3. Assemble Payment Entity in PENDING -> AUTHORIZED state
      const payment: Payment = {
        id: paymentId,
        authorizationId: input.authorization.id,
        commitmentId: input.authorization.commitmentId,
        purchaseOrderId: input.purchaseOrder.id,
        supplierId: input.authorization.supplierId,
        supplierName: input.authorization.supplierName,
        supplierContact: input.purchaseOrder.supplierContact || 'orders@supplier.internal',
        mandateId: input.authorization.mandateId,
        amount: input.authorization.amount,
        currency: input.authorization.currency,
        purpose: input.authorization.purpose,
        status: 'PENDING',
        idempotencyKey: dedupeKey,
        providerName: provider.providerName,
        attempts: [],
        isSimulated: provider.isSimulated,
        commercialBasisSimulated: input.authorization.commercialBasisSimulated,
        authorizedAt: input.authorization.authorizedAt,
        createdAt: now,
        updatedAt: now,
      };

      assertLegalPaymentTransition(payment.status, 'AUTHORIZED');
      payment.status = 'AUTHORIZED';

      this.auditSvc.emit('PAYMENT_SUBMITTED', paymentId, {
        commitmentId: payment.commitmentId,
        purchaseOrderId: payment.purchaseOrderId,
        supplierId: payment.supplierId,
        amount: payment.amount,
        currency: payment.currency,
      });

      // 4. Advance to PROCESSING status
      assertLegalPaymentTransition(payment.status, 'PROCESSING');
      payment.status = 'PROCESSING';
      payment.updatedAt = new Date();

      this.auditSvc.emit('PAYMENT_PROCESSING', paymentId, {
        provider: provider.providerName,
        amount: payment.amount,
      });

      // 5. Construct Minimal Privacy-Sanitized Provider Request
      const providerRequest: PaymentExecutionRequest = {
        paymentId,
        commitmentId: payment.commitmentId,
        purchaseOrderId: payment.purchaseOrderId,
        supplierId: payment.supplierId,
        supplierName: payment.supplierName,
        recipientReference: payment.supplierContact,
        amount: payment.amount,
        currency: payment.currency,
        purpose: payment.purpose,
        idempotencyKey: dedupeKey,
      };

      const attemptStartTime = Date.now();

      try {
        const result = await this.awaitProvider(provider, providerRequest);
        const durationMs = Date.now() - attemptStartTime;

        const attempt: PaymentAttempt = {
          attemptNumber: 1,
          providerName: provider.providerName,
          providerTransactionId: result.providerTransactionId,
          status: result.status,
          failureCode: result.failureCode,
          failureReason: result.failureReason,
          isRetryable: result.isRetryable,
          timestamp: new Date(),
          durationMs,
        };
        payment.attempts.push(attempt);
        payment.providerTransactionId = result.providerTransactionId;

        if (result.status === 'SUCCESS') {
          // Success Path: PROCESSING -> SUCCEEDED
          assertLegalPaymentTransition(payment.status, 'SUCCEEDED');
          payment.status = 'SUCCEEDED';
          payment.completedAt = new Date();
          payment.updatedAt = new Date();

          // Commit spending against mandate
          this.mandateSvc.commitSpending(payment.mandateId, payment.amount);

          this.auditSvc.emit('PAYMENT_SUCCEEDED', paymentId, {
            providerTransactionId: result.providerTransactionId,
            amount: payment.amount,
            currency: payment.currency,
            supplierId: payment.supplierId,
          });
        } else {
          // Failure Path: PROCESSING -> FAILED
          assertLegalPaymentTransition(payment.status, 'FAILED');
          payment.status = 'FAILED';
          payment.failureCode = result.failureCode || 'PROVIDER_FAILURE';
          payment.failureReason = result.failureReason || 'Payment provider rejected transaction';
          payment.updatedAt = new Date();

          // Release reservation on failure
          this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

          this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
            failureCode: payment.failureCode,
            failureReason: payment.failureReason,
            isRetryable: result.isRetryable,
          });
        }
      } catch (err: any) {
        // Unexpected network / provider runtime crash, or a hung provider
        // that never settled (PROVIDER_TIMEOUT: uncertain outcome — the
        // provider may have charged, so any retry requires the operator to
        // inspect provider state and acknowledge first).
        const failureCode = err?.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR';
        const durationMs = Date.now() - attemptStartTime;
        payment.attempts.push({
          attemptNumber: 1,
          providerName: provider.providerName,
          status: 'FAILED',
          failureCode,
          failureReason: err?.message || 'Unexpected provider execution error',
          isRetryable: true,
          timestamp: new Date(),
          durationMs,
        });

        assertLegalPaymentTransition(payment.status, 'FAILED');
        payment.status = 'FAILED';
        payment.failureCode = failureCode;
        payment.failureReason = err?.message || 'Unexpected provider execution error';
        payment.updatedAt = new Date();

        this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

        this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
          failureCode: payment.failureCode,
          failureReason: payment.failureReason,
        });
      }

      // Persist in memory & idempotency store
      this.payments.set(paymentId, payment);
      const list = this.paymentsByCommitment.get(payment.commitmentId) || [];
      list.push(payment);
      this.paymentsByCommitment.set(payment.commitmentId, list);
      this.idempotencyStore.set(dedupeKey, payment);

      return payment;
    })();

    this.inFlightExecutions.set(dedupeKey, executionPromise);
    try {
      return await executionPromise;
    } finally {
      this.inFlightExecutions.delete(dedupeKey);
    }
  }

  /**
   * Retries an explicitly failed payment if classified as retryable.
   *
   * SAFETY: when the last attempt has an UNCERTAIN outcome (TIMEOUT, network
   * loss after submission, or any failure where Relay cannot prove whether
   * the provider charged the transaction), the retry is rejected unless the
   * caller passes `acknowledgeUncertainOutcome: true`. That flag means the
   * operator has inspected the authoritative provider/payment state and
   * explicitly accepts responsibility for the retry — it must never be set
   * automatically, because an uncertain retry uses a fresh provider
   * idempotency key and could double-charge if the first attempt executed.
   * Definitive provider rejections keep the existing retry behavior.
   */
  public async retryPayment(
    paymentId: string,
    options?: {
      provider?: PaymentProvider;
      acknowledgeUncertainOutcome?: boolean;
    }
  ): Promise<Payment> {
    // Concurrent retries of the same payment coalesce onto one execution
    // instead of racing the FAILED -> RETRYING transition.
    const inFlight = this.inFlightRetries.get(paymentId);
    if (inFlight) {
      return inFlight;
    }
    const execution = this.doRetryPayment(paymentId, options);
    this.inFlightRetries.set(paymentId, execution);
    try {
      return await execution;
    } finally {
      this.inFlightRetries.delete(paymentId);
    }
  }

  private async doRetryPayment(
    paymentId: string,
    options?: {
      provider?: PaymentProvider;
      acknowledgeUncertainOutcome?: boolean;
    }
  ): Promise<Payment> {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new Error(`Payment '${paymentId}' not found for retry`);
    }

    if (payment.status !== 'FAILED') {
      throw new Error(
        `Cannot retry payment in '${payment.status}' status; only FAILED payments can be retried`
      );
    }

    const lastAttempt = payment.attempts[payment.attempts.length - 1];
    if (lastAttempt && !lastAttempt.isRetryable) {
      throw new Error(
        `Payment '${paymentId}' failed with non-retryable code '${lastAttempt.failureCode}' (${lastAttempt.failureReason})`
      );
    }

    if (
      lastAttempt &&
      isUncertainAttempt(lastAttempt) &&
      options?.acknowledgeUncertainOutcome !== true
    ) {
      throw new Error(
        `Cannot retry payment '${paymentId}' with uncertain outcome (last attempt: ` +
          `${lastAttempt.status}/${lastAttempt.failureCode ?? 'unknown'}). ` +
          `Inspect the authoritative provider state first, then retry explicitly with ` +
          `acknowledgeUncertainOutcome: true.`
      );
    }

    // State Machine: FAILED -> RETRYING
    assertLegalPaymentTransition(payment.status, 'RETRYING');
    payment.status = 'RETRYING';
    payment.updatedAt = new Date();

    this.auditSvc.emit('PAYMENT_RETRY_REQUESTED', paymentId, {
      attemptNumber: payment.attempts.length + 1,
    });

    // Re-reserve capacity on mandate
    const reservation = await this.mandateSvc.reserveCapacity(
      payment.mandateId,
      payment.amount,
      { currency: payment.currency, purpose: payment.purpose }
    );

    if (!reservation.success) {
      payment.status = 'FAILED';
      payment.failureCode = 'SPENDING_LIMIT_EXCEEDED';
      payment.failureReason = reservation.error;
      payment.updatedAt = new Date();
      throw new Error(`Cannot retry payment: ${reservation.error}`);
    }

    // RETRYING -> PROCESSING
    assertLegalPaymentTransition(payment.status, 'PROCESSING');
    payment.status = 'PROCESSING';
    payment.updatedAt = new Date();

    const provider = options?.provider || this.defaultProvider;
    const providerRequest: PaymentExecutionRequest = {
      paymentId,
      commitmentId: payment.commitmentId,
      purchaseOrderId: payment.purchaseOrderId,
      supplierId: payment.supplierId,
      supplierName: payment.supplierName,
      recipientReference: payment.supplierContact,
      amount: payment.amount,
      currency: payment.currency,
      purpose: payment.purpose,
      idempotencyKey: `${payment.idempotencyKey}_retry_${payment.attempts.length + 1}`,
    };

    const attemptStartTime = Date.now();

    let result: import('./types').PaymentProviderResult;
    try {
      result = await this.awaitProvider(provider, providerRequest);
    } catch (err: any) {
      // A throwing/hung provider during retry must not strand the payment in
      // RETRYING with an unreleased reservation: record the failed attempt
      // and return the payment to FAILED (retryable again, with
      // acknowledgement when the outcome is uncertain).
      const failureCode = err?.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR';
      const durationMs = Date.now() - attemptStartTime;
      payment.attempts.push({
        attemptNumber: payment.attempts.length + 1,
        providerName: provider.providerName,
        status: 'FAILED',
        failureCode,
        failureReason: err?.message || 'Unexpected provider execution error',
        isRetryable: true,
        timestamp: new Date(),
        durationMs,
      });

      assertLegalPaymentTransition(payment.status, 'FAILED');
      payment.status = 'FAILED';
      payment.failureCode = failureCode;
      payment.failureReason = err?.message || 'Unexpected provider execution error';
      payment.updatedAt = new Date();

      this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

      this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
        failureCode: payment.failureCode,
        failureReason: payment.failureReason,
        isRetry: true,
      });

      return payment;
    }
    const durationMs = Date.now() - attemptStartTime;

    const attempt: PaymentAttempt = {
      attemptNumber: payment.attempts.length + 1,
      providerName: provider.providerName,
      providerTransactionId: result.providerTransactionId,
      status: result.status,
      failureCode: result.failureCode,
      failureReason: result.failureReason,
      isRetryable: result.isRetryable,
      timestamp: new Date(),
      durationMs,
    };
    payment.attempts.push(attempt);
    payment.providerTransactionId = result.providerTransactionId;

    if (result.status === 'SUCCESS') {
      assertLegalPaymentTransition(payment.status, 'SUCCEEDED');
      payment.status = 'SUCCEEDED';
      payment.failureCode = undefined;
      payment.failureReason = undefined;
      payment.completedAt = new Date();
      payment.updatedAt = new Date();

      this.mandateSvc.commitSpending(payment.mandateId, payment.amount);

      this.auditSvc.emit('PAYMENT_SUCCEEDED', paymentId, {
        providerTransactionId: result.providerTransactionId,
        amount: payment.amount,
        isRetry: true,
      });
    } else {
      assertLegalPaymentTransition(payment.status, 'FAILED');
      payment.status = 'FAILED';
      payment.failureCode = result.failureCode;
      payment.failureReason = result.failureReason;
      payment.updatedAt = new Date();

      this.mandateSvc.releaseReservation(payment.mandateId, payment.amount);

      this.auditSvc.emit('PAYMENT_FAILED', paymentId, {
        failureCode: result.failureCode,
        failureReason: result.failureReason,
        isRetry: true,
      });
    }

    return payment;
  }

  public getPayment(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  public getPaymentsForCommitment(commitmentId: string): Payment[] {
    return this.paymentsByCommitment.get(commitmentId) || [];
  }

  public listPayments(): Payment[] {
    return Array.from(this.payments.values());
  }

  public reset(): void {
    this.payments.clear();
    this.paymentsByCommitment.clear();
    this.idempotencyStore.clear();
    this.inFlightExecutions.clear();
    this.inFlightRetries.clear();
    if (this.defaultProvider instanceof MockPaymentProvider) {
      this.defaultProvider.reset();
    }
  }
}

export const paymentExecutionService = new PaymentExecutionService();
