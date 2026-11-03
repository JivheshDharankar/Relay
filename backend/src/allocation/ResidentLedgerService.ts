import { randomUUID } from 'crypto';
import { roundMoney, toDecimal } from '../domain/procurement/decimal';
import { AllocationAuditService, allocationAuditService } from './AllocationAuditService';
import {
  ResidentAllocation,
  ResidentLedgerEntry,
} from './types';
import { AllocationValidationError, validateResidentAuthorization } from './validation';

export interface PostAdjustmentInput {
  residentReference: string;
  residentOrderId: string;
  allocationId: string;
  commitmentId: string;
  amount: number;
  referenceEntryId: string;
  reason: string;
}

export interface PostReversalInput {
  originalEntryId: string;
  reason: string;
}

export class ResidentLedgerService {
  private entries = new Map<string, ResidentLedgerEntry>();
  private entriesByAllocation = new Map<string, string[]>();
  private entriesByResident = new Map<string, string[]>();
  private entriesByCommitment = new Map<string, string[]>();

  constructor(
    private readonly auditService: AllocationAuditService = allocationAuditService
  ) {}

  /**
   * Posts an authoritative procurement allocation to the resident's accounting ledger.
   * Idempotent: repeated calls for the same allocation return the existing entry.
   */
  public postAllocation(allocation: ResidentAllocation): ResidentLedgerEntry {
    const existingIds = this.entriesByAllocation.get(allocation.id) || [];
    for (const id of existingIds) {
      const entry = this.entries.get(id);
      if (entry && entry.entryType === 'PROCUREMENT_ALLOCATION') {
        return entry; // Idempotent return
      }
    }

    const entryId = `ledg_${randomUUID().slice(0, 10)}`;
    const entry: ResidentLedgerEntry = {
      id: entryId,
      residentReference: allocation.residentReference,
      residentOrderId: allocation.residentOrderId,
      allocationId: allocation.id,
      commitmentId: allocation.commitmentId,
      amount: allocation.totalAmount,
      currency: 'INR',
      entryType: 'PROCUREMENT_ALLOCATION',
      status: 'POSTED',
      createdAt: new Date(),
    };

    this.saveEntry(entry);

    this.auditService.emit('LEDGER_ENTRY_CREATED', entry.id, {
      residentReference: entry.residentReference,
      commitmentId: entry.commitmentId,
      amount: entry.amount,
      entryType: entry.entryType,
    });

    return entry;
  }

  /**
   * Posts an explicit adjustment ledger entry referencing a prior entry.
   * Enforces immutability: the original entry is NEVER overwritten or deleted.
   */
  public postAdjustment(input: PostAdjustmentInput): ResidentLedgerEntry {
    const original = this.entries.get(input.referenceEntryId);
    if (!original) {
      throw new AllocationValidationError([
        `ORIGINAL_ENTRY_NOT_FOUND: Referenced ledger entry '${input.referenceEntryId}' does not exist`,
      ]);
    }

    const entryId = `ledg_${randomUUID().slice(0, 10)}`;
    const entry: ResidentLedgerEntry = {
      id: entryId,
      residentReference: input.residentReference,
      residentOrderId: input.residentOrderId,
      allocationId: input.allocationId,
      commitmentId: input.commitmentId,
      amount: roundMoney(input.amount).toNumber(),
      currency: 'INR',
      entryType: 'ADJUSTMENT',
      status: 'ADJUSTED',
      referenceEntryId: input.referenceEntryId,
      reason: input.reason,
      createdAt: new Date(),
    };

    this.saveEntry(entry);

    this.auditService.emit('LEDGER_ADJUSTMENT_CREATED', entry.id, {
      residentReference: entry.residentReference,
      referenceEntryId: input.referenceEntryId,
      amount: entry.amount,
      reason: input.reason,
    });

    return entry;
  }

  /**
   * Posts an explicit reversal entry with negated amount and marks the original status as REVERSED.
   */
  public postReversal(input: PostReversalInput): ResidentLedgerEntry {
    const original = this.entries.get(input.originalEntryId);
    if (!original) {
      throw new AllocationValidationError([
        `ORIGINAL_ENTRY_NOT_FOUND: Referenced ledger entry '${input.originalEntryId}' does not exist`,
      ]);
    }

    if (original.status === 'REVERSED') {
      throw new AllocationValidationError([
        `ALREADY_REVERSED: Ledger entry '${input.originalEntryId}' is already marked as REVERSED`,
      ]);
    }

    // Mark original entry status as REVERSED without altering its original amount
    original.status = 'REVERSED';

    const entryId = `ledg_${randomUUID().slice(0, 10)}`;
    const negatedAmount = roundMoney(toDecimal(original.amount).negated()).toNumber();

    const reversalEntry: ResidentLedgerEntry = {
      id: entryId,
      residentReference: original.residentReference,
      residentOrderId: original.residentOrderId,
      allocationId: original.allocationId,
      commitmentId: original.commitmentId,
      amount: negatedAmount,
      currency: original.currency,
      entryType: 'REVERSAL',
      status: 'REVERSED',
      referenceEntryId: original.id,
      reason: input.reason,
      createdAt: new Date(),
    };

    this.saveEntry(reversalEntry);

    this.auditService.emit('LEDGER_REVERSAL_CREATED', reversalEntry.id, {
      residentReference: reversalEntry.residentReference,
      originalEntryId: original.id,
      reversalAmount: reversalEntry.amount,
      reason: input.reason,
    });

    return reversalEntry;
  }

  /**
   * Retrieves all ledger entries for a specific resident with server-side authorization check.
   */
  public getEntriesForResident(
    residentReference: string,
    requestingResidentReference: string
  ): ResidentLedgerEntry[] {
    validateResidentAuthorization(requestingResidentReference, residentReference);

    const ids = this.entriesByResident.get(residentReference) || [];
    return ids
      .map((id) => this.entries.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Calculates the current net balance for a resident with server-side authorization.
   */
  public getResidentBalance(
    residentReference: string,
    requestingResidentReference: string
  ): { balance: number; currency: string } {
    validateResidentAuthorization(requestingResidentReference, residentReference);

    const entries = this.getEntriesForResident(residentReference, requestingResidentReference);
    const balanceDec = entries.reduce(
      (sum, entry) => sum.plus(toDecimal(entry.amount)),
      toDecimal(0)
    );

    return {
      balance: roundMoney(balanceDec).toNumber(),
      currency: 'INR',
    };
  }

  /**
   * Retrieves all ledger entries for a community commitment (internal/reconciliation view).
   */
  public getAllEntriesForCommitment(commitmentId: string): ResidentLedgerEntry[] {
    const ids = this.entriesByCommitment.get(commitmentId) || [];
    return ids.map((id) => this.entries.get(id)!).filter(Boolean);
  }

  private saveEntry(entry: ResidentLedgerEntry): void {
    this.entries.set(entry.id, entry);

    const allocList = this.entriesByAllocation.get(entry.allocationId) || [];
    allocList.push(entry.id);
    this.entriesByAllocation.set(entry.allocationId, allocList);

    const resList = this.entriesByResident.get(entry.residentReference) || [];
    resList.push(entry.id);
    this.entriesByResident.set(entry.residentReference, resList);

    const commList = this.entriesByCommitment.get(entry.commitmentId) || [];
    commList.push(entry.id);
    this.entriesByCommitment.set(entry.commitmentId, commList);
  }
}

export const residentLedgerService = new ResidentLedgerService();
