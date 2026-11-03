import { RFQ } from './types';

export interface RFQEmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Escapes untrusted text (product names, specifications, supplier names,
 * delivery areas) for safe interpolation into the HTML email body.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates a clean, professional, privacy-preserving supplier-facing RFQ email.
 */
export function generateRFQEmailContent(rfq: RFQ): RFQEmailContent {
  const itemsSummary = rfq.lineItems
    .map((item) => `${item.quantity} ${item.unit} ${item.productName}`)
    .join(', ');

  const subject = `[Relay RFQ] Request for Quote - ${rfq.id} - ${itemsSummary}`;

  const quoteDeadlineStr = rfq.quoteDeadline.toUTCString();
  const deliveryDeadlineStr = rfq.deliveryDeadline.toUTCString();

  // Plain text version
  const textLines: string[] = [
    `RELAY COMMUNITY PROCUREMENT PLATFORM`,
    `REQUEST FOR QUOTATION (RFQ)`,
    `============================================================`,
    `RFQ Reference: ${rfq.id}`,
    `Date Issued:   ${rfq.createdAt.toUTCString()}`,
    `Recipient:     ${rfq.supplierName}`,
    ``,
    `Dear Supplier Partner,`,
    ``,
    `Relay invites your commercial business to provide a competitive binding quote`,
    `for the following consolidated community procurement requirement:`,
    ``,
    `REQUESTED ITEMS:`,
    `------------------------------------------------------------`,
    ...rfq.lineItems.map(
      (item, idx) =>
        `${idx + 1}. ${item.productName} — ${item.quantity} ${item.unit}${
          item.specification ? ` (${item.specification})` : ''
        }`
    ),
    ``,
    `FULFILLMENT REQUIREMENTS:`,
    `------------------------------------------------------------`,
    `Service / Delivery Area: ${rfq.deliveryArea}`,
    `Required Delivery By:   ${deliveryDeadlineStr}`,
    `Quote Submission By:    ${quoteDeadlineStr}`,
    ``,
    `REQUIRED QUOTE SPECIFICATIONS:`,
    `------------------------------------------------------------`,
    `Please respond with the following structured terms:`,
    `  1. Unit Price (in INR, specify whether inclusive/exclusive of GST)`,
    `  2. Total Price`,
    `  3. Available Quantity in stock`,
    `  4. Confirmed Fulfillment Turnaround / Delivery ETA`,
    `  5. Delivery Fee (if applicable)`,
    `  6. Quote Validity Period`,
    ``,
    `HOW TO RESPOND:`,
    `------------------------------------------------------------`,
    `Please reply directly to this email with your quote, referencing RFQ ID: ${rfq.id}.`,
    ``,
    `Notice: This communication is a formal request for quotation and does not constitute`,
    `a binding purchase order until confirmed by Relay's community order engine.`,
    ``,
    `Sincerely,`,
    `Relay Autonomous Procurement Engine`,
    `https://relaycommunity.com`,
  ];

  const text = textLines.join('\n');

  // HTML version
  const itemsHtml = rfq.lineItems
    .map(
      (item) => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px 12px; font-weight: 500; color: #1e293b;">${escapeHtml(item.productName)}</td>
        <td style="padding: 10px 12px; text-align: right; color: #334155;">${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</td>
        <td style="padding: 10px 12px; color: #64748b;">${escapeHtml(item.specification || 'Standard commercial wholesale packaging')}</td>
      </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    <!-- Header -->
    <tr>
      <td style="background-color: #0f172a; padding: 24px 32px;">
        <div style="font-size: 13px; font-weight: 600; color: #10b981; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Relay Autonomous Community Procurement</div>
        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 600;">Request for Quotation (RFQ)</h1>
        <div style="color: #94a3b8; font-size: 13px; margin-top: 6px;">Ref: <span style="font-family: monospace; color: #f1f5f9;">${escapeHtml(rfq.id)}</span></div>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding: 32px;">
        <p style="margin-top: 0; font-size: 15px; color: #334155; line-height: 1.5;">
          Dear <strong>${escapeHtml(rfq.supplierName)}</strong>,
        </p>
        <p style="font-size: 14px; color: #475569; line-height: 1.5;">
          Relay invites your business to submit a competitive binding quote for the following consolidated community requirement.
        </p>

        <!-- Line Items Table -->
        <div style="margin: 24px 0;">
          <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; margin-bottom: 8px;">Requested Items</div>
          <table width="100%" style="border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr style="background-color: #f1f5f9; border-bottom: 2px solid #cbd5e1;">
                <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #475569;">Item</th>
                <th style="padding: 10px 12px; text-align: right; font-weight: 600; color: #475569;">Quantity</th>
                <th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #475569;">Specification</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>
        </div>

        <!-- Requirements Box -->
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 24px 0; font-size: 14px;">
          <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; margin-bottom: 8px;">Delivery & Schedule</div>
          <div style="margin-bottom: 6px;"><strong>Delivery Location:</strong> ${escapeHtml(rfq.deliveryArea)}</div>
          <div style="margin-bottom: 6px;"><strong>Fulfillment Required By:</strong> <span style="color: #0369a1;">${escapeHtml(deliveryDeadlineStr)}</span></div>
          <div><strong>Quote Response Deadline:</strong> <span style="color: #dc2626; font-weight: 600;">${escapeHtml(quoteDeadlineStr)}</span></div>
        </div>

        <!-- Quote Requirements -->
        <div style="margin: 24px 0;">
          <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; margin-bottom: 8px;">Required Response Details</div>
          <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #475569; line-height: 1.6;">
            <li>Unit Price (in INR, specify whether tax inclusive)</li>
            <li>Total Price</li>
            <li>Available Stock Quantity</li>
            <li>Confirmed Fulfillment Turnaround Time</li>
            <li>Delivery Fee (if any)</li>
            <li>Quote Validity Duration</li>
          </ul>
        </div>

        <p style="font-size: 14px; color: #475569; line-height: 1.5;">
          <strong>How to Respond:</strong> Simply reply directly to this email with your quote, retaining the RFQ reference in the subject line.
        </p>

        <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 16px; margin-top: 32px; line-height: 1.4;">
          This request for quote does not constitute a confirmed purchase order. Order commitment is subject to competitive evaluation by Relay's community procurement engine.
        </p>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f1f5f9; padding: 16px 32px; text-align: center; font-size: 12px; color: #64748b;">
        Relay Community Procurement &bull; Pune, India &bull; <a href="https://relaycommunity.com" style="color: #2563eb; text-decoration: none;">relaycommunity.com</a>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject,
    html,
    text,
  };
}

