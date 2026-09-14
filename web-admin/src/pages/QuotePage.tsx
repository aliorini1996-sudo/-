import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertTriangle, CheckCircle2, CloudUpload, FileDown, Loader2, Share2 } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import { elementToPdfBlob, shareOrDownloadPdf } from '../rep/pdf';
import { quotesApi, type QuoteIssuePayload } from '../api/client';
import {
  NOTE_MAX, PACKAGES, PackageId, QuoteDocument, VALID_DAYS, docMeta, localQuoteNo, money, quoteFigures,
} from '../quote/quoteDoc';

/**
 * مُصدِر عروض الأسعار السريع — رابطٌ خاصّ `/q-fs7k2m` بلا دخول، للمالك وموظّفي المبيعات.
 * غير مُدرج: noindex ولا روابط إليه.
 *
 * يُغني عن فتح ملفّ الوورد في كل مرّة: اسم المنشأة ورقمها الموحّد والباقة ودورة
 * السداد، واسم مقدّم العرض ونصٌّ إضافيّ اختياريّان، ثمّ PDF **بصفحة واحدة** جاهز
 * يُشارَك عبر قائمة الجوال (واتساب وغيره).
 *
 * كل إصدارٍ **يُسجَّل** في سجلّ المالك (لوحة المالك ← عروض الأسعار) ويأخذ رقمه
 * التسلسليّ من الخادم. وإن تعذّر التسجيل لا يتعطّل الموظّف أمام العميل: يُصدَر الملف
 * برقمٍ مؤقّت ويُحفظ في طابور الجوال ليُسجَّل تلقائياً.
 */

const PRESENTER_KEY = 'fs_quote_presenter';
const PENDING_KEY = 'fs_quote_pending';
/** نافذة «تفعيل المستخدم» لقائمة المشاركة ~٥ث بعد اللمسة — بعدها تُرفض المشاركة الآلية */
const SHARE_GESTURE_MS = 4000;

type Pending = QuoteIssuePayload & { localNo: string; issuedAt: string };

const readPending = (): Pending[] => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const writePending = (list: Pending[]) => {
  try {
    // سقفٌ واقٍ من امتلاء التخزين لا حدٌّ عمليّ (العرض الواحد أقلّ من ١ك.ب)
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-500)));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* تخزينٌ محجوب — يبقى الملف صادراً وإن فات التسجيل */ }
};

const statusOf = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
/**
 * رفضٌ نهائيّ للبيانات نفسها — لا فائدة من إعادة المحاولة. وما عداه (الشبكة، 429، 5xx،
 * و404 حين تسبق الواجهةُ الخادمَ في النشر) مؤقّتٌ: يُصدَر الملف ويبقى العرض في الطابور.
 */
const isFinalReject = (s: number | undefined) => s === 400 || s === 413 || s === 422;

let flushing: Promise<void> | null = null;
let rerun = false;
/**
 * يرفع طابور العروض غير المسجَّلة — تشغيلٌ واحدٌ في آن، ونداءٌ أثناءه يُعيد الدورة بعده
 * (لا يُهمَل). انقطاع الشبكة يوقف الدورة؛ ورفض الخادم لعرضٍ بعينه لا يحجز ما بعده.
 */
function flushPending(): Promise<void> {
  if (flushing) { rerun = true; return flushing; }
  flushing = (async () => {
    do {
      rerun = false;
      const done = new Set<string>();
      for (const p of readPending()) {
        try { await quotesApi.issue(p); done.add(p.clientRef); } catch (e) {
          const s = statusOf(e);
          if (isFinalReject(s)) done.add(p.clientRef);
          else if (!s) break; // لا اتصال — المحاولة التالية لاحقاً
        }
      }
      if (done.size) writePending(readPending().filter(p => !done.has(p.clientRef)));
    } while (rerun);
  })().finally(() => { flushing = null; });
  return flushing;
}

const newRef = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ');

/** لقطة محتوى العرض — تُجمَّد لحظة اللمس فيُطبع ويُسجَّل الشيء نفسه ولو تغيّرت الحقول بعدها */
interface Snap { company: string; unifiedNo: string; pkgId: PackageId; cycle: 'monthly' | 'yearly'; presenter: string; note: string }
interface Issued { key: string; no: string; issuedAt: string; recorded: boolean; reason?: 'offline' | 'server' }

export default function QuotePage() {
  // رابطٌ خاصّ: لا فهرسة، ويُستعاد وسم robots والعنوان عند المغادرة
  useEffect(() => {
    const prevTitle = document.title;
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    const prevRobots = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'robots');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', 'noindex, nofollow');
    document.title = 'عرض سعر — Field Sales';
    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (prevRobots !== null) meta?.setAttribute('content', prevRobots);
    };
  }, []);

  const [pendingCount, setPendingCount] = useState(() => readPending().length);
  const syncQueue = () => { void flushPending().then(() => setPendingCount(readPending().length)); };

  /* الطابور يُرفع عند فتح الصفحة، وعودة الاتصال، والرجوع إليها، وكل دقيقة ما دام فيه شيء —
   * لا يكفي حدث «online»: رفض الخادم المؤقّت (نشرٌ جارٍ، 429، 5xx) لا يطلقه أبداً */
  useEffect(() => {
    syncQueue();
    const onVisible = () => { if (document.visibilityState === 'visible') syncQueue(); };
    window.addEventListener('online', syncQueue);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => { if (readPending().length) syncQueue(); }, 60_000);
    return () => {
      window.removeEventListener('online', syncQueue);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [company, setCompany] = useState('');
  const [unifiedNo, setUnifiedNo] = useState('');
  const [pkgId, setPkgId] = useState<PackageId>('pro');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  // اسم مقدّم العرض يُتذكَّر على جهاز الموظّف فلا يُكتب في كل عرض (بسقف الخادم)
  const [presenter, setPresenter] = useState(() => {
    try { return (localStorage.getItem(PRESENTER_KEY) ?? '').slice(0, 80); } catch { return ''; }
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [meta, setMeta] = useState(() => docMeta('—', new Date(), VALID_DAYS));
  const [share, setShare] = useState<{ key: string; blob: Blob; filename: string } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);

  const live: Snap = {
    company: oneLine(company), unifiedNo: unifiedNo.trim(), pkgId, cycle, presenter: oneLine(presenter), note: note.trim(),
  };
  const key = JSON.stringify(live);
  const current = issued && issued.key === key ? issued : null;
  const readyShare = share && share.key === key ? share : null;

  const pkg = PACKAGES.find(p => p.id === pkgId)!;
  const yearly = cycle === 'yearly';
  const figures = quoteFigures(yearly ? pkg.yearly : pkg.total);

  const ready = live.company.length > 1 && /^\d{5,20}$/.test(live.unifiedNo);

  // المستند المطبوع من اللقطة المجمّدة أثناء الإصدار، ومن الحقول الحيّة خارجه
  const view = snap ?? live;
  const vPkg = PACKAGES.find(p => p.id === view.pkgId)!;
  const vYearly = view.cycle === 'yearly';

  /** يسجّل العرض ويُرجع رقمه — أو رقماً مؤقّتاً في الطابور حين يتعذّر التسجيل */
  const record = async (s: Snap, k: string): Promise<Issued | null> => {
    const payload: QuoteIssuePayload = {
      clientRef: newRef(),
      company: s.company,
      unifiedNo: s.unifiedNo,
      packageId: s.pkgId,
      cycle: s.cycle,
      presenter: s.presenter || undefined,
      note: s.note || undefined,
    };
    try {
      const res = await quotesApi.issue(payload);
      const d = res.data.data as { quoteNo: string; issuedAt: string };
      syncQueue(); // الخادم متاح — فرصةٌ لرفع ما تعلّق قبله
      return { key: k, no: d.quoteNo, issuedAt: d.issuedAt, recorded: true };
    } catch (e) {
      const s2 = statusOf(e);
      if (isFinalReject(s2)) {
        const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
        setErr(msg || 'تعذر تسجيل العرض راجع البيانات');
        return null;
      }
      const at = new Date();
      const localNo = localQuoteNo(at);
      writePending([...readPending(), { ...payload, localNo, issuedAt: at.toISOString() }]);
      setPendingCount(readPending().length);
      return { key: k, no: localNo, issuedAt: at.toISOString(), recorded: false, reason: s2 ? 'server' : 'offline' };
    }
  };

  const issue = async () => {
    if (!ready || !docRef.current || busy) return;
    const t0 = performance.now();
    const s = live;
    const k = key;
    setBusy(true); setErr(''); setShare(null);
    try {
      try { localStorage.setItem(PRESENTER_KEY, s.presenter); } catch { /* تخزينٌ محجوب */ }
      const q = current ?? await record(s, k);
      if (!q) return;
      setIssued(q);
      // اللقطة والرقم والتاريخ تُرسم في المستند **قبل** الالتقاط لا بعده
      flushSync(() => { setSnap(s); setMeta(docMeta(q.no, new Date(q.issuedAt), VALID_DAYS)); });
      const blob = await elementToPdfBlob(docRef.current, { singlePage: true });
      const safe = s.company.replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
      const filename = `عرض سعر - ${safe} - ${q.no}.pdf`;
      /* شبكةٌ بطيئة + التقاطٌ على جوالٍ متوسّط قد يستهلكان نافذة اللمسة، فتُرفض قائمة
       * المشاركة وينزل الملف صامتاً في التنزيلات. حينها يُعرض زرّ مشاركةٍ بلمسةٍ جديدة. */
      if (performance.now() - t0 > SHARE_GESTURE_MS) setShare({ key: k, blob, filename });
      else await shareOrDownloadPdf(blob, filename);
    } catch {
      setErr('تعذر إصدار الملف حاول مجددا');
    } finally {
      setSnap(null);
      setBusy(false);
    }
  };

  const shareNow = async () => {
    if (!readyShare) return;
    const { blob, filename } = readyShare;
    setShare(null);
    await shareOrDownloadPdf(blob, filename).catch(() => setErr('تعذر مشاركة الملف حاول مجددا'));
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="bg-[#1F1A13] text-white px-4 py-3 flex items-center gap-2.5">
        <BrandIcon size={30} radius={0.3} />
        <div>
          <p className="text-sm font-bold leading-tight">عرض سعر سريع</p>
          <p className="text-[11px] text-[#9A8F7E]" dir={current ? 'ltr' : undefined}>
            {current ? current.no : 'يُرقَّم العرض عند إصداره'}
          </p>
        </div>
      </header>

      <main className="max-w-md mx-auto p-4 space-y-4">
        {/* الحقول تُقفل أثناء الإصدار: ما يُطبع ويُسجَّل هو ما كان لحظة اللمس */}
        <fieldset disabled={busy} className="space-y-4 min-w-0 border-0 p-0 m-0 disabled:opacity-70">
          <section className="bg-white rounded-2xl border border-[#F1EBDF] p-4 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-[#6E6557] mb-1">اسم المنشأة</label>
              <input className="input" value={company} maxLength={200} onChange={e => setCompany(e.target.value)}
                placeholder="مثال: شركة الأمل للتجارة" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#6E6557] mb-1">الرقم الموحد</label>
              <input className="input" dir="ltr" inputMode="numeric" value={unifiedNo} maxLength={20}
                onChange={e => setUnifiedNo(e.target.value.replace(/[^\d]/g, ''))} placeholder="7000000000" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#6E6557] mb-1">اسم مقدم العرض</label>
              <input className="input" value={presenter} maxLength={80} onChange={e => setPresenter(e.target.value)}
                placeholder="مثال: محمد العتيبي" />
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-bold text-[#9A8F7E] px-1">دورة السداد</p>
            <div className="grid grid-cols-2 gap-2">
              {(['monthly', 'yearly'] as const).map(c => (
                <button key={c} type="button" onClick={() => setCycle(c)}
                  className={`rounded-xl border py-3 font-semibold ${
                    cycle === c ? 'border-[#E15A30] bg-[#E15A30] text-white' : 'border-[#F1EBDF] bg-white'}`}>
                  {c === 'monthly' ? 'شهرية' : 'سنوية — شهران مجاناً'}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-bold text-[#9A8F7E] px-1">الباقة</p>
            {PACKAGES.map(p => (
              <button key={p.id} type="button" onClick={() => setPkgId(p.id)}
                className={`w-full text-start rounded-2xl border p-3.5 flex items-center justify-between gap-3 transition-colors ${
                  pkgId === p.id ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#F1EBDF] bg-white'}`}>
                <span className="min-w-0">
                  <span className="block font-bold">{p.name}</span>
                  <span className="block text-[11px] text-[#9A8F7E]">{p.limit}</span>
                </span>
                <span className="text-left flex-shrink-0">
                  <span className="block font-bold tabular-nums">{yearly ? p.yearly : p.total} ر.س</span>
                  <span className="block text-[10px] text-[#9A8F7E]">
                    {yearly
                      ? <>سنوياً بدل <span className="line-through tabular-nums">{p.total * 12}</span></>
                      : 'شهرياً شامل الضريبة'}
                  </span>
                </span>
              </button>
            ))}
          </section>

          <section className="bg-white rounded-2xl border border-[#F1EBDF] p-4 text-sm space-y-1.5 tabular-nums">
            <Row label={yearly ? 'السعر السنوي قبل الضريبة' : 'السعر الشهري قبل الضريبة'} value={`${money(figures.net)} ر.س`} />
            <Row label="ضريبة القيمة المضافة ١٥٪" value={`${money(figures.vat)} ر.س`} />
            <div className="border-t border-[#F1EBDF] pt-1.5">
              <Row strong label={yearly ? 'الإجمالي السنوي' : 'الإجمالي الشهري'} value={`${money(figures.total)} ر.س`} />
            </div>
            {yearly && (
              <p className="text-[11px] text-[#2F7A4B] pt-1">
                توفير {money(pkg.total * 12 - pkg.yearly)} ر.س مقارنة بالسداد الشهري ({pkg.total} × ١٢)
              </p>
            )}
          </section>

          <section className="bg-white rounded-2xl border border-[#F1EBDF] p-4">
            <label className="block text-xs font-semibold text-[#6E6557] mb-1">نص إضافي (اختياري)</label>
            <textarea className="input min-h-[96px] resize-y" value={note} maxLength={NOTE_MAX}
              onChange={e => setNote(e.target.value)}
              placeholder="مثال: خصم خاص عند الاشتراك خلال هذا الأسبوع" />
            <p dir="ltr" className="text-[10px] text-[#9A8F7E] mt-1 text-left tabular-nums">{note.length} / {NOTE_MAX}</p>
          </section>
        </fieldset>

        {err && <p className="text-center text-sm text-[#C0392B]">{err}</p>}

        {readyShare ? (
          <button type="button" onClick={shareNow}
            className="w-full bg-[#2F7A4B] text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2">
            <Share2 size={18} /> الملف جاهز — شاركه الآن
          </button>
        ) : (
          <button type="button" onClick={issue} disabled={!ready || busy}
            className="w-full bg-[#E15A30] text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Share2 size={18} />}
            إصدار العرض ومشاركته
          </button>
        )}
        {!ready && (
          <p className="text-center text-[11px] text-[#9A8F7E] flex items-center justify-center gap-1">
            <FileDown size={12} /> أدخل اسم المنشأة ورقمها الموحد
          </p>
        )}
        {current && (current.recorded ? (
          <p className="text-center text-[11px] text-[#2F7A4B] flex items-center justify-center gap-1">
            <CheckCircle2 size={12} /> سُجّل العرض في سجل عروض الأسعار
          </p>
        ) : (
          <p className="text-center text-[11px] text-[#9A6B1E] flex items-center justify-center gap-1">
            <AlertTriangle size={12} className="flex-shrink-0" />
            {current.reason === 'offline'
              ? 'لا اتصال الآن — صدر الملف برقم مؤقت ويُسجَّل تلقائياً عند عودة الاتصال'
              : 'تعذر الوصول لسجل العروض الآن — صدر الملف برقم مؤقت ويُسجَّل تلقائياً'}
          </p>
        ))}
        {pendingCount > 0 && (
          <p className="text-center text-[11px] text-[#9A8F7E] flex items-center justify-center gap-1">
            <CloudUpload size={12} /> عروض بانتظار التسجيل على هذا الجهاز: <span className="tabular-nums">{pendingCount}</span>
          </p>
        )}
      </main>

      {/* ═══ المستند المطبوع — خارج الشاشة، يُلتقط بمقاس A4 ═══ */}
      <div style={{ position: 'fixed', left: -10000, top: 0 }} aria-hidden>
        <QuoteDocument ref={docRef} company={view.company} unifiedNo={view.unifiedNo}
          presenter={view.presenter} note={view.note} pkg={vPkg} yearly={vYearly}
          figures={quoteFigures(vYearly ? vPkg.yearly : vPkg.total)} meta={meta} validDays={VALID_DAYS} />
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? 'font-bold text-base' : 'text-[#6E6557]'}`}>
      <span>{label}</span><span className="text-[#1F1A13]">{value}</span>
    </div>
  );
}
