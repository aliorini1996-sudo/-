import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import repApi from './repApi';
import DecimalInput from '../components/DecimalInput';
import { formatCurrency, formatDate } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { currentRepId } from './offlineDb';

/**
 * «التحصيل بالبطاقة» عبر NearPay (طلب المالك ٢٨ أكتوبر ٢٠٢٦): العميل يلمس بطاقته بجوال المندوب.
 *
 * الصفحة لا تلمس البطاقة: تطلب من الخادم عملية دفع (POST /card-payments/issue) فيعيد رابط intent:// يحمل رمز تسليمٍ لمرة واحدة،
 * فتفتح وحدة الدفع الأصلية داخل تطبيق أندرويد (net.fieldsa.twa). تعود الوحدة إلى /rep?cardpay=<المعرّف> فنسأل الخادم عن النتيجة —
 * والخادم يسأل NearPay لا الجوال، ويُصدر سند القبض بنفسه. تطبيقٌ لم يُحدَّث بعد يعود إلى /rep?cardpay=unsupported.
 */

const PENDING_KEY = 'rep_cardpay_pending';
const PENDING_TTL_MS = 20 * 60_000;

// repId: صاحب العملية — جهازٌ مشترك لا يعرض لمندوبٍ عمليةَ من خرج قبله (الإخراج القسري لا يمسحها)
export interface CardPayPending { id: string; invoiceNumber: string; amount: number; at: number; repId?: string }

// معرّف العملية (= intentUUID لدى NearPay) UUID دائماً. يصير جزءاً من مسار طلبٍ بجلسة المندوب، و?cardpay= يأتي من أي رابط
// إلى fieldsa.net/rep يفتح التطبيق — فلا يُقبل غيره («..» أو «?» كانا يحوّلان الطلب إلى مسارٍ آخر)
const CARD_PAY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isCardPayId(v: unknown): v is string {
  return typeof v === 'string' && CARD_PAY_ID_RE.test(v);
}

// Chrome لا يفتح تطبيقاً من رابط intent:// إلا بإيماءة مستخدم، والإيماءة تنقضي بعد ثوانٍ قليلة من النقر (نحو ٥ في Chromium).
// الرابط يصل بعد طلبٍ شبكي: إن تأخر أكثر من هذا يُفتح من نقرةٍ جديدة لا تلقائياً
const LAUNCH_GESTURE_MS = 3000;

/** عمليةٌ أُصدرت ولم يُفتح رابطها بعد — المعلّقة تُحفظ لحظة الفتح، والرمز لا يُفتح بعد انتهائه */
interface PreparedLaunch { uri: string; expiresAt: number; pending: CardPayPending }

/** وحدة الدفع الأصلية في تطبيق أندرويد وحده — لا معنى للزرّ على آيفون أو متصفح حاسوب */
export function cardPayDeviceSupported(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

export function readPendingCardPay(): CardPayPending | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null') as CardPayPending | null;
    if (!p || !isCardPayId(p.id) || Date.now() - Number(p.at) > PENDING_TTL_MS) return null;
    return p;
  } catch { return null; }
}
/** بمعرّف: تُمسح المحفوظة إن كانت هي نفسها فقط — عرضُ عمليةٍ أخرى لا يُسقط المعلّقة */
export function clearPendingCardPay(id?: string): void {
  try {
    if (id && readPendingCardPay()?.id !== id) return;
    localStorage.removeItem(PENDING_KEY);
  } catch { /* تخزينٌ محجوب */ }
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
  // عمليةٌ جارية أو موقوفة على الفاتورة (409 من الخادم بمعرّفها) — تُعرض نتيجتها بدل رسالةٍ بلا مخرج
  const [blocking, setBlocking] = useState<CardPayPending | null>(null);
  const [viewing, setViewing] = useState<CardPayPending | null>(null);
  // رابط وحدة الدفع لعمليةٍ أُنشئت بعد أن انقضت إيماءة النقر — يُفتح من النقرة التالية على الزرّ نفسه (لا عملية ثانية)
  const [launch, setLaunch] = useState<PreparedLaunch | null>(null);
  const alive = useRef(true);
  // يزيد مع كل تغييرٍ للفاتورة أو المبلغ: ردُّ إصدارٍ وصل بعد التغيير يُهمل فلا يُفتح الجهاز بفاتورةٍ أو مبلغٍ لم يعودا على الشاشة
  const reqSeq = useRef(0);
  const resetLaunch = () => { reqSeq.current++; setLaunch(null); };
  useEffect(() => () => { alive.current = false; }, []);
  useBackClose(!!picked, () => { setPicked(null); setError(null); resetLaunch(); });

  useEffect(() => {
    (async () => {
      try {
        // فواتير العميل المفتوحة كلها (لا أحدث ٥٠ لهذا المندوب)، بلا المحجوبة لدى الهيئة — كنموذج سند القبض
        const res = await repApi.get('/invoices/open', { params: { customerId: customer.id } });
        setInvoices(res.data.data || []);
      } catch { setError(tr('تعذر تحميل الفواتير تحقق من الاتصال')); }
      setLoading(false);
    })();
  }, [customer.id]);

  // المعلّقة تُحفظ لحظة فتح الرابط لا لحظة الإصدار: عمليةٌ لم تُفتح وحدتها لا تُعرض «جارٍ التحقق» عند الرجوع
  const openLaunch = (l: PreparedLaunch) => {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ...l.pending, at: Date.now() } satisfies CardPayPending)); } catch { /* تخزينٌ محجوب */ }
    window.location.href = l.uri;
    // الرجوع بزرّ الرجوع لا يُبقي الزرّ معطّلاً
    setBusy(true);
    setTimeout(() => { if (alive.current) setBusy(false); }, 3000);
  };

  const start = async () => {
    if (!picked) return;
    // عمليةٌ أُنشئت ولم يُفتح رابطها (تأخر الخادم): هذه النقرة إيماءةٌ جديدة تفتحه — لا إصدار ثانٍ. ورمزٌ قارب الانتهاء
    // لا يُفتح (ترفضه الوحدة) — يُصدر غيره، والقديم لم يُستبدل فلا يحجز الفاتورة
    if (launch) {
      setLaunch(null);
      if (Date.now() < launch.expiresAt - 30_000) { openLaunch(launch); return; }
    }
    const clickedAt = Date.now();
    const seq = ++reqSeq.current;
    setBusy(true); setError(null); setBlocking(null);
    try {
      const remaining = Number(picked.remainingAmt);
      const body: { invoiceId: string; amount?: number } = { invoiceId: picked.id };
      if (amount != null && amount > 0 && Math.abs(amount - remaining) > 0.004) body.amount = amount;
      const res = await repApi.post('/card-payments/issue', body);
      // أُغلقت الورقة قبل الرد: لا تُفتح وحدة الدفع بمبلغ عميلٍ سابق أمام عميلٍ آخر
      if (!alive.current) return;
      // وتغيّرت الفاتورة أو المبلغ أثناء الطلب: الرد لما لم يعد على الشاشة — يُهمل (رمزه لم يُستبدل فلا يحجز شيئاً)
      if (seq !== reqSeq.current) { setBusy(false); return; }
      const d = res.data.data as { id: string; amount: number; launchUri: string; launchExpiresAt: string };
      const prepared: PreparedLaunch = {
        uri: d.launchUri,
        expiresAt: Date.parse(d.launchExpiresAt) || clickedAt + 10 * 60_000,
        pending: { id: d.id, invoiceNumber: picked.number, amount: d.amount, at: 0, repId: currentRepId() },
      };
      if (Date.now() - clickedAt <= LAUNCH_GESTURE_MS) { openLaunch(prepared); return; }
      // انقضت إيماءة النقر فيحجب Chrome الرابط صامتاً: النقرة التالية على الزرّ تفتحه (الرمز صالح عشر دقائق)
      setLaunch(prepared);
      setBusy(false);
    } catch (e: any) {
      if (!alive.current) return;
      if (seq !== reqSeq.current) { setBusy(false); return; }
      const data = e?.response?.data;
      setError(data?.message || tr('تعذر بدء التحصيل بالبطاقة تحقق من الاتصال'));
      if (data?.paymentId && (data.code === 'CARD_PAY_IN_PROGRESS' || data.code === 'CARD_PAY_REVIEW')) {
        setBlocking({ id: data.paymentId, invoiceNumber: picked.number, amount: 0, at: Date.now() });
      }
      setBusy(false);
    }
  };

  return (
    <>
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
          {blocking && (
            <button onClick={() => setViewing(blocking)}
              className="w-full mb-3 border border-[#1F1A13] text-[#1F1A13] rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2">
              <RefreshCw size={15} /> {tr('اعرض حالة العملية السابقة')}
            </button>
          )}
          {picked ? (
            <div>
              <p className="text-sm text-gray-600 mb-1 text-center">{tr('فاتورة')} {picked.number}</p>
              <p className="text-[11px] text-gray-400 text-center mb-3">{tr('المتبقي')} {formatCurrency(picked.remainingAmt)}</p>
              <label className="block text-xs text-gray-500 mb-1">{tr('المبلغ المحصل بالبطاقة')}</label>
              <DecimalInput value={amount ?? Number(picked.remainingAmt)} onCommit={(v: number) => { if (v !== amount) resetLaunch(); setAmount(v); }} min={0} readOnly={busy}
                className="w-full border border-gray-200 rounded-xl p-3 text-lg font-bold text-center" />
              <button onClick={start} disabled={busy || !(amount == null || amount > 0)}
                className="w-full mt-4 bg-[#1F1A13] disabled:bg-gray-300 text-white rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />} {tr('افتح جهاز الدفع')}
              </button>
              {launch && <p className="text-xs text-[#1F1A13] font-semibold mt-2 text-center">{tr('العملية جاهزة اضغط الزر مرة أخرى لفتح جهاز الدفع')}</p>}
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
                <button key={inv.id} onClick={() => { setPicked(inv); setAmount(Number(inv.remainingAmt)); setError(null); resetLaunch(); }}
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
    {/* خارج غطاء الورقة: نقرةٌ في النتيجة لا تصعد إليه فتغلق الورقة */}
    {viewing && <CardPayResult pending={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

type CheckState = { status: string; receiptNumber?: string | null; detail?: string | null; amount?: number; reference?: string };

/**
 * نتيجة التحصيل بعد الرجوع من وحدة الدفع — نسأل الخادم كل ٣ ثوانٍ حتى تُحسم أو ٤٥ ثانية؛ وما لم يُحسم يُكمله مجدول الخادم
 * فيُسجَّل السند تلقائياً حين تؤكّد NearPay، و«تحقّق الآن» يعيد السؤال. «unsupported» = تطبيقٌ قديم بلا وحدة الدفع.
 * و«review» (مراجعة ٣١ أكتوبر ٢٠٢٦): خُصم المال لدى NearPay واختلف شيءٌ فلم يُقيَّد السند — تنبيهٌ كهرماني «لا تحصّل ثانية»
 * لا «لم يتم التحصيل» الأحمر الذي كان يدعو المندوب إلى خصمٍ ثانٍ من العميل.
 */
export function CardPayResult({ pending, unsupported, onClose, onDone }: {
  pending: CardPayPending | null; unsupported?: boolean; onClose: () => void; onDone?: () => void;
}) {
  const tr = useTr();
  const [state, setState] = useState<CheckState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (unsupported || !pending) return;
    let live = true; // لكل جولة — «تحقّق الآن» لا يترك جولةً سابقة تدور معها
    setTimedOut(false);
    const started = Date.now();
    const tick = async () => {
      if (!live) return;
      try {
        const r = await repApi.post(`/card-payments/${encodeURIComponent(pending.id)}/check`);
        if (!live) return;
        const d = r.data.data as CheckState;
        setState(d);
        setError(null);
        if (d.status !== 'pending') {
          clearPendingCardPay(pending.id);
          if (d.status === 'approved') onDone?.();
          return;
        }
      } catch (e: any) {
        if (!live) return;
        setError(e?.response?.data?.message || tr('تعذر الاتصال للتحقق من الدفع'));
      }
      if (Date.now() - started < 45_000) setTimeout(tick, 3000);
      else setTimedOut(true);
    };
    void tick();
    return () => { live = false; };
  }, [pending?.id, unsupported, round]);

  const st = state?.status;
  // المبلغ والفاتورة من الخادم أولاً: العملية المحفوظة على الجوال قد تغيب (رجوعٌ برابطٍ بعد مسحها)
  const amount = state?.amount ?? pending?.amount ?? 0;
  const invoiceNumber = state?.reference || pending?.invoiceNumber || '';
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-3xl w-full max-w-sm p-6 text-center" onClick={e => e.stopPropagation()}>
        {unsupported ? (
          <>
            <XCircle size={44} className="mx-auto text-amber-500" />
            <p className="font-bold mt-3">{tr('حدث تطبيق المندوب')}</p>
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">{tr('التحصيل بالبطاقة يعمل من تطبيق المندوب على أندرويد بأحدث نسخة من Google Play ولم يخصم أي مبلغ من العميل')}</p>
          </>
        ) : st === 'approved' ? (
          <>
            <CheckCircle2 size={48} className="mx-auto text-green-600" />
            <p className="font-bold mt-3">{tr('تم التحصيل بالبطاقة')}</p>
            {amount > 0 && <p className="text-2xl font-bold mt-2">{formatCurrency(amount)}</p>}
            {state?.receiptNumber && <p className="text-sm text-gray-500 mt-1">{tr('سند القبض')} {state.receiptNumber}</p>}
          </>
        ) : st === 'review' ? (
          <>
            <AlertTriangle size={48} className="mx-auto text-amber-500" />
            <p className="font-bold mt-3">{tr('خصم المبلغ لدى NearPay ولم يسجل السند بعد')}</p>
            {amount > 0 && <p className="text-sm text-gray-500 mt-1">{tr('فاتورة')} {invoiceNumber} — {formatCurrency(amount)}</p>}
            <p className="text-sm text-amber-800 bg-amber-50 rounded-xl p-3 mt-3 leading-relaxed">{tr('لا تحصل من العميل مرة أخرى الإدارة تراجع العملية وتسجل السند أو تعيد المبلغ')}</p>
            {state?.detail && <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">{state.detail}</p>}
          </>
        ) : st && st !== 'pending' ? (
          <>
            <XCircle size={48} className="mx-auto text-red-500" />
            <p className="font-bold mt-3">{tr('لم يتم التحصيل')}</p>
            <p className="text-sm text-gray-500 mt-2 leading-relaxed">{state?.detail || tr('رفضت العملية أو ألغيت ولم يسجل سند')}</p>
          </>
        ) : (
          <>
            {timedOut ? <RefreshCw size={40} className="mx-auto text-[#1F1A13]" /> : <Loader2 size={44} className="mx-auto text-[#1F1A13] animate-spin" />}
            <p className="font-bold mt-3">{timedOut ? tr('لم تحسم العملية بعد') : tr('جار التحقق من الدفع')}</p>
            {(invoiceNumber || amount > 0) && <p className="text-sm text-gray-500 mt-1">{tr('فاتورة')} {invoiceNumber}{amount > 0 ? ` — ${formatCurrency(amount)}` : ''}</p>}
            <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">{tr('إن أغلقت هذه النافذة يكمل الخادم التحقق ويسجل السند تلقائيا عند تأكيد الدفع')}</p>
            {error && <p className="text-[11px] text-amber-700 mt-2">{error}</p>}
            {timedOut && (
              <button onClick={() => setRound((r) => r + 1)}
                className="w-full mt-4 border border-[#1F1A13] text-[#1F1A13] rounded-xl py-2.5 font-semibold text-sm flex items-center justify-center gap-2">
                <RefreshCw size={15} /> {tr('تحقق الآن')}
              </button>
            )}
          </>
        )}
        <button onClick={onClose} className="w-full mt-5 bg-[#1F1A13] text-white rounded-xl py-3 font-semibold text-sm">{tr('إغلاق')}</button>
      </div>
    </div>
  );
}
