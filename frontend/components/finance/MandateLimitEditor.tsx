'use client';

import React, { useState } from 'react';
import { ApiClientError, updateMandateLimit } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/inputs';

export const MANDATE_LIMIT_CEILING = 1000000;

export interface MandateLimitEditorProps {
  mandate: {
    id: string;
    maximumAmount: number;
    currency: string;
    status: string;
  };
  /** Trusted used/remaining figures when the backend confirms them; null otherwise. */
  usedAmount: number | null;
  remainingLimit: number | null;
  /** Reloads authoritative resident context after a successful save. */
  reload: () => Promise<void>;
  /**
   * First visible step. Pages that already display the values (e.g. Finance)
   * can open directly at 'edit'. Defaults to 'view'.
   */
  initialStep?: 'view' | 'edit';
  /**
   * Optional close hook for embedded panels. When provided, Cancel and
   * successful save close the panel instead of returning to the view step.
   */
  onClose?: () => void;
}

function parseLimitInput(raw: string): number | null {
  const trimmed = raw.replace(/[,₹\s]/g, '');
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function readError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'TIMEOUT') return 'Request timed out. Please try again.';
    if (err.code === 'NETWORK_ERROR') return 'Cannot reach Relay backend. Check that it is running.';
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function MandateLimitEditor({ mandate, usedAmount, remainingLimit, reload, initialStep = 'view', onClose }: MandateLimitEditorProps) {
  const [step, setStep] = useState<'view' | 'edit' | 'confirm'>(initialStep);
  const [draft, setDraft] = useState(initialStep === 'edit' ? String(mandate.maximumAmount) : '');
  const [confirmedValue, setConfirmedValue] = useState<number | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editable = mandate.status === 'ACTIVE' || mandate.status === 'PAUSED';

  const cancelEdit = () => {
    if (onClose) {
      onClose();
      return;
    }
    setStep('view');
  };

  const startEdit = () => {
    setDraft(String(mandate.maximumAmount));
    setFieldError(null);
    setSaveError(null);
    setStep('edit');
  };

  const reviewDraft = () => {
    const parsed = parseLimitInput(draft);
    if (parsed === null || !(parsed > 0)) {
      setFieldError('Enter a valid amount greater than 0.');
      return;
    }
    if (parsed > MANDATE_LIMIT_CEILING) {
      setFieldError(`Limit cannot exceed ${formatMoney(MANDATE_LIMIT_CEILING, mandate.currency)}.`);
      return;
    }
    setFieldError(null);
    setSaveError(null);
    setConfirmedValue(parsed);
    setStep('confirm');
  };

  const confirmSave = async () => {
    if (confirmedValue === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateMandateLimit(confirmedValue);
      await reload();
      setConfirmedValue(null);
      if (onClose) {
        onClose();
      } else {
        setStep('view');
      }
    } catch (err) {
      setSaveError(readError(err, 'Failed to update the limit.'));
    } finally {
      setSaving(false);
    }
  };

  const belowUsed = confirmedValue !== null && usedAmount !== null && confirmedValue < usedAmount;

  return (
    <div>
      <dl className="text-sm space-y-2.5">
        <div className="flex justify-between gap-2">
          <dt className="text-relay-ink-500">Status</dt>
          <dd className="font-semibold">{mandate.status}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-relay-ink-500">Monthly limit</dt>
          <dd className="font-semibold tnum">{formatMoney(mandate.maximumAmount, mandate.currency)}</dd>
        </div>
        {usedAmount !== null && (
          <div className="flex justify-between gap-2">
            <dt className="text-relay-ink-500">Used</dt>
            <dd className="font-semibold tnum">{formatMoney(usedAmount, mandate.currency)}</dd>
          </div>
        )}
        {remainingLimit !== null && (
          <div className="flex justify-between gap-2">
            <dt className="text-relay-ink-500">Remaining</dt>
            <dd className="font-semibold tnum">{formatMoney(remainingLimit, mandate.currency)}</dd>
          </div>
        )}
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-relay-ink-500">
        Your Relay authorization limit — the maximum Relay may spend on your behalf.
        Separate from your bank or card limits. Relay can never charge beyond it.
      </p>

      {step === 'view' && editable && (
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={startEdit}>
            Edit limit
          </Button>
        </div>
      )}
      {step === 'view' && !editable && (
        <p className="mt-3 text-xs text-relay-ink-500">
          This mandate is {mandate.status.toLowerCase()}; its limit cannot be changed.
        </p>
      )}

      {step === 'edit' && (
        <div className="mt-4 space-y-3">
          <Field
            label="New monthly limit"
            htmlFor="mandate-limit-input"
            hint={`Enter an amount up to ${formatMoney(MANDATE_LIMIT_CEILING, mandate.currency)}.`}
            error={fieldError}
          >
            <TextInput
              id="mandate-limit-input"
              inputMode="decimal"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button size="sm" onClick={reviewDraft}>
              Review change
            </Button>
          </div>
        </div>
      )}

      {step === 'confirm' && confirmedValue !== null && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-relay-ink-900">
            Change your monthly limit from{' '}
            <span className="font-semibold tnum">{formatMoney(mandate.maximumAmount, mandate.currency)}</span>
            {' '}to{' '}
            <span className="font-semibold tnum">{formatMoney(confirmedValue, mandate.currency)}</span>?
          </p>
          {belowUsed && usedAmount !== null && (
            <p className="text-xs leading-relaxed text-relay-ink-600">
              This is below your used amount of {formatMoney(usedAmount, mandate.currency)}.
              Completed payments stay valid; remaining available becomes{' '}
              {formatMoney(0, mandate.currency)} until usage falls within the new limit.
            </p>
          )}
          {saveError && (
            <p className="text-xs font-medium text-relay-danger-700" role="alert">
              {saveError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep('edit')} disabled={saving}>
              Back
            </Button>
            <Button size="sm" onClick={() => void confirmSave()} isLoading={saving}>
              Confirm new limit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
