import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, SkipForward, Unlock, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useAuthStore } from '../../../store/authStore';
import { canLedger } from '../../../lib/ledgerPerms';
import { formatDateTime } from '../../../utils/format';
import { backdropClose } from '../../../lib/backdropClose';
import {
  LedgerListView, initialLedgerListState, type LedgerAction, type LedgerColumn, type LedgerFilterDef, type LedgerListState,
} from '../../../components/ledger/LedgerListView';
import { EventStatusBadge, MilliAmount, ReasonDialog, syncResultText } from '../../../components/ledger/SyncBadges';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import {
  EVENT_STATUSES, ledgerReviewApi, ledgerReviewKeys, type EventAction, type EventListParams, type SyncEventRow,
} from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import {
  eventActionsFor, eventNoteText, eventStatusLabels, skipReasonLabels, sourceDocumentHref, sourceEventLabels, sourceTypeLabels,
} from '../../../lib/ledger/sync';
import { ledgerHref } from '../routes';

/**
 * «مراجعة ← أحداث الترحيل الآلي» (M3، §5.4، §5.9 C8، §8.2): قائمة GlSourceEvent بفلاتر الحالة والنوع والحدث
 * والتاريخ (`?dateFrom=&dateTo=` من حوار الإقفال) والمفتاح (`?q=`)، مع سبب الإيقاف المفكوك وحالة شقيق POST.
 * إعادة المحاولة (ERROR/BLOCKED) والإفراج (HELD) والتخطي بسبب مكتوب (كل غير نهائي) لمن يملك canConfigureLedger،
 * و«مزامنة الآن» (POST /sync) لكل من يرى الصفحة.
 */

type Tr = (ar: string) => string;

const SOURCE_TYPE_FILTERS = ['INVOICE', 'RECEIPT', 'AR_ENTRY', 'SETTLEMENT', 'PAYLINK_FEE', 'PAYOUT'] as const;
const EVENT_FILTERS = ['POST', 'REVERSE'] as const;

function paramsOf(state: LedgerListState, extras: Record<string, string>): EventListParams {
  const pick = (prefix: string) => state.filters.filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length));
  return {
    status: pick('status:'), sourceType: pick('type:'), event: pick('event:'),
    q: state.search || extras.q || undefined, dateFrom: extras.dateFrom, dateTo: extras.dateTo,
    offset: state.offset, limit: state.limit,
  };
}

/** رسالة رفض إجراء الحدث (أسباب sync.ts) */
function actionErrorText(tr: Tr, err: unknown): string {
  const e = ledgerErrorOf(err);
  switch (e?.reason) {
    case 'STATUS_NOT_ALLOWED': return tr('حالة الحدث لا تسمح بهذا الإجراء');
    case 'STATUS_CHANGED': return tr('تغيّرت حالة الحدث، أعد التحميل');
    case 'REASON_REQUIRED': return tr('سبب التخطي مطلوب');
    default: return ledgerErrorMessage(tr, e);
  }
}

export default function SyncEventsPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const canAct = canLedger(user, 'canConfigureLedger');
  const [sp, setSp] = useSearchParams();
  const initialStatus = (sp.get('status') ?? '').split(',').filter(s => (EVENT_STATUSES as readonly string[]).includes(s));
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState({
    limit: 50,
    filters: initialStatus.length ? initialStatus.map(s => `status:${s}`) : ['status:PENDING', 'status:BLOCKED', 'status:ERROR', 'status:HELD'],
  }));
  const [extras, setExtras] = useState<Record<string, string>>(() => Object.fromEntries(['q', 'dateFrom', 'dateTo'].map(k => [k, sp.get(k) ?? '']).filter(([, v]) => v)));
  const [detail, setDetail] = useState<SyncEventRow | null>(null);
  const [skipping, setSkipping] = useState<SyncEventRow[] | null>(null);

  const params = useMemo(() => paramsOf(state, extras), [state, extras]);
  const q = useQuery({
    queryKey: ledgerReviewKeys.events(params),
    queryFn: async () => (await ledgerReviewApi.events.list(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.rows ?? [];
  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ledger', 'events'] }); qc.invalidateQueries({ queryKey: ['ledger', 'customers'] }); };

  const sync = useMutation({
    mutationFn: async () => (await ledgerConfigApi.sync()).data,
    onSuccess: (r) => {
      if (r.running) toast(`${tr('المزامنة جارية الآن، أعد التحميل بعد قليل')} (${r.pendingEvents})`);
      else toast.success(`${tr('تمت المزامنة')} — ${tr('أحداث متبقية')}: ${r.pendingEvents}`);
      refresh();
      qc.invalidateQueries({ queryKey: ledgerKeys.status });
    },
    onError: (err) => toast.error(syncResultText(tr, err)),
  });

  const act = useMutation({
    mutationFn: async ({ ids, action, reason }: { ids: SyncEventRow[]; action: EventAction; reason?: string }) => {
      let ok = 0; const failed: string[] = [];
      for (const ev of ids) {
        try {
          if (action === 'retry') await ledgerReviewApi.events.retry(ev.id);
          else if (action === 'release') await ledgerReviewApi.events.release(ev.id);
          else await ledgerReviewApi.events.skip(ev.id, reason ?? '');
          ok++;
        } catch (err) { failed.push(`${ev.sourceKey}: ${actionErrorText(tr, err)}`); }
      }
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok) toast.success(`${tr('تم تنفيذ الإجراء')}: ${ok}`);
      if (failed.length) toast.error(failed.slice(0, 3).join(' · '), { duration: 8000 });
      setDetail(null); setSkipping(null);
      refresh();
    },
  });

  const statusLabels = eventStatusLabels(tr);
  const typeLabels = sourceTypeLabels(tr);
  const eventLabels = sourceEventLabels(tr);
  const skipLabels = skipReasonLabels(tr);

  const filters: LedgerFilterDef[] = [
    ...EVENT_STATUSES.map(s => ({ key: `status:${s}`, label: statusLabels[s], group: 'status' })),
    ...SOURCE_TYPE_FILTERS.map(s => ({ key: `type:${s}`, label: typeLabels[s], group: 'type' })),
    ...EVENT_FILTERS.map(s => ({ key: `event:${s}`, label: eventLabels[s], group: 'event' })),
  ];

  const byIds = (ids: string[]) => rows.filter(r => ids.includes(r.id));
  const allowedFor = (ids: string[], a: EventAction) => byIds(ids).filter(r => eventActionsFor(r.status).includes(a));
  const bulkActions: LedgerAction[] = [
    {
      label: tr('إعادة المحاولة'), perm: 'canConfigureLedger', run: ids => act.mutateAsync({ ids: allowedFor(ids, 'retry'), action: 'retry' }),
      disabledReason: ids => (allowedFor(ids, 'retry').length ? null : tr('إعادة المحاولة للأحداث بخطأ أو المحجوبة وحدها')),
    },
    {
      label: tr('إفراج'), perm: 'canConfigureLedger', run: ids => act.mutateAsync({ ids: allowedFor(ids, 'release'), action: 'release' }),
      disabledReason: ids => (allowedFor(ids, 'release').length ? null : tr('الإفراج للأحداث الموقوفة وحدها')),
    },
    {
      label: tr('تخطي'), perm: 'canConfigureLedger', danger: true, run: ids => setSkipping(allowedFor(ids, 'skip')),
      disabledReason: ids => (allowedFor(ids, 'skip').length ? null : tr('الحدث المرحّل أو المتخطّى لا يُتخطّى')),
    },
  ];

  const columns: LedgerColumn<SyncEventRow>[] = [
    { key: 'effectAt', label: tr('تاريخ الأثر'), render: r => <span className="whitespace-nowrap">{formatDateTime(r.effectAt)}</span> },
    { key: 'source', label: tr('المصدر'), render: r => <span className="whitespace-nowrap">{typeLabels[r.sourceType] ?? r.sourceType} · {eventLabels[r.event] ?? r.event}</span> },
    { key: 'key', label: tr('المفتاح'), render: r => <bdi className="font-mono text-[11px] text-[#6E6557]">{r.sourceKey}</bdi> },
    { key: 'status', label: tr('الحالة'), render: r => <EventStatusBadge status={r.status} skipReason={r.skipReason} /> },
    {
      key: 'note', label: tr('السبب'),
      render: r => {
        const t = eventNoteText(tr, r.note) ?? (r.skipReason ? skipLabels[r.skipReason] ?? r.skipReason : '');
        return <span className="block max-w-[18rem] truncate text-xs" title={t}>{t}</span>;
      },
    },
    {
      key: 'move', label: tr('القيد'),
      render: r => (r.moveId
        ? <Link onClick={e => e.stopPropagation()} to={ledgerHref(`entries/${r.moveId}`)} className="text-[#E15A30] hover:underline"><bdi>{r.moveNumber ?? tr('(مسودة)')}</bdi></Link>
        : ''),
    },
    { key: 'sibling', label: tr('حالة الشقيق'), optional: true, defaultVisible: true, render: r => (r.sibling?.status ? <EventStatusBadge status={r.sibling.status} skipReason={r.sibling.skipReason} /> : '') },
    { key: 'attempts', label: tr('المحاولات'), optional: true, align: 'center', render: r => <span className="tabular-nums">{r.attempts}</span> },
    { key: 'next', label: tr('المحاولة التالية'), optional: true, render: r => (r.nextAttemptAt ? formatDateTime(r.nextAttemptAt) : '') },
    { key: 'detected', label: tr('اكتُشف'), optional: true, render: r => formatDateTime(r.detectedAt) },
  ];

  const clearExtras = () => {
    setExtras({});
    const next = new URLSearchParams(sp);
    for (const k of ['q', 'dateFrom', 'dateTo', 'status']) next.delete(k);
    setSp(next, { replace: true });
  };
  const counts = q.data?.counts ?? {};

  return (
    <div className="space-y-3">
      {statusQ.data && !statusQ.data.activatedAt && (
        <p className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm">{tr('الدفاتر بانتظار الإعداد')} — {tr('لا أحداث ترحيل قبل التفعيل')}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {EVENT_STATUSES.map(s => (
          <span key={s} className="rounded-md bg-white border border-[#E8E0D2] px-2 py-0.5">{statusLabels[s]}: <bdi className="tabular-nums font-semibold">{counts[s] ?? 0}</bdi></span>
        ))}
        {Object.keys(extras).length > 0 && (
          <>
            <span className="text-[#6E6557] ms-2">{tr('فلاتر من الرابط')}:</span>
            {Object.entries(extras).map(([k, v]) => <span key={k} className="rounded-md bg-[#F1EBDF] px-1.5 py-0.5"><bdi>{k}={v}</bdi></span>)}
            <button type="button" onClick={clearExtras} className="inline-flex items-center gap-0.5 text-[#E15A30] hover:underline"><X size={12} />{tr('مسح')}</button>
          </>
        )}
      </div>

      <LedgerListView<SyncEventRow>
        title={tr('أحداث الترحيل الآلي')}
        screen="review/events"
        columns={columns}
        rows={rows}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching || act.isPending}
        state={state}
        onStateChange={setState}
        filters={filters}
        bulkActions={bulkActions}
        onRowClick={r => setDetail(r)}
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا أحداث بهذه الفلاتر')}
        toolbar={statusQ.data?.activatedAt ? (
          <button type="button" className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 disabled:opacity-50" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />{tr('مزامنة الآن')}
          </button>
        ) : undefined}
      />

      {detail && (
        <EventDetail
          ev={detail}
          decimals={statusQ.data?.currencyDecimals ?? 2}
          canAct={canAct}
          busy={act.isPending}
          onClose={() => setDetail(null)}
          onAction={a => (a === 'skip' ? setSkipping([detail]) : act.mutate({ ids: [detail], action: a }))}
        />
      )}
      {skipping && (
        <ReasonDialog
          title={tr('تخطي الحدث')}
          description={<>
            <p>{tr('الحدث المتخطّى لا يُرحَّل أبدا، ويبقى أثره في سجل التدقيق. استعمله لحدث لا يُرحَّل مثل عملة مختلفة')}</p>
            <p className="mt-1 font-mono text-[11px]"><bdi>{skipping.map(s => s.sourceKey).slice(0, 5).join(' · ')}</bdi>{skipping.length > 5 ? ` (+${skipping.length - 5})` : ''}</p>
          </>}
          confirmLabel={tr('تخطي')}
          danger
          busy={act.isPending}
          onClose={() => setSkipping(null)}
          onConfirm={reason => act.mutate({ ids: skipping, action: 'skip', reason })}
        />
      )}
    </div>
  );
}

function EventDetail({ ev, decimals, canAct, busy, onClose, onAction }: {
  ev: SyncEventRow; decimals: number; canAct: boolean; busy: boolean; onClose: () => void; onAction: (a: EventAction) => void;
}) {
  const tr = useTr();
  const typeLabels = sourceTypeLabels(tr);
  const skipLabels = skipReasonLabels(tr);
  const actions = eventActionsFor(ev.status);
  const docHref = sourceDocumentHref(ev.sourceType);
  const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="grid grid-cols-3 gap-2 py-1 border-b border-[#F1EBDF] text-sm"><dt className="text-[#9A8F7E] text-xs">{label}</dt><dd className="col-span-2 min-w-0 break-words">{children}</dd></div>
  );
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="event-detail-title">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#F1EBDF]">
          <h2 id="event-detail-title" className="text-lg font-bold text-[#1F1A13] flex-1">{tr('تفاصيل الحدث')}</h2>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="p-1 rounded hover:bg-[#F1EBDF]"><X size={18} /></button>
        </div>
        <dl className="px-5 py-3">
          <Row label={tr('المفتاح')}><bdi className="font-mono text-xs">{ev.sourceKey}</bdi></Row>
          <Row label={tr('المصدر')}>{typeLabels[ev.sourceType] ?? ev.sourceType}{docHref && <> · <Link to={docHref} className="text-[#E15A30] hover:underline">{tr('فتح')}</Link></>}</Row>
          <Row label={tr('الحالة')}><EventStatusBadge status={ev.status} skipReason={ev.skipReason} /></Row>
          {ev.note && <Row label={tr('السبب')}>{eventNoteText(tr, ev.note)}</Row>}
          {ev.skipReason && <Row label={tr('سبب التخطي')}>{skipLabels[ev.skipReason] ?? ev.skipReason}</Row>}
          <Row label={tr('تاريخ الأثر')}>{formatDateTime(ev.effectAt)}</Row>
          <Row label={tr('اكتُشف')}>{formatDateTime(ev.detectedAt)}</Row>
          <Row label={tr('المحاولات')}><span className="tabular-nums">{ev.attempts}</span>{ev.nextAttemptAt ? <> · {tr('المحاولة التالية')}: {formatDateTime(ev.nextAttemptAt)}</> : null}</Row>
          {ev.moveId && <Row label={tr('القيد')}><Link to={ledgerHref(`entries/${ev.moveId}`)} className="text-[#E15A30] hover:underline"><bdi>{ev.moveNumber ?? tr('(مسودة)')}</bdi></Link></Row>}
          {ev.processedAt && <Row label={tr('عولج')}>{formatDateTime(ev.processedAt)}</Row>}
          {ev.nonCustodyClearedMilli !== null && <Row label={tr('المصفّى من خارج العهدة')}><MilliAmount value={ev.nonCustodyClearedMilli} decimals={decimals} /></Row>}
          {ev.shortageRecoveredMilli !== null && <Row label={tr('المسترد من العجز')}><MilliAmount value={ev.shortageRecoveredMilli} decimals={decimals} /></Row>}
          {ev.sibling && (
            <Row label={tr('حالة الشقيق')}>
              <bdi className="font-mono text-xs">{ev.sibling.sourceKey}</bdi>{' '}
              {ev.sibling.status ? <EventStatusBadge status={ev.sibling.status} skipReason={ev.sibling.skipReason} /> : <span className="text-[#9A8F7E]">{tr('غير موجود')}</span>}
              {ev.sibling.nextAttemptAt && <span className="text-xs"> · {formatDateTime(ev.sibling.nextAttemptAt)}</span>}
            </Row>
          )}
        </dl>
        {canAct && actions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-5 pb-5">
            {actions.includes('retry') && <button type="button" disabled={busy} className="btn-primary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 disabled:opacity-50" onClick={() => onAction('retry')}><RotateCcw size={14} />{tr('إعادة المحاولة')}</button>}
            {actions.includes('release') && <button type="button" disabled={busy} className="btn-primary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 disabled:opacity-50" onClick={() => onAction('release')}><Unlock size={14} />{tr('إفراج')}</button>}
            {actions.includes('skip') && <button type="button" disabled={busy} className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1 text-[#C0392B] disabled:opacity-50" onClick={() => onAction('skip')}><SkipForward size={14} />{tr('تخطي')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
