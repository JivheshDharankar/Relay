import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DeliveryProgress, deliveryStepIndex } from '@/components/operations/FulfillmentCard';

/**
 * Recording defect regression: workflow fulfillment records report status
 * VERIFIED, which is not in DELIVERY_ORDER — the progress bar rendered
 * completely empty for verified missions. The bar must map every backend
 * vocabulary honestly and stay empty only for unknown states.
 */
function reachedSegments(container: HTMLElement): number {
  return container.querySelectorAll('li > div.bg-relay-success-500').length;
}

describe('DeliveryProgress status mapping', () => {
  it('maps VERIFIED to a complete bar (the recorded defect)', () => {
    const { container } = render(<DeliveryProgress status="VERIFIED" />);
    expect(reachedSegments(container)).toBe(5);
    expect(container.querySelector('[aria-current="step"]')?.textContent).toMatch(/delivered/i);
  });

  it('maps DELIVERED to a complete bar', () => {
    const { container } = render(<DeliveryProgress status="DELIVERED" />);
    expect(reachedSegments(container)).toBe(5);
  });

  it('maps DISPATCHED to three segments', () => {
    const { container } = render(<DeliveryProgress status="DISPATCHED" />);
    expect(reachedSegments(container)).toBe(3);
  });

  it('maps PENDING to the first segment only', () => {
    const { container } = render(<DeliveryProgress status="PENDING" />);
    expect(reachedSegments(container)).toBe(1);
  });

  it('never guesses for unknown or missing statuses', () => {
    expect(reachedSegments(render(<DeliveryProgress status="SOME_FUTURE_STATE" />).container)).toBe(0);
    expect(reachedSegments(render(<DeliveryProgress status={null} />).container)).toBe(0);
    expect(deliveryStepIndex(undefined)).toBe(-1);
  });
});
