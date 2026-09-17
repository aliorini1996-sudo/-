import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, X, AlertTriangle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../i18n/strings';
import { ledgerErrorMessage } from '../../lib/ledger/errors';
import { useAuthStore } from '../../store/authStore';
import { canLedger } from '../../lib/ledgerPerms';
import { backdropClose } from '../../lib/backdropClose';
import { formatDateTime, formatDayOnly } from '../../utils/format';
import {
  ledgerConfigApi, ledgerKeys, ledgerErrorOf, isLedgerAccessError, LOCK_DATE_FIELDS,
  type LockDates, type LockDateField, type LockSyncBlockers, type DraftsBeforeLockBody,
} from '../../api/ledgerConfig';
import { ledgerMovesApi } from '../../api/ledgerMoves';
import { findLedgerRoute, ledgerHref } from '../../pages/ledger/routes';

/**
 * حوار «تواريخ الإقفال…» (LOCK‑01، §8.3، canCloseLedgerPeriods): الحقول الأربعة مع التاريخ الحالي لكلٍّ منها.
 * - 409 `LEDGER_SYNC_PENDING`: العوائق من الاستجابة (`backfillState`، المصادر المتأخرة، أول 50 حدثاً مع
 *   `eventCount`)، ورابط أحداث الترحيل مفلتراً بالتاريخ، وزر «مزامنة الآن» (M3، §5.1): `POST /sync` ثم إعادة محاولة الحفظ
 *   (202 `running` ⇒ تنبيه بأن نبضة أخرى جارية؛ إعادة المحاولة تعيد عرض العوائق إن بقيت).
 * - 422 `LEDGER_DRAFTS_BEFORE_LOCK`: المسودات بروابط الترحيل والتحرير والحذف.
 * لا حقول إقفال في معالج الإعداد (§5.6) — هذا الحوار وحده.
 */

type Blocked =
  | { kind: 'sync'; body: LockSyncBlockers; date?: string }
  | { kind: 'drafts'; body: DraftsBeforeLockBody }
  | { kind: 'message'; text: string };

export function LockDatesDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const canWrite = canLedger(user, 'canCloseLedgerPeriods');
  const canPost = canLedger(user, 'canPostJournals');
  const [form, setForm] = useState<LockDates>({ salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null });
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const labels: Record<LockDateField, { label: string; hint: string }> = {
    salesLockDate: { label: tr('إقفال المبيعات'), hint: tr('لا قيود مبيعات بتاريخ حتى هذا اليوم') },
    purchaseLockDate: { label: tr('إقفال المشتريات'), hint: tr('لا قيود مشتريات بتاريخ حتى هذا اليوم') },
    taxLockDate: { label: tr('إقفال الضريبة'), hint: tr('لا تغيير على الضريبة بتاريخ حتى هذا اليوم') },
    hardLockDate: { label: tr('الإقفال النهائي'), hint: tr('يسري على الجميع ولا يمكن التراجع عنه') },
  };

  const q = useQuery({
    queryKey: ledgerKeys.lockDates,
    queryFn: async () => (await ledgerConfigApi.lockDates.get()).data.data,
  });
  useEffect(() => {
    if (q.data) setForm({ salesLockDate: q.data.salesLockDate, purchaseLockDate: q.data.purchaseLockDate, taxLockDate: q.data.taxLockDate, hardLockDate: q.data.hardLockDate });
  }, [q.data]);

  const changed = LOCK_DATE_FIELDS.filter(f => (form[f] ?? null) !== (q.data?.[f] ?? null));
  const hardBackward = !!q.data?.hardLockDate && (!form.hardLockDate || form.hardLockDate < q.data.hardLockDate);

  const handleError = (err: unknown) => {
    const body = ledgerErrorOf(err);
    if (isLedgerAccessError(err)) return setBlocked({ kind: 'message', text: tr('لا تملك صلاحية إقفال الفترات') });
    switch (body?.code) {
      case 'LEDGER_SYNC_PENDING':
        return setBlocked({ kind: 'sync', body: body as unknown as LockSyncBlockers, date: changed.map(f => form[f]).filter(Boolean).sort().pop() ?? undefined });
      case 'LEDGER_NOT_SETUP':
        return setBlocked({ kind: 'message', text: tr('الدفاتر لم تُفعَّل بعد — تُضبط تواريخ الإقفال بعد اكتمال الإعداد والترحيل التاريخي') });
      case 'LEDGER_DRAFTS_BEFORE_LOCK':
        return setBlocked({ kind: 'drafts', body: body as unknown as DraftsBeforeLockBody });
      case 'LEDGER_LOCK_DATE_BACKWARD':
        return setBlocked({ kind: 'message', text: tr('لا يمكن إرجاع تاريخ الإقفال النهائي') });
      case 'LEDGER_PERIOD_LOCKED':
        return setBlocked({ kind: 'message', text: ledgerErrorMessage(tr, body) });
      default:
        return setBlocked({ kind: 'message', text: body ? ledgerErrorMessage(tr, body) : tr('تعذر حفظ تواريخ الإقفال') });
    }
  };

  const save = useMutation({
    mutationFn: () => ledgerConfigApi.lockDates.update(Object.fromEntries(changed.map(f => [f, form[f] ?? null])) as Partial<LockDates>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ledgerKeys.lockDates });
      qc.invalidateQueries({ queryKey: ledgerKeys.settings });
      toast.success(tr('تم حفظ تواريخ الإقفال'));
      onClose();
    },
    onError: handleError,
  });

  const draftAction = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'post' | 'delete' }) => (action === 'post' ? ledgerMovesApi.moves.post(id) : ledgerMovesApi.moves.remove(id)),
    onSuccess: (_r, v) => {
      setBlocked(b => (b?.kind === 'drafts' ? { ...b, body: { ...b.body, ids: b.body.ids.filter(x => x !== v.id), drafts: b.body.drafts?.filter(d => d.id !== v.id), count: Math.max(0, b.body.count - 1) } } : b));
      qc.invalidateQueries({ queryKey: ['ledger', 'moves'] });
    },
    onError: (err: unknown) => toast.error(ledgerErrorMessage(tr, ledgerErrorOf(err))),
  });

  // «مزامنة الآن» ثم إعادة المحاولة (§8.3)
  const syncNow = useMutation({
    mutationFn: async () => (await ledgerConfigApi.sync()).data,
    onSuccess: (r) => {
      if (r.running) toast(`${tr('المزامنة جارية الآن، أعد المحاولة بعد قليل')} (${r.pendingEvents})`);
      qc.invalidateQueries({ queryKey: ledgerKeys.lockDates });
      setBlocked(null);
      save.mutate();
    },
    onError: (err: unknown) => {
      const e = ledgerErrorOf(err);
      toast.error(e?.reason === 'LEDGER_WORKER_UNAVAILABLE' ? tr('معالج الترحيل غير متاح حاليا') : ledgerErrorMessage(tr, e));
    },
  });

  const eventsRoute = findLedgerRoute('review/events');

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="lock-dates-title">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#F1EBDF]">
          <Lock size={18} className="text-[#E15A30]" />
          <h2 id="lock-dates-title" className="text-lg font-bold text-[#1F1A13] flex-1">{tr('تواريخ الإقفال')}</h2>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="p-1 rounded hover:bg-[#F1EBDF]"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {q.isLoading && <p className="text-sm text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
          {q.isError && <p className="text-sm text-[#C0392B]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية إقفال الفترات') : tr('تعذر تحميل تواريخ الإقفال')}</p>}
          {q.data && LOCK_DATE_FIELDS.map(f => (
            <div key={f}>
              <label className="label" htmlFor={`lock-${f}`}>{labels[f].label}</label>
              <div className="flex items-center gap-2">
                <input id={`lock-${f}`} type="date" dir="ltr" className="input flex-1" disabled={!canWrite} max={q.data?.today}
                  value={form[f] ?? ''} onChange={e => { setBlocked(null); setForm(s => ({ ...s, [f]: e.target.value || null })); }} />
                {form[f] && canWrite && f !== 'hardLockDate' && (
                  <button type="button" className="text-xs text-[#6E6557] underline" onClick={() => setForm(s => ({ ...s, [f]: null }))}>{tr('مسح')}</button>
                )}
              </div>
              <p className="text-[11px] text-[#9A8F7E] mt-1">
                {labels[f].hint} · {tr('الحالي')}: <bdi>{q.data[f] ? formatDayOnly(q.data[f]) : tr('غير مضبوط')}</bdi>
              </p>
            </div>
          ))}
          {hardBackward && (
            <p className="text-sm text-[#C0392B] flex items-center gap-1"><AlertTriangle size={14} />{tr('لا يمكن إرجاع تاريخ الإقفال النهائي')}</p>
          )}

          {blocked?.kind === 'message' && <p className="rounded-xl bg-[#FBE3DF] text-[#8E2A1F] text-sm p-3">{blocked.text}</p>}

          {blocked?.kind === 'sync' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2 text-sm">
              <p className="font-semibold text-amber-900 flex items-center gap-1"><AlertTriangle size={14} />{tr('الترحيل الآلي لم يلحق بتاريخ الإقفال بعد')}</p>
              {blocked.body.backfillState && blocked.body.backfillState !== 'DONE' && (
                <p>{tr('حالة الترحيل التاريخي')}: <bdi className="font-mono text-xs">{blocked.body.backfillState}</bdi></p>
              )}
              {blocked.body.laggingSources?.length > 0 && (
                <div>
                  <p className="font-semibold">{tr('المصادر المتأخرة')}</p>
                  <ul className="text-xs space-y-0.5">
                    {blocked.body.laggingSources.map(s => (
                      <li key={s.source}><bdi className="font-mono">{s.source}</bdi> — {tr('آخر مؤشر')}: {s.watermarkAt ? formatDateTime(s.watermarkAt) : '—'} · {tr('آخر تشغيل')}: {s.lastRunAt ? formatDateTime(s.lastRunAt) : '—'}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blocked.body.events?.length > 0 && (
                <div>
                  <p className="font-semibold">{tr('أحداث غير مرحّلة')} <span className="tabular-nums font-normal">({blocked.body.eventCount})</span></p>
                  <ul className="text-xs space-y-0.5 max-h-40 overflow-auto">
                    {blocked.body.events.map(ev => (
                      <li key={ev.id}><bdi className="font-mono">{ev.sourceKey}</bdi> · {ev.status} · {formatDateTime(ev.effectAt)}{ev.lastError ? <> · <span className="text-[#C0392B]">{ev.lastError}</span></> : null}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button type="button" className="btn-secondary !py-1 !px-2 text-xs inline-flex items-center gap-1 disabled:opacity-50"
                  disabled={syncNow.isPending || save.isPending || changed.length === 0} onClick={() => syncNow.mutate()}>
                  <RefreshCw size={12} className={syncNow.isPending ? 'animate-spin' : ''} />{tr('مزامنة الآن')}
                </button>
                <span className="text-xs text-amber-900">{tr('الترحيل الآلي يلحق تلقائيا، أعد المحاولة بعد قليل')}</span>
                {eventsRoute && canLedger(user, eventsRoute.view) && (
                  <Link to={`${ledgerHref('review/events')}${blocked.date ? `?dateTo=${blocked.date}` : ''}`} onClick={onClose} className="text-xs text-[#E15A30] hover:underline">
                    {tr('مراجعة ← أحداث الترحيل')}
                  </Link>
                )}
              </div>
            </div>
          )}

          {blocked?.kind === 'drafts' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2 text-sm">
              <p className="font-semibold text-amber-900 flex items-center gap-1"><AlertTriangle size={14} />{tr('توجد مسودات بتاريخ قبل الإقفال')} <span className="tabular-nums font-normal">({blocked.body.count})</span></p>
              <ul className="text-xs space-y-1 max-h-48 overflow-auto">
                {(blocked.body.drafts ?? blocked.body.ids.map(id => ({ id, date: '', ref: null as string | null }))).map(d => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2">
                    <span className="flex-1 min-w-0 truncate">{d.date ? formatDayOnly(d.date) : ''} {d.ref ?? ''}</span>
                    {canPost && <button type="button" className="text-[#E15A30] hover:underline disabled:opacity-50" disabled={draftAction.isPending} onClick={() => draftAction.mutate({ id: d.id, action: 'post' })}>{tr('ترحيل')}</button>}
                    <Link to={ledgerHref(`entries/${d.id}`)} onClick={onClose} className="text-[#E15A30] hover:underline">{tr('تعديل')}</Link>
                    {canPost && <button type="button" className="text-[#C0392B] hover:underline disabled:opacity-50" disabled={draftAction.isPending} onClick={() => draftAction.mutate({ id: d.id, action: 'delete' })}>{tr('حذف')}</button>}
                  </li>
                ))}
              </ul>
              {blocked.body.listUrl && <Link to={blocked.body.listUrl} onClick={onClose} className="text-xs text-[#E15A30] hover:underline">{tr('عرض المسودات في قيود اليومية')}</Link>}
            </div>
          )}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          {canWrite && (
            <button type="button" className="btn-primary disabled:opacity-50" disabled={changed.length === 0 || hardBackward || save.isPending} onClick={() => { setBlocked(null); save.mutate(); }}>
              {save.isPending ? tr('جاري الحفظ') : tr('حفظ')}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

export default LockDatesDialog;
