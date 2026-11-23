import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pendingLoadsApi } from '../api/client';
import { STOCK_CACHE_KEYS } from '../m/mLotsLogic';
import { PENDING_LOADS_KEY, fetchPendingList, pendingSections } from './pendingLoads';

/**
 * «تحميلات بانتظار القبول» للإدارة (اللوحة و/m) — قراءتان:
 *  - المفتوحة (PENDING وDISPUTED) خفيفةٌ بلا توقيعات، تُعاد كل دقيقة ما دام فيها ما ينتظر — القبول يأتي من جهاز المندوب.
 *  - المقبولة حديثاً بصور توقيعها (أثقل) — لا تُعاد دورياً، ويُعيدها التركيز وقبولٌ يظهر في المفتوحة.
 * ومفتوحٌ اختفى بين جلبتين (قُبل أو أُلغي من مكانٍ آخر) ⇒ المقبولة ومفاتيح المخزون من جديد: البضاعة قد دخلت السيارة وخرجت من
 * المستودع. `enabled` false (الميزة مطفأة) ⇒ لا جلب.
 */
export function usePendingVanLoads(opts: { salesRepId?: string; enabled?: boolean; acceptedLimit?: number; scope: string }) {
  const qc = useQueryClient();
  const enabled = opts.enabled !== false;
  const rep = opts.salesRepId || '';
  const openQ = useQuery({
    queryKey: [PENDING_LOADS_KEY, opts.scope, 'open', rep],
    queryFn: () => fetchPendingList(pendingLoadsApi, { status: 'open', ...(rep && { salesRepId: rep }), limit: 100 }),
    enabled,
    refetchInterval: (q) => ((q.state.data?.rows.length ?? 0) > 0 ? 60_000 : false),
  });
  const acceptedQ = useQuery({
    queryKey: [PENDING_LOADS_KEY, opts.scope, 'accepted', rep],
    queryFn: () => fetchPendingList(pendingLoadsApi, { status: 'ACCEPTED', withSignature: true, ...(rep && { salesRepId: rep }), limit: opts.acceptedLimit ?? 10 }),
    enabled,
    staleTime: 30_000,
  });

  const seenOpen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!openQ.data) return;
    const ids = new Set(openQ.data.rows.map((r) => r.id));
    const before = seenOpen.current;
    seenOpen.current = ids;
    if (!before || [...before].every((id) => ids.has(id))) return;
    qc.invalidateQueries({ queryKey: [PENDING_LOADS_KEY] });
    [...STOCK_CACHE_KEYS, 'rep-delete-van', 'locations-summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  }, [openQ.data, qc]);

  return {
    openQ, acceptedQ,
    open: pendingSections(openQ.data?.rows ?? []).open,
    accepted: pendingSections(acceptedQ.data?.rows ?? []).accepted,
    counts: openQ.data?.counts ?? null,
    refetch: () => { void openQ.refetch(); void acceptedQ.refetch(); },
    fetching: openQ.isFetching || acceptedQ.isFetching,
  };
}
