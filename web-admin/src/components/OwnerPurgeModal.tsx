/**
 * «حذف نهائي» — لمالك المنصة وحده داخل جلسة «دخول» أصدرها هو (الخادم يحرسها: routes/ownerPurge.ts).
 * اختر النوع ← ابحث بالرقم أو الاسم ← معاينة ما سيُحذف معه ← حذف نهائي لا رجعة فيه.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Trash2, Search, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';

/** أسماء عربية للأنواع الشائعة — وغيرها يظهر باسمه التقني */
export const PURGE_LABELS: Record<string, string> = {
  Invoice: 'فاتورة / مرتجع', Receipt: 'سند قبض', VanLoad: 'تحميل / تنزيل سيارة', WarehouseEntry: 'حركة مستودع',
  SalesLocation: 'لوكيشن', Customer: 'عميل', Product: 'صنف', SalesRep: 'مندوب', Admin: 'مستخدم الشركة',
  FieldVisit: 'زيارة ميدانية', Visit: 'زيارة', RepStockRequest: 'طلب بضاعة', AccountEntry: 'قيد كشف حساب',
  InvoiceItem: 'بند فاتورة', ReceiptInvoice: 'تخصيص سند', VanLoadItem: 'بند تحميل', WarehouseEntryItem: 'بند مستودع',
  ProductLot: 'تشغيلة LOT', Team: 'فريق', CustomerPrice: 'سعر عميل', PriceList: 'نوع سعر', RepRoute: 'خط سير',
  AttendanceShift: 'بصمة حضور', PaymentMethod: 'طريقة دفع', ZatcaDocument: 'مستند الهيئة',
};
const COMMON = ['Invoice', 'Receipt', 'VanLoad', 'WarehouseEntry', 'SalesLocation', 'Customer', 'Product', 'SalesRep', 'Admin', 'RepStockRequest'];
const labelOf = (m: string) => PURGE_LABELS[m] ?? m;

/** جلسة «دخول» أصدرها المالك (لا موظف المنصة) — من حمولة التوكن */
export function isOwnerIssuedSession(token: string | null | undefined): boolean {
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(String(token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
    return p?.impersonated === true && p?.byKind === 'OWNER';
  } catch { return false; }
}

interface Hit { id: string; label: string }
interface Preview { counts: Record<string, number>; nullCounts: Record<string, number> }

export default function OwnerPurgeModal({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const [models, setModels] = useState<string[]>(COMMON);
  const [model, setModel] = useState('Invoice');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [pick, setPick] = useState<Hit | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/owner-purge/models').then((r) => {
      const all: string[] = (r.data?.data ?? []).map((x: { model: string }) => x.model);
      setModels([...COMMON.filter((m) => all.includes(m)), ...all.filter((m) => !COMMON.includes(m))]);
    }).catch(() => { /* القائمة الشائعة تكفي */ });
  }, []);

  const search = async () => {
    setBusy(true); setPick(null); setPreview(null);
    try {
      const r = await api.get('/owner-purge/search', { params: { model, q } });
      setHits(r.data?.data ?? []);
      if (!(r.data?.data ?? []).length) toast.error('لا نتائج');
    } catch (e) { toast.error((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'تعذر البحث'); }
    finally { setBusy(false); }
  };

  const choose = async (h: Hit) => {
    setPick(h); setPreview(null); setBusy(true);
    try {
      const r = await api.post('/owner-purge/preview', { model, id: h.id });
      setPreview(r.data?.data ?? null);
    } catch (e) { toast.error((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'تعذرت المعاينة'); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!pick || !preview) return;
    const total = Object.values(preview.counts).reduce((a, b) => a + b, 0);
    if (!window.confirm(`حذف نهائي لـ«${pick.label}» ومعه ${total} سجلاً — لا يمكن التراجع. متابعة؟`)) return;
    setBusy(true);
    try {
      await api.post('/owner-purge/delete', { model, id: pick.id });
      toast.success('تم الحذف النهائي');
      await qc.invalidateQueries();
      setHits((h) => h.filter((x) => x.id !== pick.id)); setPick(null); setPreview(null);
    } catch (e) { toast.error((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'تعذر الحذف'); }
    finally { setBusy(false); }
  };

  const rows = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);

  return (
    <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Trash2 size={18} className="text-red-600" /> حذف نهائي — مالك المنصة</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr_auto] gap-2">
          <select className="input" value={model} onChange={(e) => { setModel(e.target.value); setHits([]); setPick(null); setPreview(null); }}>
            {models.map((m) => <option key={m} value={m}>{labelOf(m)}</option>)}
          </select>
          <input className="input" placeholder="الرقم أو الاسم أو الرمز" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
          <button type="button" className="btn-secondary" disabled={busy} onClick={search}><Search size={15} /> بحث</button>
        </div>

        {hits.length > 0 && (
          <div className="border rounded-xl divide-y max-h-56 overflow-y-auto">
            {hits.map((h) => (
              <button key={h.id} type="button" onClick={() => choose(h)}
                className={`w-full text-right px-3 py-2 text-sm hover:bg-[#FAF7F0] ${pick?.id === h.id ? 'bg-red-50 font-semibold' : ''}`}>{h.label}</button>
            ))}
          </div>
        )}

        {pick && preview && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 space-y-2 text-sm">
            <p className="font-semibold text-red-700 flex items-center gap-1.5"><AlertTriangle size={15} /> سيُحذف نهائياً:</p>
            <ul className="space-y-0.5">{rows(preview.counts).map(([m, n]) => <li key={m}>{labelOf(m)}: <b>{n}</b></li>)}</ul>
            {Object.keys(preview.nullCounts).length > 0 && (
              <>
                <p className="text-[#6E6557] pt-1">ويبقى مع إزالة ربطه به:</p>
                <ul className="space-y-0.5 text-[#6E6557]">{rows(preview.nullCounts).map(([m, n]) => <li key={m}>{labelOf(m)}: {n}</li>)}</ul>
              </>
            )}
            <button type="button" disabled={busy} onClick={doDelete}
              className="w-full mt-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold py-2 disabled:opacity-60 flex items-center justify-center gap-2">
              <Trash2 size={15} /> حذف نهائي
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
