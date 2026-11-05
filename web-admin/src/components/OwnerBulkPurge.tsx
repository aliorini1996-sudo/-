/**
 * «حذف المحدد» في قوائم الأقسام — لمالك المنصة وحده داخل جلسة «دخول» أصدرها هو (الخادم يحرسه: routes/ownerPurge.ts).
 * الاستعمال في صفحة قائمة:
 *   const purge = useOwnerBulkPurge('Invoice');
 *   {purge.bar}                                   ← شريط «حذف المحدد (n)» فوق الجدول (لا يظهر إلا للمالك وبتحديد)
 *   {purge.enabled && <th>{purge.headerBox(rows.map(r => r.id))}</th>}
 *   {purge.enabled && <td>{purge.rowBox(row.id)}</td>}
 * الحذف: معاينة ما يُحذف مع المحدد ← تأكيد ← حذف نهائي (معاملة واحدة: كله أو لا شيء) ← تحديث كل القوائم.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, X, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { isOwnerIssuedSession, PURGE_LABELS } from './OwnerPurgeModal';

interface Preview { counts: Record<string, number>; nullCounts: Record<string, number> }
const labelOf = (m: string) => PURGE_LABELS[m] ?? m;
const errMsg = (e: unknown, fb: string) => (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? fb;

export interface OwnerBulkPurge {
  enabled: boolean;
  selected: ReadonlySet<string>;
  headerBox(ids: readonly string[]): ReactNode;
  rowBox(id: string): ReactNode;
  bar: ReactNode;
}

export function useOwnerBulkPurge(model: string): OwnerBulkPurge {
  const token = useAuthStore((s) => s.token);
  const enabled = isOwnerIssuedSession(token);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = useMemo(() => [...selected], [selected]);

  const openPreview = async () => {
    setBusy(true);
    try {
      const r = await api.post('/owner-purge/preview', { model, ids });
      setPreview(r.data?.data ?? null);
    } catch (e) { toast.error(errMsg(e, 'تعذرت المعاينة')); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.post('/owner-purge/delete', { model, ids });
      toast.success(`تم الحذف النهائي (${ids.length})`);
      setPreview(null); setSelected(new Set());
      await qc.invalidateQueries();
    } catch (e) { toast.error(errMsg(e, 'تعذر الحذف')); }
    finally { setBusy(false); }
  };

  const box = (checked: boolean, onChange: () => void, title: string) => (
    <input type="checkbox" className="w-4 h-4 accent-red-600 cursor-pointer" checked={checked} title={title}
      onChange={onChange} onClick={(e) => e.stopPropagation()} />
  );

  const headerBox = (pageIds: readonly string[]) => {
    const all = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
    return box(all, () => setSelected((s) => {
      const n = new Set(s);
      if (all) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id));
      return n;
    }), 'تحديد الكل في هذه الصفحة');
  };
  const rowBox = (id: string) => box(selected.has(id), () => toggle(id), 'تحديد للحذف النهائي');

  const rows = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);
  const bar = enabled && selected.size > 0 ? (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-red-200 bg-red-50 px-3 py-2 mb-3" dir="rtl">
        <span className="text-sm font-semibold text-red-700">محدد للحذف النهائي: {selected.size}</span>
        <span className="flex items-center gap-2">
          <button type="button" className="btn-secondary !py-1 !px-3 text-xs" onClick={() => setSelected(new Set())}>إلغاء التحديد</button>
          <button type="button" disabled={busy} onClick={openPreview}
            className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-3 py-1.5 disabled:opacity-60">
            <Trash2 size={13} /> حذف المحدد ({selected.size})
          </button>
        </span>
      </div>
      {preview && (
        <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4" dir="rtl" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-red-700 flex items-center gap-2"><AlertTriangle size={17} /> حذف نهائي — لا يمكن التراجع</h3>
              <button type="button" onClick={() => setPreview(null)} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
            </div>
            <p className="text-sm font-semibold text-[#1F1A13]">سيُحذف نهائياً:</p>
            <ul className="text-sm space-y-0.5">{rows(preview.counts).map(([m, n]) => <li key={m}>{labelOf(m)}: <b>{n}</b></li>)}</ul>
            {Object.keys(preview.nullCounts).length > 0 && (
              <>
                <p className="text-sm text-[#6E6557]">ويبقى مع إزالة ربطه بالمحذوف:</p>
                <ul className="text-sm space-y-0.5 text-[#6E6557]">{rows(preview.nullCounts).map(([m, n]) => <li key={m}>{labelOf(m)}: {n}</li>)}</ul>
              </>
            )}
            <div className="flex gap-2 pt-1">
              <button type="button" disabled={busy} onClick={doDelete}
                className="flex-1 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold py-2 disabled:opacity-60 flex items-center justify-center gap-2">
                <Trash2 size={15} /> حذف نهائي
              </button>
              <button type="button" className="btn-secondary" onClick={() => setPreview(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </>
  ) : null;

  return { enabled, selected, headerBox, rowBox, bar };
}
