/**
 * «الأصناف المؤرشفة (النسخ المخفية)» — لمالك المنصة وحده داخل جلسة «دخول» أصدرها هو (الخادم يحرسها: routes/ownerPurge.ts).
 *
 * قبل ٥ نوفمبر ٢٠٢٦ كان حذف صنفٍ له تحميلات أو فواتير يؤرشفه فقط، فأعاد المديرون إنشاءه بالاسم نفسه ورمزٍ جديد:
 * يبقى رصيد السيارة على النسخة المخفية (لا تنقص أبداً) ويبيع المندوب الصنف الحالي فيظهر بالسالب.
 * هنا يُدمج المؤرشف في توأمه الحالي (تُنقل الحركات والفواتير والكميات ثم تُحذف النسخة المخفية)،
 * أو يُحذف نهائياً ما لا توأم له بمحرّك «حذف نهائي» نفسه.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Archive, GitMerge, Trash2, AlertTriangle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';
import { PURGE_LABELS } from './OwnerPurgeModal';
import { formatDateShort, formatNumber } from '../utils/format';

interface ProductRef { id: string; code: string; name: string; unit: string }
type TwinReason = 'NAME' | 'NONE' | 'AMBIGUOUS' | 'UNIT_MISMATCH';
interface ArchivedRow extends ProductRef {
  deletedAt: string;
  twin: ProductRef | null;
  twinReason: TwinReason;
  vanBalance: number;
  vans: Array<{ salesRepId: string; repName: string | null; remaining: number }>;
  counts: { invoiceItems: number; vanLoadItems: number; warehouseEntryItems: number };
}
interface MergeOk { fromId: string; toId: string; moved: Record<string, number> }
interface MergeFail { fromId: string; toId: string; code: string; message: string }
interface Preview { counts: Record<string, number>; nullCounts: Record<string, number> }

/** سبب غياب الصنف الحالي المطابق */
const REASON_LABELS: Record<TwinReason, string> = {
  NAME: '',
  NONE: 'لا يوجد صنف حالي بالاسم نفسه',
  AMBIGUOUS: 'أكثر من صنف بالاسم نفسه',
  UNIT_MISMATCH: 'الوحدة مختلفة',
};

const MERGE_BATCH = 15; // دفعات صغيرة: كل زوجٍ معاملةٌ في الخادم، فالطلب القصير لا يُقطع والنتائج تصل تباعاً
const DELETE_BATCH = 500; // حدّ الخادم لكل طلب حذف نهائي

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? fallback;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const labelOf = (m: string) => PURGE_LABELS[m] ?? m;

export default function ArchivedProductsModal({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<ArchivedRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await api.get('/owner-purge/archived-products');
      const list: ArchivedRow[] = Array.isArray(r.data?.data) ? r.data.data : [];
      setRows(list);
      // يبقى محدَّداً ما زال في القائمة فقط (ما دُمج أو حُذف يخرج منها)
      setSel((s) => new Set([...s].filter((id) => list.some((x) => x.id === id))));
    } catch (e) {
      setLoadError(errMsg(e, 'تعذّر جلب الأصناف المؤرشفة'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const selected = useMemo(() => (rows ?? []).filter((r) => sel.has(r.id)), [rows, sel]);
  const toMerge = selected.filter((r) => !!r.twin);
  const toDelete = selected.filter((r) => !r.twin);
  const allChecked = !!rows?.length && rows.every((r) => sel.has(r.id));

  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set((rows ?? []).map((r) => r.id)));
  const selectMergeable = () => setSel(new Set((rows ?? []).filter((r) => !!r.twin).map((r) => r.id)));

  const nameOf = (id: string) => {
    const r = byId.get(id);
    return r ? `«${r.name}»${r.code ? ` (${r.code})` : ''}` : id;
  };

  const refreshAll = async () => {
    await qc.invalidateQueries();
    await load();
  };

  const doMerge = async () => {
    if (!toMerge.length || busy) return;
    const bal = toMerge.reduce((a, r) => a + num(r.vanBalance), 0);
    const ok = window.confirm(
      `دمج ${formatNumber(toMerge.length)} صنفاً مؤرشفاً في الصنف الحالي المطابق.\n\n`
      + 'تُنقل الكميات والحركات والفواتير من النسخة المخفية إلى الصنف الحالي ثم تُحذف النسخة المخفية — لا يمكن التراجع.'
      + (bal ? `\n\nالكمية في السيارات التي ستنتقل: ${formatNumber(bal)}` : '')
      + '\n\nمتابعة؟',
    );
    if (!ok) return;
    setBusy(true);
    const merged: MergeOk[] = [];
    const failed: MergeFail[] = [];
    try {
      const pairs = toMerge.map((r) => ({ fromId: r.id, toId: r.twin!.id }));
      for (let i = 0; i < pairs.length; i += MERGE_BATCH) {
        const chunk = pairs.slice(i, i + MERGE_BATCH);
        try {
          const r = await api.post('/owner-purge/archived-products/merge', { pairs: chunk });
          const d = (r.data?.data ?? {}) as { merged?: MergeOk[]; failed?: MergeFail[] };
          merged.push(...(d.merged ?? []));
          failed.push(...(d.failed ?? []));
        } catch (e) {
          const m = errMsg(e, 'تعذّر الدمج — قد يكون بعضها دُمج، والقائمة بعد التحديث هي المرجع');
          failed.push(...chunk.map((p) => ({ ...p, code: 'REQUEST_FAILED', message: m })));
        }
      }
      if (merged.length) toast.success(`تم دمج ${formatNumber(merged.length)} صنفاً في الصنف الحالي`);
      if (failed.length) {
        toast.error(
          <div className="space-y-1 text-sm" dir="rtl">
            <p className="font-semibold">تعذّر دمج {formatNumber(failed.length)} صنفاً{merged.length ? ` (ونجح ${formatNumber(merged.length)})` : ''}:</p>
            <ul className="list-disc pr-4 space-y-0.5">
              {failed.slice(0, 8).map((f) => <li key={`${f.fromId}-${f.toId}`}>{nameOf(f.fromId)}: {f.message || f.code}</li>)}
            </ul>
            {failed.length > 8 && <p>و{formatNumber(failed.length - 8)} غيرها</p>}
          </div>,
          { duration: 12000 },
        );
      }
      if (!merged.length && !failed.length) toast('لم يُدمج شيء');
    } finally {
      setBusy(false);
    }
    await refreshAll();
  };

  const doDelete = async () => {
    if (!toDelete.length || busy) return;
    const ids = toDelete.map((r) => r.id);
    setBusy(true);
    try {
      // معاينة ما سيُحذف معه وما يبقى مع إزالة ربطه — للدفعة الأولى (حدّ الخادم ٥٠٠)
      let previewText = '';
      try {
        const r = await api.post('/owner-purge/preview', { model: 'Product', ids: ids.slice(0, DELETE_BATCH) });
        const p = (r.data?.data ?? null) as Preview | null;
        if (p) {
          const fmt = (m: Record<string, number>) => Object.entries(m).filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1]).map(([k, n]) => `• ${labelOf(k)}: ${formatNumber(n)}`).join('\n');
          const del = fmt(p.counts ?? {});
          const nul = fmt(p.nullCounts ?? {});
          previewText = (del ? `\n\nسيُحذف نهائياً:\n${del}` : '') + (nul ? `\n\nويبقى مع إزالة ربطه بالصنف:\n${nul}` : '');
        }
      } catch { /* المعاينة اختيارية — التأكيد يكفي */ }
      const bal = toDelete.reduce((a, r) => a + num(r.vanBalance), 0);
      const ok = window.confirm(
        `حذف نهائي لـ${formatNumber(toDelete.length)} صنفاً مؤرشفاً بلا دمج (لا صنف حالي مطابق لها، أو المطابقة غير مؤكدة: أكثر من صنف بالاسم نفسه أو وحدة مختلفة).`
        + (bal ? `\n\nتنبيه: لها كمية ${formatNumber(bal)} في السيارات ستختفي من مخزونها.` : '')
        + previewText
        + '\n\nلا يمكن التراجع. متابعة؟',
      );
      if (!ok) return;
      let done = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const chunk = ids.slice(i, i + DELETE_BATCH);
        try {
          await api.post('/owner-purge/delete', { model: 'Product', ids: chunk });
          done += chunk.length;
        } catch (e) {
          errors.push(errMsg(e, 'تعذّر الحذف'));
        }
      }
      if (done) toast.success(`تم الحذف النهائي لـ${formatNumber(done)} صنفاً`);
      if (errors.length) toast.error(`تعذّر حذف ${formatNumber(ids.length - done)} صنفاً: ${errors.join(' — ')}`, { duration: 10000 });
    } finally {
      setBusy(false);
    }
    await refreshAll();
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Archive size={18} className="text-amber-600" /> المحذوفات المخفية — الأصناف المؤرشفة والعملاء المحذوفون سابقاً</h3>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => void load()} disabled={loading || busy} title="تحديث"
              className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-50"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
          </div>
        </div>

        <p className="text-sm text-[#6E6557] leading-relaxed">
          أصناف حُذفت قبل ٥ نوفمبر فأُرشفت بدل حذفها، ثم أُنشئ صنف جديد بالاسم نفسه. تبقى كمية السيارات على النسخة المخفية
          ويظهر الصنف الحالي بالسالب. الدمج ينقل كل شيء إلى الصنف الحالي ويحذف النسخة المخفية.
        </p>

        {loadError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5"><AlertTriangle size={15} /> {loadError}</span>
            <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>إعادة المحاولة</button>
          </div>
        )}

        {rows === null && !loadError && <p className="text-sm text-[#6E6557] py-6 text-center">جارٍ التحميل…</p>}

        {rows !== null && rows.length === 0 && (
          <p className="text-sm text-[#6E6557] py-8 text-center">لا توجد أصناف مؤرشفة في هذه الشركة</p>
        )}

        {rows !== null && rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[#6E6557]">{formatNumber(rows.length)} صنفاً مؤرشفاً — منها {formatNumber(rows.filter((r) => !!r.twin).length)} لها صنف حالي مطابق</span>
              <button type="button" onClick={selectMergeable} disabled={busy} className="text-[#E15A30] hover:underline disabled:opacity-50">تحديد القابلة للدمج</button>
              {sel.size > 0 && <button type="button" onClick={() => setSel(new Set())} disabled={busy} className="text-[#6E6557] hover:underline disabled:opacity-50">إلغاء التحديد</button>}
            </div>

            <div className="border rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FAF7F0] text-[#6E6557]">
                  <tr>
                    <th className="p-2 w-8"><input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={busy} aria-label="تحديد الكل" /></th>
                    <th className="p-2 text-right font-semibold">الصنف المؤرشف</th>
                    <th className="p-2 text-right font-semibold">الكمية في السيارات</th>
                    <th className="p-2 text-right font-semibold">الصنف الحالي المطابق</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const vans = (r.vans ?? []).filter((v) => num(v.remaining) !== 0);
                    return (
                      <tr key={r.id} className={sel.has(r.id) ? (r.twin ? 'bg-amber-50' : 'bg-red-50') : ''}>
                        <td className="p-2 align-top">
                          <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} disabled={busy}
                            aria-label={`تحديد ${r.name}`} />
                        </td>
                        <td className="p-2 align-top">
                          <p className="font-semibold text-[#1F1A13]">{r.name}</p>
                          <p className="text-xs text-[#6E6557]">
                            {r.code ? <>الرمز <span dir="ltr">{r.code}</span></> : 'بلا رمز'}
                            {r.unit ? ` · ${r.unit}` : ''}
                            {r.deletedAt ? ` · أُرشف ${formatDateShort(r.deletedAt)}` : ''}
                          </p>
                          {r.counts && (
                            <p className="text-[11px] text-[#9A8F7E]">
                              بنود فواتير {formatNumber(num(r.counts.invoiceItems))} · بنود تحميل {formatNumber(num(r.counts.vanLoadItems))} · بنود مستودع {formatNumber(num(r.counts.warehouseEntryItems))}
                            </p>
                          )}
                        </td>
                        <td className="p-2 align-top">
                          <p className={`font-semibold ${num(r.vanBalance) < 0 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{formatNumber(num(r.vanBalance))}</p>
                          {vans.length > 0 && (
                            <ul className="text-[11px] text-[#6E6557] space-y-0.5 mt-0.5">
                              {vans.map((v) => <li key={v.salesRepId}>{v.repName || 'مندوب'}: {formatNumber(num(v.remaining))}</li>)}
                            </ul>
                          )}
                        </td>
                        <td className="p-2 align-top">
                          {r.twin ? (
                            <>
                              <p className="font-semibold text-[#1F1A13]">{r.twin.name}</p>
                              <p className="text-xs text-[#6E6557]">
                                {r.twin.code ? <>الرمز <span dir="ltr">{r.twin.code}</span></> : 'بلا رمز'}
                                {r.twin.unit ? ` · ${r.twin.unit}` : ''}
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-gray-400">{REASON_LABELS[r.twinReason] || REASON_LABELS.NONE}</p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" disabled={busy || !toMerge.length} onClick={doMerge}
                className="flex-1 rounded-xl bg-[#E15A30] hover:bg-[#c94d26] text-white font-bold py-2 px-3 disabled:opacity-50 flex items-center justify-center gap-2">
                <GitMerge size={15} /> دمج المحدد في الصنف الحالي{toMerge.length ? ` (${formatNumber(toMerge.length)})` : ''}
              </button>
              <button type="button" disabled={busy || !toDelete.length} onClick={doDelete}
                className="flex-1 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 disabled:opacity-50 flex items-center justify-center gap-2">
                <Trash2 size={15} /> حذف نهائي للمحدد بلا دمج{toDelete.length ? ` (${formatNumber(toDelete.length)})` : ''}
              </button>
            </div>
            <p className="text-[11px] text-[#9A8F7E]">
              الدمج للأصناف التي لها صنف حالي مطابق، والحذف النهائي لما لا صنف مطابق له. كلاهما لا يمكن التراجع عنه.
            </p>
          </>
        )}

        <ArchivedCustomersSection onChanged={() => qc.invalidateQueries()} />
      </div>
    </div>
  );
}

interface ArchivedCustomer { id: string; name: string; code: string | null; phone: string | null; balance: number; invoices: number; receipts: number }

/**
 * العملاء المحذوفون قبل ٥ نوفمبر (مخفيون بحالة «محذوف»). قرار المالك (٧ نوفمبر): «يُحذفون مع فواتيرهم» — حذف نهائي بمحرّك
 * «حذف نهائي» نفسه (POST /owner-purge/delete { model: 'Customer' }) بعد معاينة ما يُحذف معهم
 */
function ArchivedCustomersSection({ onChanged }: { onChanged(): void }) {
  const [rows, setRows] = useState<ArchivedCustomer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.get('/owner-purge/archived-customers');
      const list: ArchivedCustomer[] = Array.isArray(r.data?.data) ? r.data.data : [];
      setRows(list);
      setSel((s) => new Set([...s].filter((id) => list.some((x) => x.id === id))));
    } catch (e) { setErr(errMsg(e, 'تعذّر جلب العملاء المحذوفين')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const all = !!rows?.length && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const doDelete = async () => {
    const ids = [...sel];
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      let previewText = '';
      try {
        const r = await api.post('/owner-purge/preview', { model: 'Customer', ids: ids.slice(0, DELETE_BATCH) });
        const p = (r.data?.data ?? null) as Preview | null;
        if (p) {
          const del = Object.entries(p.counts ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `• ${labelOf(k)}: ${formatNumber(n)}`).join('\n');
          if (del) previewText = `\n\nسيُحذف نهائياً:\n${del}`;
        }
      } catch { /* المعاينة اختيارية */ }
      const ok = window.confirm(
        `حذف نهائي لـ${formatNumber(ids.length)} عميلاً محذوفاً سابقاً مع فواتيرهم وسنداتهم وكشف حسابهم.`
        + previewText + '\n\nلا يمكن التراجع. متابعة؟',
      );
      if (!ok) return;
      let done = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const chunk = ids.slice(i, i + DELETE_BATCH);
        try { await api.post('/owner-purge/delete', { model: 'Customer', ids: chunk }); done += chunk.length; }
        catch (e) { errors.push(errMsg(e, 'تعذّر الحذف')); }
      }
      if (done) toast.success(`تم الحذف النهائي لـ${formatNumber(done)} عميلاً مع مستنداتهم`);
      if (errors.length) toast.error(`تعذّر حذف ${formatNumber(ids.length - done)} عميلاً: ${errors.join(' — ')}`, { duration: 10000 });
    } finally { setBusy(false); }
    onChanged();
    await load();
  };

  return (
    <div className="border-t pt-4 space-y-2">
      <h4 className="font-bold text-[#1F1A13]">العملاء المحذوفون سابقاً (مخفيون)</h4>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {rows === null && !err && <p className="text-sm text-[#6E6557]">جارٍ التحميل…</p>}
      {rows !== null && rows.length === 0 && <p className="text-sm text-[#6E6557]">لا يوجد عملاء محذوفون مخفيون في هذه الشركة</p>}
      {rows !== null && rows.length > 0 && (
        <>
          <div className="border rounded-xl overflow-x-auto max-h-72">
            <table className="w-full text-sm">
              <thead className="bg-[#FAF7F0] text-[#6E6557]">
                <tr>
                  <th className="p-2 w-8"><input type="checkbox" checked={all} disabled={busy} aria-label="تحديد الكل"
                    onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                  <th className="p-2 text-right font-semibold">العميل</th>
                  <th className="p-2 text-right font-semibold">الفواتير</th>
                  <th className="p-2 text-right font-semibold">السندات</th>
                  <th className="p-2 text-right font-semibold">الرصيد</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id} className={sel.has(r.id) ? 'bg-red-50' : ''}>
                    <td className="p-2"><input type="checkbox" checked={sel.has(r.id)} disabled={busy} onChange={() => toggle(r.id)} aria-label={`تحديد ${r.name}`} /></td>
                    <td className="p-2"><p className="font-semibold text-[#1F1A13]">{r.name}</p><p className="text-xs text-[#6E6557]" dir="ltr">{r.phone || ''}</p></td>
                    <td className="p-2">{formatNumber(num(r.invoices))}</td>
                    <td className="p-2">{formatNumber(num(r.receipts))}</td>
                    <td className="p-2">{formatNumber(num(r.balance))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={busy || !sel.size} onClick={doDelete}
            className="w-full rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 disabled:opacity-50 flex items-center justify-center gap-2">
            <Trash2 size={15} /> حذف نهائي للمحدد مع فواتيرهم{sel.size ? ` (${formatNumber(sel.size)})` : ''}
          </button>
        </>
      )}
    </div>
  );
}
