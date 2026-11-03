'use client';

import React from 'react';
import { QuotesWorkspace } from '@/components/market/QuotesWorkspace';

/** Legacy deep link: preserved; renders the same shared workspace as /quotes. */
export default function MarketQuotesPage() {
  return <QuotesWorkspace />;
}
