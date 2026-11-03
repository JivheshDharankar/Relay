import { Quote } from '../quote/types';
import { NegotiationRequestedChanges } from './types';

/**
 * Collapses control characters in untrusted single-line fields so strategy
 * notes, product names, or supplier names cannot reshape the message body.
 */
export function sanitizeMessageLine(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ');
}

export class NegotiationMessageBuilder {
  /**
   * Generates a professional, standardized, privacy-preserving negotiation message
   * that can safely be transmitted to the supplier.
   */
  public buildSupplierMessage(
    quote: Quote,
    proposal: {
      rfqId: string;
      quoteId: string;
      roundNumber: number;
      requestedChanges: NegotiationRequestedChanges;
      notes?: string;
    }
  ): string {
    const primaryItem = quote.lineItems[0];
    const productName = sanitizeMessageLine(primaryItem?.productName || 'Procurement items');
    const unit = sanitizeMessageLine(primaryItem?.unit || 'units');
    const quotedQty = sanitizeMessageLine(primaryItem?.quotedQuantity.toString() || '0');

    const lines: string[] = [];
    lines.push(`Subject: Commercial Negotiation Request - Order Proposal #${sanitizeMessageLine(quote.id)}`);
    lines.push('');
    lines.push(`Dear ${sanitizeMessageLine(quote.supplierName)},`);
    lines.push('');
    lines.push(
      'Thank you for providing your quote for our consolidated community procurement order.'
    );
    lines.push(
      'To help finalize this order, we would like to explore if the commercial terms can be improved:'
    );
    lines.push('');
    lines.push('--- Current Quoted Terms ---');
    lines.push(`- Product: ${productName}`);
    lines.push(`- Quoted Quantity: ${quotedQty} ${unit}`);
    lines.push(`- Quoted Unit Price: ₹${quote.lineItems[0]?.unitPrice.toFixed(2) ?? '0.00'}`);
    lines.push(`- Delivery Fee: ₹${quote.deliveryFee.toFixed(2)}`);
    lines.push(`- Quoted Total: ₹${quote.total.toFixed(2)}`);
    if (typeof quote.deliveryEtaHours === 'number') {
      lines.push(`- Estimated Delivery: ${quote.deliveryEtaHours} hours`);
    }
    lines.push('');

    lines.push('--- Proposed Target Terms ---');
    const changes = proposal.requestedChanges;
    if (changes.targetUnitPrice !== undefined) {
      lines.push(`- Proposed Unit Price: ₹${changes.targetUnitPrice.toFixed(2)} per ${unit}`);
    }
    if (changes.targetDeliveryFee !== undefined) {
      lines.push(`- Proposed Delivery Fee: ₹${changes.targetDeliveryFee.toFixed(2)}`);
    }
    if (changes.targetDeliveryEtaHours !== undefined) {
      lines.push(`- Desired Delivery Time: within ${changes.targetDeliveryEtaHours} hours`);
    }
    if (changes.targetQuantity !== undefined) {
      lines.push(`- Desired Quantity: ${changes.targetQuantity.toString()} ${unit}`);
    }
    if (changes.notes && changes.notes.trim().length > 0) {
      lines.push(`- Commercial Notes: ${sanitizeMessageLine(changes.notes.trim())}`);
    }
    lines.push('');

    lines.push(
      'Please let us know if you can confirm these proposed terms or provide your revised best counteroffer.'
    );
    lines.push('');
    lines.push('Best regards,');
    lines.push('Relay Community Procurement Desk');

    return lines.join('\n');
  }
}

export const negotiationMessageBuilder = new NegotiationMessageBuilder();
