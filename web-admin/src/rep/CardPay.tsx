import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CreditCard, Loader2, X, XCircle } from 'lucide-react';
import repApi from './repApi';
import DecimalInput from '../components/DecimalInput';
import { formatCurrency, formatDate } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';

/**
 * «التحصيل بالبطاقة» عبر NearPay (طلب المالك ٢٨ أكتوبر ٢٠٢٦): العميل يلمس بطاقته بجوال المندوب.
 *
 * الصفحة لا تلمس البطاقة: تطلب من الخادم عملية دفع (POST /card-payments/issue) فيعيد رابط intent:// يحمل رمز تسليمٍ لمرة واحدة،
 * فتفتح وحدة الدفع الأصلية داخل تطبيق أندرويد (net.fieldsa.twa). تعود الوحدة إلى /rep?cardpay=<المعرّف> فنسأل الخادم عن النتيجة —
 * والخادم يسأل NearPay لا الجوال، ويُصدر سند القبض بنفسه. تطبيقٌ لم يُحدَّث بعد يعود إلى /rep?cardpay=unsupported.
 */

const PENDING_KEY = 'rep_cardpay_pending';
const PENDING_TTL_MS = 20 * 60_000;

export interface CardPayPending { id: string; invoiceNumber: string; amount: number; at: number }

/** وحدة الدفع الأصلية في تطبيق أندرويد وحده — لا معنى للزرّ على آيفون أو متصفح حاسوب */
export function cardPayDeviceSupported(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

export function readPendingCardPay(): CardPayPending | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null') as CardPayPending | null;
    if (!p || typeof p.id !== 'string' || Date.now() - Number(p.at) > PENDING_TTL_MS) return null;
    return p;
  } catch { return null; }
}
export function clearPendingCardPay(): void {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* تخزينٌ محجوب */ }
}

/** ورقة اختيار الفاتورة والمبلغ ثم فتح وحدة الدفع */
export function CardPaySheet({ customer, onClose }: { customer: { id: string; name: string }; onClose: () => void }) {
  const tr = useTr();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<any | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBackClose(!!picked, () => { setPicked(null); setError(null); });

  useEffect(() => {
    (async () => {
      try {
        const res = await repApi.get('/invoices', { params: { customerId: customer.id, status: 'CONFIRMED', type: 'CREDIT', limit: 50 } });
        setInvoices((res.data.data || []).filter((i: any) => Number(i.remainingAmt) > 0.004));
      } catch { setError(tr('تعذر تحميل الفواتير تحقق من الاتصال')); }
      setLoading(false);
    })();
  }, [customer.id]);

  const start = async () => {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      const remaining = Number(picked.remainingAmt);
      const body: { invoiceId: string; amount?: number } = { invoiceId: picked.id };
      if (amount != null && amount > 0 && Math.abs(amount - remaining) > 0.004) body.amount = amount;
      const res = await repApi.post('/card-payments/issue', body);
      const d = res.data.data as { id: string; amount: number; launchUri: string };
      try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id: d.id, invoiceNumber: picked.number, amount: d.amount, at: Date.now() } satisfies CardPayPending)); } catch { /* تخزينٌ محجوب */ }
      window.location.href = d.launchUri;
    } catch (e: any) {
      setError(e?.response?.data?.message || tr('تعذر بدء التحصيل بالبطاقة تحقق من الاتصال'));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end" onClick={onClose}>
      <div className="bg-white rounded-t-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-gray-100 flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-[#1F1A13]/10 text-[#1F1A13] flex items-center justify-center"><CreditCard size={18} /></span>
          <div className="flex-1">
            <p className="font-bold text-sm">{tr('تحصيل بالبطاقة')}</p>
            <p className="text-[11px] text-gray-400">{customer.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400"><X size={20} /></button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          {error && <p className="bg-red-50 text-red-600 text-xs rounded-xl p-3 mb-3">{error}</p>}
          {picked ? (
            <div>
              <p className="text-sm text-gray-600 mb-1 text-center">{tr('فاتورة')} {picked.number}</p>
              <p className="text-[11px] text-gray-400 text-center mb-3">{tr('المتبقي')} {formatCurrency(picked.remainingAmt)}</p>
              <label className="block text-xs text-gray-500 mb-1">{tr('المبلغ المحصل بالبطاقة')}</label>
              <DecimalInput value={amount ?? Number(picked.remainingAmt)} onCommit={(v: number) => setAmount(v)} min={0}
                className="w-full border border-gray-200 rounded-xl p-3 text-lg font-bold text-center" />
              <button onClick={start} disabled={busy || !(amount == null || amount > 0)}
                className="w-full mt-4 bg-[#1F1A13] disabled:bg-gray-300 text-white rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />} {tr('افتح جهاز الدفع')}
              </button>
              <p className="text-[11px] text-gray-400 mt-3 leading-relaxed text-center">{tr('يلمس العميل بطاقته بظهر الجوال وعند الموافقة يسجل سند القبض تلقائيا باسمك وتسدد الفاتورة')}</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-3 leading-relaxed">{tr('اختر الفاتورة التي يسددها العميل بالبطاقة')}</p>
              {loading ? (
                <p className="text-center text-gray-400 py-8 text-sm">{tr('جاري التحميل')}</p>
              ) : invoices.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">{tr('لا توجد فواتير غير مسددة لهذا العميل')}</p>
              ) : invoices.map(inv => (
                <button key={inv.id} onClick={() => { setPicked(inv); setAmount(Number(inv.remainingAmt)); setError(null); }}
                  className="w-full bg-white border border-gray-200 hover:border-[#1F1A13] rounded-xl p-3.5 mb-2 flex items-center justify-between">
                  <div className="text-right">
                    <p className="text-sm font-bold text-gray-800">{inv.number}</p>
                    <p className="text-[10px] text-gray-400">{formatDate(inv.invoiceDate || inv.createdAt)}</p>
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold text-[#1F1A13]">{formatCurrency(inv.remainingAmt)}</p>
                    <p className="text-[10px] text-gray-400">{tr('المتبقي')}</p>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type CheckState = { status: string; receiptNumber?: string | null; detail?: string | null };

/**
 * نتيجة التحصيل بعد الرجوع من وحدة الدفع — نسأل الخادم كل ٣ ثوانٍ حتى تُحسم أو ٤٥ ثانية؛ وما لم يُحسم يُكمله مجدول الخادم
 * فيُسجَّل السند تلقائياً حين تؤكّد NearPay. «unsupported» = تطبيقٌ قديم بلا وحدة الدفع.
 */
export function CardPayResult({ pending, unsupported, onClose, onDone }: {
  pending: CardPayPending | null; unsupported?: boolean; onClose: () => void; onDone?: () => void;
}) {
  const tr = useTr();
  const [state, setState] = useState<CheckState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    if (unsupported || !pending) return;
    stopped.current = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped.current) return;
      try {
        const r = await repApi.post(`/card-payments/${pending.id}/check`);
        const d = r.data.data as CheckState;
        setState(d);
        setError(null);
        if (d.status !== 'pending') {
          clearPendingCardPay();
          if (d.status === 'approved') onDone?.();
          return;
        }
      } catch (e: any) {
        setError(e?.response?.data?.message || tr('تعذر الاتصال للتحقق من الدفع'));
      }
      if (Date.now() - started < 45_000) setTimeout(tick, 3000);
    };
    void tick();
    return () => { stopped.current = true; };
  }, [pending?.id, unsupported]);

  const st = state?.status;
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-3xl w-full max-w-sm p-6 text-center" onClick={e => e.stopPropagation()}>
        {unsupported ? (
          <>
            <XCircle size={44} className="mx-auto text-amber-500" />
            <p className="font-bold mt-3">{tr('حدث تطبيق المندوب')}</p>
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">{tr('التحصيل بالبطاقة يحتاج أحدث نسخة من تطبيق المندوب من متجر Google Play')}</p>
          </>
        ) : st === 'approved' ? (
          <>
            <CheckCircle2 size={48} className="mx-auto text-green-600" />
            <p className="font-bold mt-3">{tr('تم التحصيل بالبطاقة')}</p>
            {pending && <p className="text-2xl font-bold mt-2">{formatCurrency(pending.amount)}</p>}
            {state?.receiptNumber && <p className="text-sm text-gray-500 mt-1">{tr('سند القبض')} {state.receiptNumber}</p>}
          </>
        ) : st && st !== 'pending' ? (
          <>
            <XCircle size={48} className="mx-auto text-red-500" />
            <p className="font-bold mt-3">{tr('لم يتم التحصيل')}</p>
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">{state?.detail || tr('رفضت العملية أو ألغيت ولم يسجل سند')}</p>
          </>
        ) : (
          <>
            <Loader2 size={44} className="mx-auto text-[#1F1A13] animate-spin" />
            <p className="font-bold mt-3">{tr('جار التحقق من الدفع')}</p>
            {pending && <p className="text-sm text-gray-500 mt-1">{tr('فاتورة')} {pending.invoiceNumber} — {formatCurrency(pending.amount)}</p>}
            <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">{tr('إن أغلقت هذه النافذة يكمل الخادم التحقق ويسجل السند تلقائيا عند تأكيد الدفع')}</p>
            {error && <p className="text-[11px] text-amber-700 mt-2">{error}</p>}
          </>
        )}
        <button onClick={onClose} className="w-full mt-5 bg-[#1F1A13] text-white rounded-xl py-3 font-semibold text-sm">{tr('إغلاق')}</button>
      </div>
    </div>
  );
}
