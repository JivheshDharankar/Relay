import { ParsedResidentIntent, RelayWorkflow, WorkflowStage } from './types';

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
};

export class WorkflowPlanner {
  /**
   * Product-agnostic intent parsing from natural language requests.
   * Dynamically extracts product, quantity, measurement unit, brand, and constraints.
   * Never relies on a pre-seeded static catalog.
   */
  public parseIntent(requestText: string): ParsedResidentIntent {
    if (!requestText || requestText.trim().length === 0) {
      throw new Error('EMPTY_REQUEST: Request text cannot be empty');
    }

    let text = requestText.trim();

    // Check if missing product name ("Please buy 5 of them")
    const missingProductMatch = text.match(/^(?:please\s+)?(?:buy|order|get)\s+(\d+)\s+of\s+(them|it|these|those)/i);
    if (missingProductMatch) {
      return {
        rawText: text,
        productName: '',
        quantity: parseInt(missingProductMatch[1], 10),
        unit: 'units',
        isAmbiguous: true,
        clarificationQuestion: 'Which specific product would you like to order?',
      };
    }

    // Check if missing quantity ("I need some milk", "Order rice please")
    const someMatch = text.match(/\b(?:some|a\s+few)\s+([a-zA-Z0-9\s]+?)(?:\s+for\b|\.|$)/i);
    if (someMatch) {
      const item = someMatch[1].trim();
      return {
        rawText: text,
        productName: item,
        quantity: 0,
        unit: 'units',
        isAmbiguous: true,
        clarificationQuestion: `How many units or kg of ${item} would you like to order?`,
      };
    }

    const orderNoQtyMatch = text.match(/^(?:please\s+)?(?:order|buy|get)\s+([a-zA-Z0-9\s]+?)\s+please$/i);
    if (orderNoQtyMatch) {
      const item = orderNoQtyMatch[1].trim();
      return {
        rawText: text,
        productName: item,
        quantity: 0,
        unit: 'units',
        isAmbiguous: true,
        clarificationQuestion: `How much ${item} would you like to order?`,
      };
    }

    // Replace word numbers at start or after prepositions (e.g., "three boxes" -> "3 boxes")
    let normalizedText = text;
    for (const [word, num] of Object.entries(WORD_NUMBERS)) {
      const wordRegex = new RegExp(`\\b${word}\\b`, 'gi');
      normalizedText = normalizedText.replace(wordRegex, String(num));
    }

    // Pattern 1: Explicit quantity + unit + product (e.g., "10 kg basmati rice", "3 bottles cooking oil", "3 boxes of tea")
    const qtyUnitProductRegex =
      /(\d+(?:\.\d+)?)\s*(kg|kilograms?|litres?|liters?|l|grams?|g|ml|packs?|packets?|units?|bottles?|boxes?|bags?|cans?)\s+(?:of\s+)?([a-zA-Z0-9\s\-]+?)(?:\s+for\b|\s+with\b|\s+within\b|\.|$)/i;

    const match1 = normalizedText.match(qtyUnitProductRegex);
    if (match1) {
      const quantity = parseFloat(match1[1]);
      let rawUnit = match1[2].toLowerCase();
      let productName = match1[3].trim();

      // Normalize unit representation
      if (/^(kg|kilograms?)$/i.test(rawUnit)) rawUnit = 'kg';
      else if (/^(litres?|liters?|l)$/i.test(rawUnit)) rawUnit = 'liters';
      else if (/^(grams?|g)$/i.test(rawUnit)) rawUnit = 'grams';
      else if (/^(packs?|packets?)$/i.test(rawUnit)) rawUnit = 'packs';
      else if (/^(boxes?)$/i.test(rawUnit)) rawUnit = 'boxes';
      else if (/^(bottles?)$/i.test(rawUnit)) rawUnit = 'bottles';
      else if (/^(units?)$/i.test(rawUnit)) rawUnit = 'units';

      productName = this.cleanProductName(productName);

      return {
        rawText: text,
        productName,
        quantity,
        unit: rawUnit,
        isAmbiguous: false,
      };
    }

    // Pattern 2: Count + Product (e.g. "5 Dairy Milk", "3 Logitech mice", "2 notebooks", "10 notebooks for the study room")
    const countProductRegex =
      /(?:i\s+need|get\s+me|please\s+order|order|buy|can\s+we\s+get)?\s*(\d+(?:\.\d+)?)\s+([a-zA-Z0-9\s\-]+?)(?:\s+for\b|\s+within\b|\s+in\b|\.|$)/i;

    const match2 = normalizedText.match(countProductRegex);
    if (match2) {
      const quantity = parseFloat(match2[1]);
      let productName = match2[2].trim();
      productName = this.cleanProductName(productName);

      if (productName.length > 0 && quantity > 0) {
        return {
          rawText: text,
          productName,
          quantity,
          unit: 'units',
          isAmbiguous: false,
        };
      }
    }

    // Fallback: Default extraction or flag as ambiguous if quantity cannot be discerned
    return {
      rawText: text,
      productName: text,
      quantity: 1,
      unit: 'units',
      isAmbiguous: true,
      clarificationQuestion: 'Could you please specify the desired quantity and unit for your request?',
    };
  }

  /**
   * Strips conversational filler and prepositions from parsed product names.
   */
  private cleanProductName(name: string): string {
    return name
      .replace(/^(of|for|my|our|some|the|a|an)\s+/i, '')
      .replace(/\s+(for\s+my\s+apartment|for\s+the\s+study\s+room|for\s+home|for\s+society|urgently|today)$/i, '')
      .trim();
  }

  /**
   * Deterministically plans the next stage in the autonomous lifecycle.
   */
  public determineNextAction(workflow: RelayWorkflow): {
    nextStage: WorkflowStage;
    actionName: string;
    rationale: string;
  } {
    switch (workflow.currentStage) {
      case 'UNDERSTAND':
        return {
          nextStage: 'DISCOVER',
          actionName: 'discoverSuppliers',
          rationale: 'Procurement demand parsed and validated; discovering local suppliers based on coordinates.',
        };
      case 'DISCOVER':
        return {
          nextStage: 'QUALIFY',
          actionName: 'qualifySuppliers',
          rationale: 'Discovered candidate suppliers found; running deterministic qualification safety checks.',
        };
      case 'QUALIFY':
        return {
          nextStage: 'QUOTE',
          actionName: 'requestQuotes',
          rationale: 'Suppliers qualified; generating anonymized RFQ and dispatching to qualified candidates.',
        };
      case 'QUOTE':
        return {
          nextStage: 'NEGOTIATE',
          actionName: 'negotiateTerms',
          rationale: 'Supplier quotes ingested and normalized; initiating autonomous price and SLA negotiation.',
        };
      case 'NEGOTIATE':
        return {
          nextStage: 'SELECT',
          actionName: 'selectWinner',
          rationale: 'Negotiation concluded; evaluating optimal quote satisfying SLA and cost constraints.',
        };
      case 'SELECT':
        return {
          nextStage: 'COMMIT',
          actionName: 'commitProcurement',
          rationale: 'Winner quote selected; issuing formal purchase orders and locking procurement commitment.',
        };
      case 'COMMIT':
        return {
          nextStage: 'PAY',
          actionName: 'authorizeAndPay',
          rationale: 'Procurement committed; verifying payment mandate and executing authorized supplier payment.',
        };
      case 'PAY':
        return {
          nextStage: 'FULFILL',
          actionName: 'trackFulfillment',
          rationale: 'Payment succeeded; tracking supplier packing, carrier dispatch, and shipment transit.',
        };
      case 'FULFILL':
        return {
          nextStage: 'VERIFY',
          actionName: 'verifyDelivery',
          rationale: 'Carrier indicates delivered; validating proof of delivery and quality sign-off.',
        };
      case 'VERIFY':
        return {
          nextStage: 'ALLOCATE',
          actionName: 'allocateToResidents',
          rationale: 'Delivery verified; allocating goods and paise-exact costs to participating residents.',
        };
      case 'ALLOCATE':
        return {
          nextStage: 'RECONCILE',
          actionName: 'reconcileAccounts',
          rationale: 'Residents allocated; running 4-pillar financial and quantity conservation reconciliation.',
        };
      case 'RECONCILE':
        return {
          nextStage: 'COMPLETE',
          actionName: 'completeWorkflow',
          rationale: '4-pillar reconciliation verified with zero discrepancies; finalizing workflow.',
        };
      case 'COMPLETE':
        return {
          nextStage: 'COMPLETE',
          actionName: 'alreadyCompleted',
          rationale: 'Workflow is in terminal COMPLETED state; all 7 Section 59 pillars satisfied.',
        };
      default:
        throw new Error(`Unknown workflow stage: ${(workflow as any).currentStage}`);
    }
  }
}

export const workflowPlanner = new WorkflowPlanner();
