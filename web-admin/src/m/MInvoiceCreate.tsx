import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Minus, Trash2, ShoppingCart, Loader2, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { customerApi, productApi, salesRepApi, invoiceApi } from '../api/client';
import { formatCurrency } from '../utils/format';
import { useTr } from '../i18n/strings';
import { MHeader, MSpinner } from './mobileUi';
import { expectArray } from './shape';
import { lineTotal, invoiceTotals, type Line } from './docMath';

interface Pick { id: string; name: string; code?: string; phone?: string; basePrice?: number; taxPct?: number; unit?: string }

/**
 * إنشاء فاتورة من الجوال — على نمط شاشة المندوب بصرياً، **وبدلالة الأدمن حسابياً**.
 *
 * فرقان جوهريان عن شاشة المندوب:
 *  1. **اختيار المندوب إلزاميّ** — لا مقابل له عند المندوب (هو نفسه).
 *  2. **السعر قبل الضريبة** (`product.basePrice`) — راجع `docMath.ts`.
 *
 * وثلاث خطوات لا شاشة واحدة: العميل ← الأصناف ← المراجعة. نموذجٌ واحد طويل
 * على الجوال يعني تمريراً لا ينتهي وأخطاءً لا تُرى.
 */
type Step = 'head' | 'items' | 'review';

export default function MInvoiceCreate({ presetCustomerId, onClose, onCreated }: {
  presetCustomerId?: string;
  onClose: () => void;
  onCreated: (invoiceId: string) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('head');
  const [customerId, setCustomerId] = useState(presetCustomerId || '');
  const [salesRepId, setSalesRepId] = useState('');
  const [type, setType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [discountPct, setDiscountPct] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [pq, setPq] = useState('');
  const [cq, setCq] = useState('');

  const customersQ = useQuery({
    queryKey: ['m-inv-customers', cq],
    queryFn: async () => expectArray<Pick>((await customerApi.list({ search: cq, limit: 40 })).data?.data, tr('العملاء')),
    enabled: step === 'head',
  });
  const repsQ = useQuery({
    queryKey: ['m-inv-reps'],
    queryFn: async () => expectArray<Pick>((await salesRepApi.list({ limit: 200 })).data?.data, tr('المناديب')),
    enabled: step === 'head',
  });
  const productsQ = useQuery({
    queryKey: ['m-inv-products', pq],
    queryFn: async () => expectArray<Pick>((await productApi.list({ search: pq, limit: 60 })).data?.data, tr('الأصناف')),
    enabled: step === 'items',
  });

  const totals = useMemo(() => invoiceTotals(lines, discountPct), [lines, discountPct]);
  const customer = customersQ.data?.find(c => c.id === customerId);

  const addProduct = (p: Pick) => {
    setLines(ls => {
      const i = ls.findIndex(l => l.productId === p.id);
      if (i >= 0) {
        const n = [...ls];
        n[i] = { ...n[i], qty: n[i].qty + 1 };
        return n;
      }
      return [...ls, {
        productId: p.id, name: p.name, unit: p.unit || '',
        qty: 1,
        // ⚠️ basePrice سعرٌ **قبل** الضريبة — هذا ما يتوقّعه مسار الأدمن
        unitPrice: Number(p.basePrice ?? 0),
        discountPct: 0,
        taxPct: Number(p.taxPct ?? 15),
      }];
    });
  };
  const setQty = (id: string, d: number) =>
    setLines(ls => ls.map(l => l.productId === id ? { ...l, qty: Math.max(0, l.qty + d) } : l).filter(l => l.qty > 0));
  const patch = (id: string, k: 'unitPrice' | 'discountPct', v: number) =>
    setLines(ls => ls.map(l => l.productId === id ? { ...l, [k]: v } : l));

  const save = useMutation({
    mutationFn: async () => {
      const res = await invoiceApi.create({
        customerId, salesRepId, type, discountPct,
        ...(notes.trim() && { notes: notes.trim() }),
        ...(invoiceDate && { invoiceDate }),
        items: lines.map(l => ({
          productId: l.productId, qty: l.qty,
          unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct,
        })),
      });
      return res.data.data as { id: string };
    },
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ['m-docs', 'invoice'] });
      qc.invalidateQueries({ queryKey: ['m-dashboard'] });
      toast.success(tr('تم إصدار الفاتورة'));
      onCreated(inv.id);
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر الإصدار')),
  });

  const headReady = !!customerId && !!salesRepId;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={tr('فاتورة جديدة')}
        subtitle={step === 'head' ? tr('العميل والمندوب') : step === 'items' ? tr('الأصناف') : tr('المراجعة')}
        onBack={() => step === 'head' ? onClose() : setStep(step === 'review' ? 'items' : 'head')} />

      {/* خطوات مرئية — يعرف المستخدم أين هو وكم بقي */}
      <div className="flex-shrink-0 flex gap-1 px-3 py-2 bg-white border-b border-[#F1EBDF]">
        {(['head', 'items', 'review'] as Step[]).map((s, i) => (
          <span key={s} className={`flex-1 h-1 rounded-full ${['head', 'items', 'review'].indexOf(step) >= i ? 'bg-[#E15A30]' : 'bg-[#E9E1D3]'}`} />
        ))}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {step === 'head' && (
          <>
            <Field label={tr('نوع الفاتورة')}>
              <div className="flex gap-2">
                {(['CREDIT', 'CASH'] as const).map(t => (
                  <button key={t} onClick={() => setType(t)}
                    className={`flex-1 py-3 rounded-xl font-semibold text-sm min-h-[48px] border ${type === t ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`}>
                    {t === 'CREDIT' ? tr('آجل') : tr('نقدي')}
                  </button>
                ))}
              </div>
            </Field>

            <Field label={tr('المندوب')} required>
              {repsQ.isLoading ? <MSpinner /> : (
                <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
                  <option value="">{tr('اختر المندوب')}</option>
                  {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
            </Field>

            <Field label={tr('العميل')} required>
              <div className="relative mb-2">
                <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
                <input value={cq} onChange={e => setCq(e.target.value)} className="input ps-9" placeholder={tr('ابحث عن عميل…')} />
              </div>
              <div className="rounded-xl border border-[#F1EBDF] bg-white max-h-56 overflow-y-auto divide-y divide-[#F1EBDF]">
                {customersQ.isLoading ? <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('جاري التحميل...')}</p>
                  : !customersQ.data?.length ? <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('لا نتائج')}</p>
                  : customersQ.data.map(c => (
                    <button key={c.id} onClick={() => setCustomerId(c.id)}
                      className={`w-full text-start px-3 py-3 min-h-[52px] flex items-center gap-2 ${customerId === c.id ? 'bg-[#FBEBE2]' : 'active:bg-[#FAF7F0]'}`}>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#1F1A13] truncate">{c.name}</span>
                        <span className="block text-[11px] text-[#9A8F7E] truncate">{[c.code, c.phone].filter(Boolean).join(' · ')}</span>
                      </span>
                      {customerId === c.id && <Check size={16} className="text-[#E15A30] flex-shrink-0" />}
                    </button>
                  ))}
              </div>
            </Field>

            <Field label={tr('تاريخ الفاتورة')}>
              <input type="date" className="input" dir="ltr" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
              <p className="text-[10px] text-[#9A8F7E] mt-1">{tr('اتركه فارغاً لتاريخ اليوم')}</p>
            </Field>
          </>
        )}

        {step === 'items' && (
          <>
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
              <input value={pq} onChange={e => setPq(e.target.value)} className="input ps-9" placeholder={tr('ابحث عن صنف…')} />
            </div>

            {lines.length > 0 && (
              <div className="rounded-2xl border border-[#F1EBDF] bg-white divide-y divide-[#F1EBDF]">
                {lines.map(l => (
                  <div key={l.productId} className="p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#1F1A13] truncate">{l.name}</span>
                        <span className="block text-[11px] text-[#9A8F7E]">{formatCurrency(lineTotal(l))}</span>
                      </span>
                      <button onClick={() => setLines(ls => ls.filter(x => x.productId !== l.productId))}
                        className="p-2 text-[#C0392B]" aria-label={tr('حذف')}><Trash2 size={15} /></button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setQty(l.productId, -1)} className="w-10 h-10 rounded-xl border border-[#E9E1D3] flex items-center justify-center"><Minus size={15} /></button>
                      <span className="w-10 text-center font-bold">{l.qty}</span>
                      <button onClick={() => setQty(l.productId, 1)} className="w-10 h-10 rounded-xl border border-[#E9E1D3] flex items-center justify-center"><Plus size={15} /></button>
                      <span className="flex-1" />
                      <label className="text-[10px] text-[#9A8F7E]">{tr('السعر')}</label>
                      <input type="number" step="any" inputMode="decimal" dir="ltr" className="input w-20 text-center py-1.5" value={l.unitPrice}
                        onChange={e => patch(l.productId, 'unitPrice', Number(e.target.value) || 0)} />
                      <label className="text-[10px] text-[#9A8F7E]">{tr('خصم%')}</label>
                      <input type="number" step="any" inputMode="decimal" dir="ltr" className="input w-14 text-center py-1.5" value={l.discountPct}
                        onChange={e => patch(l.productId, 'discountPct', Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
                    </div>
                  </div>
                ))}
                <p className="px-3 py-2 text-[10px] text-[#9A8F7E]">{tr('السعر قبل الضريبة — تُحسب الضريبة تلقائياً')}</p>
              </div>
            )}

            <div className="rounded-2xl border border-[#F1EBDF] bg-white divide-y divide-[#F1EBDF]">
              {productsQ.isLoading ? <MSpinner />
                : !productsQ.data?.length ? <p className="text-center text-xs text-[#9A8F7E] py-6">{tr('لا نتائج')}</p>
                : productsQ.data.map(p => (
                  <button key={p.id} onClick={() => addProduct(p)}
                    className="w-full text-start px-3 py-3 min-h-[52px] flex items-center gap-2 active:bg-[#FAF7F0]">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#1F1A13] truncate">{p.name}</span>
                      <span className="block text-[11px] text-[#9A8F7E]">
                        {formatCurrency(Number(p.basePrice ?? 0))} · {tr('ضريبة')} {Number(p.taxPct ?? 15)}%
                      </span>
                    </span>
                    <Plus size={17} className="text-[#E15A30] flex-shrink-0" />
                  </button>
                ))}
            </div>
          </>
        )}

        {step === 'review' && (
          <>
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-4 space-y-1.5 text-sm">
              <Row k={tr('العميل')} v={customer?.name || '—'} />
              <Row k={tr('المندوب')} v={repsQ.data?.find(r => r.id === salesRepId)?.name || '—'} />
              <Row k={tr('النوع')} v={type === 'CASH' ? tr('نقدي') : tr('آجل')} />
              <Row k={tr('الأصناف')} v={String(lines.length)} />
            </div>

            <Field label={tr('خصم على الفاتورة %')}>
              <input type="number" step="any" inputMode="decimal" dir="ltr" className="input" value={discountPct}
                onChange={e => setDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
            </Field>
            <Field label={tr('ملاحظات')}>
              <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
            </Field>

            <div className="rounded-2xl border border-[#E9E1D3] bg-white p-4 space-y-2">
              <Row k={tr('الإجمالي قبل الضريبة')} v={formatCurrency(totals.subtotal)} />
              <Row k={tr('الخصم')} v={`− ${formatCurrency(totals.discount)}`} />
              <Row k={tr('الضريبة')} v={formatCurrency(totals.tax)} />
              <div className="border-t border-[#E9E1D3] pt-2 flex justify-between items-center">
                <span className="font-bold text-[#1F1A13]">{tr('الإجمالي')}</span>
                <span className="text-xl font-bold text-[#E15A30]">{formatCurrency(totals.total)}</span>
              </div>
            </div>
          </>
        )}
        <div className="h-2" />
      </div>

      {/* شريط الإجراء الثابت */}
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {step === 'head' && (
          <button onClick={() => setStep('items')} disabled={!headReady}
            className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] disabled:bg-[#E89B7E]">
            {tr('التالي: الأصناف')}
          </button>
        )}
        {step === 'items' && (
          <button onClick={() => setStep('review')} disabled={lines.length === 0}
            className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
            <ShoppingCart size={17} />
            {tr('مراجعة')} · {formatCurrency(totals.total)}
          </button>
        )}
        {step === 'review' && (
          <button onClick={() => save.mutate()} disabled={save.isPending || lines.length === 0}
            className="w-full bg-[#2F855A] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:opacity-60">
            {save.isPending && <Loader2 size={16} className="animate-spin" />}
            {tr('إصدار الفاتورة')}
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}{required && ' *'}</label>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[#6E6557] text-sm">{k}</span>
      <span className="text-[#1F1A13] text-sm font-semibold truncate">{v}</span>
    </div>
  );
}
