/**
 * اختيار فاتورة البيع للمرتجع منها (طلب المالك ١١ أكتوبر ٢٠٢٦) — للأصناف المفعّلة صلاحيتها إلزامي: يختار المندوب
 * الفاتورة ثم يُرجع كامل أصنافها أو بعضها، فتُقاس صلاحية كل صنف على بيعه ويرى «منتهي الصلاحية» قبل الحفظ.
 *
 * الخادم يعرض فواتير البيع التي بقي فيها ما يُرجَع لعميلٍ يخدمه المندوب (ولو باعه غيره)، وبنود الفاتورة بمتاحها وسعر
 * استردادها وصلاحيتها (`GET /invoices/returnable-sales`، `GET /invoices/:id/returnable`). يلزمه اتصال.
 */
import { useEffect, useMemo, useState } from 'react';
import { X, FileText, ArrowRight, Search } from 'lucide-react';
import repApi from './repApi';
import { useTr } from '../i18n/strings';
import { formatCurrency, formatDate } from '../utils/format';

export interface ReturnableLine {
  saleItemId: string;
  productId: string;
  name: string;
  code: string;
  unit: string;
  sold: number;
  returned: number;
  returnable: number;
  refundUnitPrice: number;
  taxPct: number;
  shelfLife: boolean;
  expiresAt: string | null;
  expiredToday: boolean | null;
}

export interface ReturnableSale {
  id: string;
  number: string;
  invoiceDate: string;
  lines: ReturnableLine[];
}

/** productIds: أصناف الفاتورة التي بقي منها ما يُرجَع — للبحث بالصنف */
interface SaleRow { id: string; number: string; invoiceDate: string; total: number; type: string; itemsCount: number; returnableQty: number; productIds?: string[] }

export default function SaleInvoicePicker({ customerId, products, onPick, onClose }: {
  customerId: string;
  /** أصناف الشركة للبحث بالصنف (المنتهي صلاحيته يُرجَع من بيعٍ قد يكون قديماً) */
  products: { id: string; name: string }[];
  onPick: (sale: ReturnableSale) => void;
  onClose: () => void;
}) {
  const tr = useTr();
  const [rows, setRows] = useState<SaleRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [pid, setPid] = useState('');

  // التحميل مرّةً لكل عميل: `tr` تتجدّد في كل رسم، فوضعها في الاعتماديات يعيد الطلب بلا نهاية
  useEffect(() => {
    if (!navigator.onLine) { setMsg(tr('اختيار فاتورة البيع يتطلب اتصالا بالانترنت')); setRows([]); return; }
    (async () => {
      try {
        const r = await repApi.get('/invoices/returnable-sales', { params: { customerId } });
        setRows(r.data.data as SaleRow[]);
      } catch (e: any) {
        setMsg(e?.response?.data?.message || tr('تعذر تحميل فواتير البيع'));
        setRows([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // أصناف الفواتير المعروضة وحدها في قائمة البحث بالصنف، والتصفية بالرقم والصنف
  const productOptions = useMemo(() => {
    const ids = new Set((rows ?? []).flatMap(r => r.productIds ?? []));
    return products.filter(p => ids.has(p.id));
  }, [rows, products]);
  const shown = (rows ?? []).filter(r => (!q.trim() || r.number.includes(q.trim())) && (!pid || (r.productIds ?? []).includes(pid)));

  const pick = async (row: SaleRow) => {
    setBusy(row.id); setMsg('');
    try {
      const r = await repApi.get(`/invoices/${row.id}/returnable`);
      const sale = r.data.data as ReturnableSale;
      if (!sale.lines.some(l => l.returnable > 0)) { setMsg(tr('لا يوجد في هذه الفاتورة ما يمكن إرجاعه')); setBusy(null); return; }
      onPick(sale);
    } catch (e: any) {
      setMsg(e?.response?.data?.message || tr('تعذر تحميل بنود الفاتورة'));
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end" dir="rtl" onClick={onClose}>
      <div className="bg-white w-full rounded-t-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <span className="font-bold text-gray-800 flex items-center gap-2"><FileText size={17} className="text-amber-600" />{tr('اختر فاتورة البيع')}</span>
          <button onClick={onClose} className="p-1.5 text-gray-500"><X size={18} /></button>
        </div>
        <p className="px-4 pt-3 text-[11px] text-gray-500 leading-relaxed">
          {tr('اختر الفاتورة التي يرجع منها العميل ثم أبق كامل أصنافها أو بعضها')}
        </p>
        {(rows?.length ?? 0) > 0 && (
          <div className="px-3 pt-3 grid grid-cols-2 gap-2">
            <label className="relative">
              <Search size={13} className="absolute top-1/2 -translate-y-1/2 right-2.5 text-gray-400" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('رقم الفاتورة')} dir="ltr"
                className="w-full border border-gray-200 rounded-xl py-2 pr-7 pl-2 text-xs" />
            </label>
            <select value={pid} onChange={e => setPid(e.target.value)} className="w-full border border-gray-200 rounded-xl py-2 px-2 text-xs bg-white">
              <option value="">{tr('كل الأصناف')}</option>
              {productOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {rows === null ? (
            <p className="text-center text-gray-400 py-8 text-sm">{tr('جاري التحميل')}</p>
          ) : shown.length === 0 && !msg ? (
            <p className="text-center text-gray-400 py-8 text-sm">{tr('لا توجد فواتير بيع يمكن الإرجاع منها لهذا العميل')}</p>
          ) : shown.map(row => (
            <button key={row.id} disabled={!!busy} onClick={() => pick(row)}
              className="w-full bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-3 text-right disabled:opacity-60">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-gray-800">{row.number}</p>
                <p className="text-[11px] text-gray-500">
                  {formatDate(row.invoiceDate)} · {row.itemsCount} {tr('صنف')} · {tr('المتاح للإرجاع')} {Number(row.returnableQty.toFixed(3))}
                </p>
              </div>
              <span className="text-sm font-bold text-gray-700">{formatCurrency(row.total)}</span>
              {busy === row.id ? <span className="w-4 h-4 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" /> : <ArrowRight size={16} className="text-gray-300 rotate-180" />}
            </button>
          ))}
          {msg && <p className="text-center text-xs text-red-500 py-2">{msg}</p>}
        </div>
      </div>
    </div>
  );
}
