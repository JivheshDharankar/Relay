/**
 * Relay hard operational fulfillment guarantee, in hours.
 *
 * Single source of truth for the deterministic SLA: qualification gates,
 * RFQ deadlines, selection eligibility, and SLA monitoring all enforce
 * this window. A user-stated deadline tighter than this value is recorded
 * verbatim on the workflow (requestedDeadlineHours) and disclosed in the
 * UI — never silently treated as guaranteed.
 */
export const OPERATIONAL_SLA_HOURS = 12;
