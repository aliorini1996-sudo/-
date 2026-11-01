import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eraser, Info, Layers, Smartphone, Truck, Warehouse, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { stockZeroApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatCurrency, formatDate } from '../utils/format';
import { backdropClose } from '../lib/backdropClose';
import { newUuid } from '../lib/uuid';

/*
 * «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦): زرٌّ واحد يصفّر رصيد المستودع المركزي وكل سيارات المناديب الحيّة (والموقوفين)
 * بحركات تسوية موسومةٍ بالتصفير — فالتاريخ باقٍ و«المخزون في تاريخ» يقرأ الأرقام القديمة — ثم تُدخل الشركة استلاماتها من جديد.
 * النافذة تعرض المعاينة أولاً (ما سيُصفَّر وقيمته بتكلفة الشراء، وما لا يُمسّ، وما يمنع)، والتنفيذ بكلمة «تصفير» مكتوبةً.
 * والخادم هو الحَكَم في الصلاحية والأرقام: يعيد الحساب داخل المعاملة نفسها، فالمعاينة عرضٌ لا عقد.
 */

/** كلمة التأكيد كما يقارنها الخادم بعد trim — كتابتها شرطٌ لتفعيل الزرّ */
export const STOCK_ZERO_CONFIRM_WORD = 'تصفير';

/**
 * كل مفتاح استعلامٍ تقرؤه صفحتا «مخزون الشركة» و«مخزون السيارات» (ونوافذهما وصفحة اللوط) لأرصدةٍ أو حركاتٍ أو تشغيلات —
 * بعد التصفير تتغيّر كلّها معاً، وبقاء واحدٍ منها في الكاش يعرض رصيداً لم يعد موجوداً.
 * ولا 'stock-zero-preview' فيها: النافذة تُغلق بعدها مباشرةً ومعاينتها gcTime: 0 تُعاد طازجةً عند كل فتح — إبطالها هنا
 * يطلق إعادة حسابٍ ثقيلة (كل الأصناف والسيارات) قبل أن يُزال المكوّن بلحظة ثم تُرمى نتيجتها
 */
export const STOCK_ZERO_INVALIDATE_KEYS = [
  'warehouse-stock', 'warehouse-vans', 'warehouse-entries',
  'van-summary', 'van-current', 'van-movements', 'van-loads-log', 'van-suggest', 'locations-summary',
  'van-lot-balances', 'lot-balances-wh', 'lot-balances-van', 'lot-balances-load', 'lot-fefo', 'lots-of-product', 'lots',
] as const;

/** GET /stock-zero/preview — الكميات بوحدة الأساس، والقيم بتكلفة الشراء كصفحة المستودع وبطاقة «في مخزون السيارات» */
export interface StockZeroPreview {
  warehouse: { enabled: boolean; products: number; positiveQty: number; negativeQty: number; value: number; uncostedQty: number };
  vans: { reps: number; products: number; sellableQty: number; negativeQty: number; unsellableQty: number; value: number; deletedVans: number };
  lotBlocked: { productId: string; name: string }[];
  pendingDevices: { repId: string; name: string; outboxPending: number }[];
  lastRun: { id: string; createdAt: string; actorName: string } | null;
  alreadyZero: boolean;
  currencyDecimals: number;
}

/** POST /stock-zero — نتيجة التصفير (وإعادته بالـzeroRef نفسه تعيدها كما هي مع idempotent) */
export interface StockZeroResult {
  runId: string | null;
  alreadyZero: boolean;
  warehouse: { products: number; entryId: string | null };
  vans: { reps: number; loads: number; products: number };
  skipped: { deletedVans: number; negativeUnsellable: number };
  value: { warehouse: number; vans: number };
}

const fmtQty = (n: number) => Number((n ?? 0).toFixed(2)).toLocaleString('en-US');

/** رسالة الخادم (عربيةً) مترجمةً — وإلا البديل */
const serverMessage = (e: unknown): string | undefined => (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
const serverCode = (e: unknown): string | undefined => (e as { response?: { data?: { code?: string } } })?.response?.data?.code;

export default function StockZeroModal({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  // مرجع التصفير يُولَّد مرةً واحدة لكل فتحٍ للنافذة (المكوّن يُركَّب عند الفتح) ويُعاد مع كل محاولة: إن انقطع الردّ بعد أن
  // كتب الخادم فإعادة الضغط تعود بنتيجة التصفير نفسه لا بتصفيرٍ ثانٍ يمسح ما أُدخل بينهما
  // والمولّد محروس (lib/uuid): crypto.randomUUID غائبٌ في المتصفّحات الأقدم والسياق غير الآمن، واستدعاؤه هنا بلا حارسٍ يُسقط النافذة
  const [zeroRef] = useState(() => newUuid());
  const [typed, setTyped] = useState('');
  const confirmed = typed.trim() === STOCK_ZERO_CONFIRM_WORD;

  // المعاينة طازجةً عند كل فتح — رصيدٌ قديمٌ في الكاش يُري المدير أرقاماً غير التي ستُصفَّر
  const previewQ = useQuery({
    queryKey: ['stock-zero-preview'],
    queryFn: async () => (await stockZeroApi.preview()).data.data as StockZeroPreview,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const p = previewQ.data;
  const lotBlocked = p?.lotBlocked ?? [];
  const pending = p?.pendingDevices ?? [];
  const dec = p?.currencyDecimals;
  const money = (n: number) => formatCurrency(n ?? 0, undefined, dec);

  const run = useMutation({
    mutationFn: async () => (await stockZeroApi.run(typed.trim(), zeroRef)).data.data as StockZeroResult,
    onSuccess: (r) => {
      STOCK_ZERO_INVALIDATE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      if (r.alreadyZero) {
        toast.success(tr('المخزون صفر أصلا لم يكتب شيء'));
      } else {
        toast.success(`${tr('تم تصفير المخزون')}: ${r.warehouse.products} ${tr('صنف في المستودع')} · ${r.vans.reps} ${tr('سيارة')} · ${r.vans.products} ${tr('صنف في السيارات')}`, { duration: 6000 });
      }
      onClose();
    },
    onError: (e: unknown) => {
      const msg = serverMessage(e);
      toast.error(msg ? tr(msg) : tr('تعذر تصفير المخزون'));
      // أصنافٌ متتبَّعة صار لها رصيد منذ المعاينة: تُعاد المعاينة فتظهر قائمتها ويُعطَّل الزرّ
      if (serverCode(e) === 'STOCK_ZERO_LOT_TRACKED') void previewQ.refetch();
    },
  });

  const blocked = lotBlocked.length > 0;
  const canRun = !!p && !p.alreadyZero && !blocked && confirmed && !run.isPending && !previewQ.isFetching;
  const previewError = previewQ.isError ? serverMessage(previewQ.error) : undefined;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(() => { if (!run.isPending) onClose(); })}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Eraser size={20} className="text-[#C0392B]" /> {tr('تصفير المخزون')}</h2>
          <button type="button" onClick={onClose} disabled={run.isPending} aria-label={tr('إغلاق')} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 disabled:opacity-40"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-sm text-[#6E6557]">{tr('يصفر رصيد المستودع وكل سيارات المناديب بحركات تسوية ثم تدخل الشركة استلاماتها من جديد')}</p>

          {previewQ.isLoading ? (
            <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
          ) : previewQ.isError || !p ? (
            <p className="text-center text-red-600 text-sm py-6">{previewError ? tr(previewError) : tr('تعذر تحميل معاينة التصفير')}</p>
          ) : (
            <>
              {p.alreadyZero && (
                <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-[#1E7A52] flex items-center gap-2">
                  <Info size={16} className="shrink-0" /> {tr('المخزون صفر الآن لا شيء للتصفير')}
                </div>
              )}

              {/* المستودع المركزي — لشركةٍ فعّلت المستودع وحدها */}
              {p.warehouse.enabled && (
                <section className="rounded-xl border border-[#E9E1D3] p-3.5 space-y-1.5">
                  <p className="text-sm font-bold text-[#1F1A13] flex items-center gap-2"><Warehouse size={16} className="text-[#E15A30]" /> {tr('المستودع المركزي')}</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-[#9A8F7E]">{tr('أصناف لها رصيد')}</dt><dd className="font-bold text-[#1F1A13]">{p.warehouse.products}</dd>
                    <dt className="text-[#9A8F7E]">{tr('كمية موجبة تخرج')}</dt><dd className="font-bold text-[#1F1A13]">{fmtQty(p.warehouse.positiveQty)}</dd>
                    <dt className="text-[#9A8F7E]">{tr('كمية سالبة تجبر إلى صفر')}</dt><dd className={`font-bold ${p.warehouse.negativeQty > 0 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{fmtQty(p.warehouse.negativeQty)}</dd>
                    <dt className="text-[#9A8F7E]">{tr('القيمة بتكلفة الشراء')}</dt><dd className="font-bold text-[#1F1A13]">{money(p.warehouse.value)}</dd>
                  </dl>
                  {p.warehouse.uncostedQty > 0 && (
                    <p className="text-[11px] text-amber-700">{fmtQty(p.warehouse.uncostedQty)} {tr('بلا تكلفة معروفة خارج القيمة')}</p>
                  )}
                </section>
              )}

              {/* سيارات المناديب الحيّة — والموقوفون معهم */}
              <section className="rounded-xl border border-[#E9E1D3] p-3.5 space-y-1.5">
                <p className="text-sm font-bold text-[#1F1A13] flex items-center gap-2"><Truck size={16} className="text-[#E15A30]" /> {tr('سيارات المناديب')}</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-[#9A8F7E]">{tr('سيارات فيها رصيد')}</dt><dd className="font-bold text-[#1F1A13]">{p.vans.reps}</dd>
                  <dt className="text-[#9A8F7E]">{tr('أصناف لها رصيد')}</dt><dd className="font-bold text-[#1F1A13]">{p.vans.products}</dd>
                  <dt className="text-[#9A8F7E]">{tr('كمية متاحة للبيع')}</dt><dd className="font-bold text-[#1F1A13]">{fmtQty(p.vans.sellableQty)}</dd>
                  <dt className="text-[#9A8F7E]">{tr('كمية سالبة تجبر إلى صفر')}</dt><dd className={`font-bold ${p.vans.negativeQty > 0 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{fmtQty(p.vans.negativeQty)}</dd>
                  <dt className="text-[#9A8F7E]">{tr('تالف أو منتهي لا يباع')}</dt><dd className="font-bold text-[#1F1A13]">{fmtQty(p.vans.unsellableQty)}</dd>
                  <dt className="text-[#9A8F7E]">{tr('القيمة بتكلفة الشراء')}</dt><dd className="font-bold text-[#1F1A13]">{money(p.vans.value)}</dd>
                </dl>
                {p.vans.deletedVans > 0 && (
                  <p className="text-[11px] text-amber-700">{p.vans.deletedVans} — {tr('سيارات مناديب محذوفين لا تُمسّ')}</p>
                )}
              </section>

              <p className="text-[11px] text-[#9A8F7E]">{tr('الكميات بوحدة الأساس لكل صنف')}</p>

              {/* أجهزةٌ لم ترفع مستنداتها: فواتيرها المتأخرة تُخصم بعد التصفير فتظهر رصيداً سالباً — تحذيرٌ لا منع */}
              {pending.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-800 flex items-start gap-1.5">
                    <Smartphone size={14} className="shrink-0 mt-0.5" />
                    {tr('أجهزة مناديب لم ترفع مستنداتها — اطلب منهم المزامنة قبل التصفير، وإلا ظهرت فواتيرهم المتأخرة رصيداً سالباً')}
                  </p>
                  <ul className="text-[11px] text-amber-800 space-y-0.5 ps-5 list-disc">
                    {pending.map(d => <li key={d.repId}>{d.name} — {d.outboxPending} {tr('مستند بانتظار الرفع')}</li>)}
                  </ul>
                </div>
              )}

              {/* أصنافٌ بتتبّع اللوط لها رصيد: الخادم يرفض التصفير كلّه حتى يُزال رصيدها — وصفحة اللوط عرضٌ لا تسوية فيها، فالطريق
                  الحقيقي: رصيد المستودع بتسوية نقصٍ بالتشغيلة من «مخزون الشركة»، ورصيد السيارات من «مخزون السيارات» */}
              {blocked && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 space-y-1.5">
                  <p className="text-xs font-semibold text-red-700 flex items-start gap-1.5">
                    <Layers size={14} className="shrink-0 mt-0.5" />
                    {tr('أصناف بتتبع اللوط لها رصيد صفر رصيد المستودع بتسوية نقص بالتشغيلة من مخزون الشركة وأزل رصيد السيارات من مخزون السيارات أولا')}
                  </p>
                  <ul className="text-[11px] text-red-700 space-y-0.5 ps-5 list-disc">
                    {lotBlocked.map(b => <li key={b.productId}>{b.name}</li>)}
                  </ul>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <Link to="/app/warehouse" onClick={onClose} className="inline-block text-[11px] font-semibold text-[#E15A30]">{tr('مخزون الشركة')}</Link>
                    <Link to="/app/van-stock" onClick={onClose} className="inline-block text-[11px] font-semibold text-[#E15A30]">{tr('مخزون السيارات')}</Link>
                  </div>
                </div>
              )}

              {p.lastRun && (
                <p className="text-[11px] text-[#9A8F7E]">{tr('آخر تصفير')}: {formatDate(p.lastRun.createdAt)} — {p.lastRun.actorName}</p>
              )}

              {/* التحذير قبل الكتابة: لا تراجع إلا باستلامات جديدة، والتاريخ باقٍ، والعهدة لا تُمسّ */}
              <div role="alert" className="rounded-xl border border-red-300 bg-[#FBE3DF] px-4 py-3 text-xs text-[#9B2C1F] space-y-1">
                <p className="font-bold flex items-center gap-1.5"><AlertTriangle size={14} /> {tr('لا يمكن التراجع عن التصفير إلا بإدخال استلامات جديدة')}</p>
                <p>{tr('السجل والمخزون في تاريخ يبقيان بالأرقام القديمة')}</p>
                <p>{tr('عهدة أدوات السيارات لا تتأثر بالتصفير')}</p>
              </div>

              {!p.alreadyZero && !blocked && (
                <div>
                  <label htmlFor="stock-zero-confirm" className="label">{tr('اكتب كلمة التأكيد: تصفير')}</label>
                  <input id="stock-zero-confirm" className="input" value={typed} onChange={e => setTyped(e.target.value)}
                    autoComplete="off" autoCorrect="off" spellCheck={false} placeholder={STOCK_ZERO_CONFIRM_WORD} disabled={run.isPending} />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button type="button" onClick={() => run.mutate()} disabled={!canRun}
            className="btn-danger flex-1 justify-center py-2.5 disabled:opacity-50">
            {run.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Eraser size={16} />}
            {tr('تصفير المخزون')}
          </button>
          <button type="button" onClick={onClose} disabled={run.isPending} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
