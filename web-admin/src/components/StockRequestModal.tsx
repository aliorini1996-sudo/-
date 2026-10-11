import { useMemo, useState } from 'react';
import { ClipboardList, FileDown, Search, X } from 'lucide-react';
import { useTr } from '../i18n/strings';
import DocumentModal from './DocumentModal';
import type { Company, StockRequestDoc } from '../rep/RepDocuments';
import {
  stockRequestLines, stockRequestTotalQty, stockRequestRef, stockRequestToLabel, isInvalidRequestQty, isShort, shortFirst,
  type StockRequestTo, type StockRequestSourceRow,
} from '../lib/stockRequest';

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

/** اليوم بتوقيت الجهاز YYYY-MM-DD — حدٌّ أدنى لخانة «مطلوب قبل» */
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * طلب مخزون من صفحة مخزون الشركة: يكتب المسؤول الكمية المطلوبة أمام كل صنف ويختار
 * الجهة، ثم يصدر ورقة PDF يرسلها لإدارة المشتريات أو الإنتاج. لا يُحفظ شيءٌ ولا
 * يتغيّر رصيد — انظر `lib/stockRequest.ts`.
 *
 * والورقة تُفتح فوق النموذج لا مكانه: «تم» تعيد إلى الكميات كما كُتبت، فتصحيح
 * سطرٍ واحد لا يعني كتابة الطلب كله من جديد.
 */
export default function StockRequestModal({ rows, company, by, onClose }: {
  rows: StockRequestSourceRow[]; company: Company | null; by?: string; onClose: () => void;
}) {
  const tr = useTr();
  const [to, setTo] = useState<StockRequestTo>('PURCHASING');
  const [neededBy, setNeededBy] = useState('');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [shortOnly, setShortOnly] = useState(false);
  const [doc, setDoc] = useState<StockRequestDoc | null>(null);

  // الناقص أولاً — هو ما يُطلب غالباً — والورقة تُطبع بالترتيب نفسه الذي رآه المستخدم
  const ordered = useMemo(() => shortFirst(rows), [rows]);
  const q = search.trim().toLowerCase();
  const visible = ordered.filter(r => (!shortOnly || isShort(r))
    && (!q || r.name.toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q)));
  // الأسطر من كل الأصناف لا المعروضة وحدها: البحث يُخفي صنفاً من الشاشة لا من الطلب
  const lines = stockRequestLines(ordered, qty);
  const totalQty = stockRequestTotalQty(lines);
  const anyInvalid = Object.values(qty).some(isInvalidRequestQty);

  const issue = () => {
    const now = new Date();
    setDoc({
      kind: 'stockRequest', company, ref: stockRequestRef(now), date: now.toISOString(),
      to, neededBy: neededBy || undefined, note: note.trim() || undefined, by: by || undefined, items: lines,
    });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
          <div className="flex items-start justify-between gap-3 p-5 border-b border-[#E9E1D3]">
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><ClipboardList size={20} className="text-[#E15A30]" /> {tr('طلب مخزون')}</h2>
              <p className="text-xs text-[#9A8F7E] mt-1">{tr('اكتب الكمية المطلوبة أمام كل صنف ثم أصدر الملف وأرسله للجهة المختصة')}</p>
            </div>
            <button onClick={onClose} aria-label={tr('إلغاء')} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto">
            {/* الجهة الموجَّه إليها الطلب */}
            <div>
              <label className="label">{tr('موجه إلى')}</label>
              <div className="grid grid-cols-2 gap-2">
                {(['PURCHASING', 'PRODUCTION'] as const).map(t => (
                  <button key={t} type="button" onClick={() => setTo(t)}
                    className={`py-2.5 rounded-xl border text-sm font-semibold ${to === t ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
                    {tr(stockRequestToLabel(t))}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">{tr('مطلوب قبل اختياري')}</label>
                <input type="date" className="input" value={neededBy} min={todayLocal()} onChange={e => setNeededBy(e.target.value)} />
              </div>
              <div>
                <label className="label">{tr('ملاحظة اختياري')}</label>
                <input className="input" value={note} onChange={e => setNote(e.target.value)} />
              </div>
            </div>

            {/* البحث وتصفية الناقص */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[180px]">
                <Search size={15} className="absolute top-1/2 -translate-y-1/2 text-[#9A8F7E] pointer-events-none" style={{ insetInlineStart: 10 }} />
                <input className="input" style={{ paddingInlineStart: 32 }} value={search} onChange={e => setSearch(e.target.value)} placeholder={tr('بحث بالاسم أو الكود')} />
              </div>
              <label className="flex items-center gap-2 text-xs text-[#6E6557] cursor-pointer">
                <input type="checkbox" checked={shortOnly} onChange={e => setShortOnly(e.target.checked)} className="accent-[#E15A30]" />
                {tr('الأصناف الناقصة فقط')}
              </label>
            </div>

            <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
                <span className="min-w-0 flex-1">{tr('الصنف')}</span>
                <span className="w-14 sm:w-20 text-center">{tr('الرصيد الحالي')}</span>
                <span className="w-20 sm:w-28 text-center">{tr('الكمية المطلوبة')}</span>
              </div>
              {visible.length === 0 ? (
                <p className="p-6 text-center text-sm text-gray-400">{tr('لا أصناف مطابقة')}</p>
              ) : (
                <div className="divide-y divide-[#F1EBDF] max-h-[42vh] overflow-y-auto">
                  {visible.map(r => {
                    const raw = qty[r.productId] ?? '';
                    const bad = isInvalidRequestQty(raw);
                    return (
                      <div key={r.productId} className="flex items-center gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                          <p className="text-[11px] text-[#9A8F7E]">{[r.code, r.unit].filter(Boolean).join(' · ')}</p>
                        </div>
                        <span dir="ltr" className={`w-14 sm:w-20 shrink-0 text-center text-sm font-bold ${r.onHand < 0 ? 'text-red-600' : r.onHand === 0 ? 'text-amber-600' : 'text-[#6E6557]'}`}>{fmtQty(r.onHand)}</span>
                        <input type="number" step="any" min="0" inputMode="decimal" value={raw}
                          onChange={e => setQty(m => ({ ...m, [r.productId]: e.target.value }))}
                          aria-label={`${tr('الكمية المطلوبة')} ${r.name}`}
                          className={`input w-20 sm:w-28 shrink-0 py-1.5 text-center ${bad ? 'border-red-400 bg-red-50' : ''}`} placeholder="0" />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="p-5 border-t border-[#E9E1D3] space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[#6E6557]">{tr('عدد الأصناف')}: <b className="text-[#1F1A13]">{lines.length}</b></span>
              <span className="text-[#6E6557]">{tr('إجمالي الكميات')}: <b className="text-[#1F1A13]">{fmtQty(totalQty)}</b></span>
            </div>
            {anyInvalid && <p className="text-xs text-red-600">{tr('الكمية يجب أن تكون رقما موجبا')}</p>}
            <div className="flex gap-3">
              <button onClick={issue} disabled={lines.length === 0 || anyInvalid}
                className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
                <FileDown size={16} /> {tr('إصدار PDF')}
              </button>
              <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
            </div>
          </div>
        </div>
      </div>

      {/* الورقة فوق النموذج — طبقةٌ أعلى من z-[60] — و«تم» تعيد إليه بكمياته */}
      {doc && (
        <div className="relative z-[70]">
          <DocumentModal doc={doc} onClose={() => setDoc(null)} />
        </div>
      )}
    </>
  );
}
