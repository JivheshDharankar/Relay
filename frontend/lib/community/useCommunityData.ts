'use client';

import { useEffect, useState } from 'react';
import { ApiClientError, getCommunity } from '@/lib/api';
import type { CommunityData } from '@/types';

export function useCommunityData(enabled: boolean) {
  const [community, setCommunity] = useState<CommunityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getCommunity()
      .then((data) => {
        if (!cancelled) {
          setCommunity(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          setForbidden(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load community data');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { community, error, forbidden };
}
