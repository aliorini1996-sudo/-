import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Megaphone } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { formatDateTime, formatNumber } from '../../utils/format';
import {
  CIRCULAR_ARM_MS, CIRCULAR_REFRESH_MS, ackOutcome, counterOf, enqueueAck, fetchDue, flushAckQueue, ownAcks, pendingRowsOf,
  readAckQueue, showCounter, statusOf, visiblePending, writeAckQueue, type PendingCircular,
} from '../../lib/circularGate';

/**
 * بوّابة «التعميمات» — نافذة «تمت القراءة» (طلب المالك ٢٣ نوفمبر ٢٠٢٦).
 *
 * الإدارة تُصدر تعميماً (قراراً أو إعلاناً إدارياً)، فإذا فتح الموظف التطبيق — المندوب في /rep، أو مستخدم الشركة في لوحة الويب
 * و/m — ظهرت له نافذةٌ صغيرة في الوسط بنصّ التعميم، **لا تُغلق بالنقر على الخلفية ولا بـEscape**: مخرجها الوحيد «تمت القراءة».
 * وأكثر من تعميم ⇒ تُعرض تباعاً (الأقدم أوّلاً) بعدّاد «١ من ٣».
 *
 * الجلب: عند التركيب، وعند الرجوع إلى التطبيق (بفاصلٍ أدنى)، وعند عودة الاتصال، وكل ٥ دقائق والصفحة ظاهرة. وتعذّر الجلب =
 * لا نافذة (المندوب في الميدان بلا شبكة لا يُحجب تطبيقه أبداً).
 *
 * تطبيق المندوب (offlineQueue): ضغطةٌ لم تصل الخادم (انقطاع أو مهلة، أو الجهاز يعلن أنه دون اتصال) تُحفظ في صفٍّ على الجهاز
 * باسم صاحبها ولحظتها ويمضي — وتُرفع بعد أوّل جلبٍ ناجح بلحظة الضغط. لوحة الويب و/m أون‑لاين: الفشل رسالةٌ وإعادة.
 * والقواقع تمرّر طلبَيها بمهلة (CIRCULAR_FETCH_TIMEOUT_MS / CIRCULAR_ACK_TIMEOUT_MS) فلا تعلق النافذة على شبكةٍ لا يمرّ فيها شيء.
 *
 * والقوقعة تمرّر دالّتَي الجلب والإقرار (عميل الـAPI الخاصّ بها) — المكوّن لا يعرف أيّ عميلٍ يستعمل.
 */
export interface CircularGateProps {
  /** جلسة موظفٍ في الشركة دخل فعلاً — لا شاشة دخول، ولا مالك المنصة أو موظفها أو «دخول» أيّهما (circularGateSkipped) */
  enabled: boolean;
  /** صاحب الجلسة — يربط به صفّ الإقرارات، وتبدّله يبدأ البوّابة من الصفر */
  userId: string | null | undefined;
  /** GET /circulars/pending — يعيد `data` الردّ (مصفوفة)؛ الفشل يرمي */
  fetchPending: () => Promise<unknown>;
  /**
   * POST /circulars/:id/ack — الفشل يرمي (بـresponse.status إن ردّ الخادم). readAt (ms، ساعة الجهاز) يُمرَّر لإقرارٍ يُرفع من صفّ
   * الجهاز وحده (لحظة الضغط) — والإقرار الحيّ بلاه فيُسجَّل بساعة الخادم
   */
  ack: (id: string, readAt?: number) => Promise<unknown>;
  /** تطبيق المندوب: الإقرار المتعذّر يُصفّ على الجهاز ويُرفع لاحقاً بدل رسالة الخطأ */
  offlineQueue?: boolean;
  /** داخل إطار التطبيق (absolute) لا ملء النافذة (fixed) — /m و/rep يُعرضان في إطار جوالٍ على سطح المكتب */
  contained?: boolean;
  /** طبقة الظهور — فوق شاشات القوقعة ونوافذها */
  zClass?: string;
}

export default function CircularGate({
  enabled, userId, fetchPending, ack, offlineQueue = false, contained = false, zClass = 'z-[2200]',
}: CircularGateProps) {
  const tr = useTr();
  const [list, setList] = useState<PendingCircular[]>([]);
  // ما أُقرّ به في هذه الجولة — للعدّاد «٢ من ٣»؛ يعود صفراً حين تفرغ القائمة
  const [ackedInRun, setAckedInRun] = useState(0);
  const [busy, setBusy] = useState(false);
  // تعذّر الإقرار (لوحة الويب و/m) — رسالةٌ والنافذة باقية
  const [failed, setFailed] = useState(false);
  const [armed, setArmed] = useState(false);

  // الدالّتان في مرجع: القوقعة قد تمرّرهما مُنشأتين في كل رسم، ولا يُعاد ضبط الجلب الدوريّ لأجل ذلك
  const fns = useRef({ fetchPending, ack });
  fns.current = { fetchPending, ack };
  // ما أقرّ به هذا الجهاز (أُرسل أو صُفّ) — ردٌّ جُلب قبل وصول الإقرار لا يُعيد نافذته
  const hidden = useRef(new Set<string>());
  const lastFetch = useRef(0);
  // جيل الجلسة: جلبٌ أُطلق لمستخدمٍ سابق لا يكتب حالة من دخل بعده
  const gen = useRef(0);
  const inflight = useRef<number | null>(null);

  const load = useCallback(async (force: boolean) => {
    if (!enabled || !userId) return;
    const g = gen.current;
    const now = Date.now();
    if (inflight.current === g) return;
    if (!force && !fetchDue(lastFetch.current, now)) return;
    inflight.current = g;
    lastFetch.current = now;
    try {
      let rows: PendingCircular[];
      try {
        rows = pendingRowsOf(await fns.current.fetchPending());
      } catch {
        // لا اتصال أو المسار غير متاح: لا نافذة جديدة — وما يُعرض الآن يبقى (إقراره يُصفّ في تطبيق المندوب)
        lastFetch.current = 0;
        return;
      }
      if (g !== gen.current) return;
      if (offlineQueue) {
        // جلبٌ نجح = متصل: يُرفع صفّ هذا المندوب. ما في الصفّ قبل الرفع مخفيٌّ في كل حال (قرأه على الجهاز)
        for (const e of ownAcks(readAckQueue(), userId)) hidden.current.add(e.id);
        const settled = await flushAckQueue(userId, (id, readAt) => fns.current.ack(id, readAt));
        settled.forEach((id) => hidden.current.add(id));
        if (g !== gen.current) return;
      }
      setList(visiblePending(rows, hidden.current));
    } finally {
      if (inflight.current === g) inflight.current = null;
    }
  }, [enabled, userId, offlineQueue]);

  useEffect(() => {
    gen.current += 1;
    hidden.current = new Set();
    lastFetch.current = 0;
    inflight.current = null;
    setList([]); setAckedInRun(0); setFailed(false); setBusy(false);
    if (!enabled || !userId) return;
    void load(true);
    const onVisible = () => { if (!document.hidden) void load(false); };
    const onOnline = () => { void load(false); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    // الدورة للصفحة الظاهرة وحدها — تبويبٌ في الخلفية لا يطلب كل ٥ دقائق بلا قارئ
    const iv = window.setInterval(() => { if (!document.hidden) void load(true); }, CIRCULAR_REFRESH_MS);
    return () => {
      gen.current += 1;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.clearInterval(iv);
    };
  }, [enabled, userId, load]);

  const cur = list[0] ?? null;
  const shown = !!cur;

  useEffect(() => { if (!shown) setAckedInRun(0); }, [shown]);

  // استعادة التركيز لما كان عليه قبل النافذة — إلا حقل إدخال (على الجوال يُعيد فتح لوحة المفاتيح بلا طلب).
  // مُعلَنٌ قبل أثر التركيز أدناه عمداً: الآثار تجري بترتيب إعلانها، فيُلتقط ما كان مركَّزاً قبل أن يأخذ النصّ التركيز
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (shown) {
      const a = document.activeElement;
      prevFocus.current = a instanceof HTMLElement && a !== document.body ? a : null;
      return;
    }
    const p = prevFocus.current;
    prevFocus.current = null;
    if (p && p.isConnected && !/^(INPUT|TEXTAREA|SELECT)$/.test(p.tagName) && !p.isContentEditable) {
      try { p.focus({ preventScroll: true }); } catch { /* عنصرٌ لا يقبل التركيز */ }
    }
  }, [shown]);

  // «التسليح» لكل تعميمٍ يظهر: لمسةٌ كانت متّجهةً لما تحت النافذة لحظة ظهورها لا تُحتسب قراءة
  const btnRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const curId = cur?.id ?? null;
  useEffect(() => {
    setArmed(false);
    setFailed(false);
    if (!curId) return;
    // التركيز على نصّ التعميم لا على الزرّ: لوحة المفاتيح لا تكتب في نموذجٍ تحت النافذة، وقارئ الشاشة يبدأ بالنصّ — وEnter أو
    // مسافةٌ كانت متّجهةً لما تحتها (كتابةٌ باللمس، أو Enter الختاميّ لقارئ الليزر) لا تضغط «تمت القراءة» فتُسجَّل قراءةٌ لم تقع:
    // Enter على النصّ لا يفعل شيئاً والمسافة تمرّره. والزرّ بـTab أو باللمس وحده
    bodyRef.current?.focus({ preventScroll: true });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    const t = window.setTimeout(() => setArmed(true), CIRCULAR_ARM_MS);
    return () => window.clearTimeout(t);
  }, [curId]);

  const onRead = async () => {
    if (!cur || busy || !armed) return;
    const g = gen.current;
    // لحظة الضغط — قبل الطلب (قد يستغرق مهلته): بها يُصفّ الإقرار ويُرفع
    const pressedAt = Date.now();
    setBusy(true);
    setFailed(false);
    let outcome: 'done' | 'drop' | 'retry';
    if (offlineQueue && typeof navigator !== 'undefined' && navigator.onLine === false) {
      // الجهاز يعلن أنه دون اتصال: يُصفّ فوراً بلا انتظار طلبٍ محكومٍ بالفشل
      outcome = 'retry';
    } else {
      try { await fns.current.ack(cur.id); outcome = 'done'; } catch (err) { outcome = ackOutcome(statusOf(err)); }
    }
    if (g !== gen.current) return;
    if (outcome === 'retry' && offlineQueue && userId) {
      // تطبيق المندوب دون اتصال: تُحفظ الضغطة على الجهاز باسمه ولحظتها ويمضي — تُرفع بعد أوّل جلبٍ ناجح
      writeAckQueue(enqueueAck(readAckQueue(), cur.id, userId, pressedAt));
      outcome = 'done';
    }
    if (outcome === 'retry') {
      setFailed(true);
      setBusy(false);
      return;
    }
    // نجح، أو لم يعد معلّقاً لي (سُحب أو انتهى أو أُقرّ من جهازٍ آخر — 404): يخرج من القائمة في الحالين
    hidden.current.add(cur.id);
    setList((l) => l.filter((x) => x.id !== cur.id));
    if (outcome === 'done') setAckedInRun((n) => n + 1);
    setBusy(false);
  };

  // لا يُغلق بـEscape (ولا يبلغ Escape نافذةً تحتها فيُغلقها)، وTab يدور داخل النافذة
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    const order = [bodyRef.current, btnRef.current].filter((x): x is HTMLDivElement | HTMLButtonElement => !!x);
    if (!order.length) return;
    const i = order.indexOf(document.activeElement as HTMLDivElement | HTMLButtonElement);
    const next = i < 0 ? order[order.length - 1] : order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length];
    next.focus({ preventScroll: true });
  };

  const titleId = useId();
  const bodyId = useId();

  if (!cur) return null;

  const counter = counterOf(ackedInRun, list.length);
  // الناشر يُترجم كما في قائمة الإدارة (CircularMeta): «الدعم الفني» لجلسة دخول المالك أو الموظف له ترجمة، واسم الشخص يمرّ كما هو
  const issuer = cur.createdByName ? tr(cur.createdByName) : tr('الإدارة');
  const when = cur.createdAt ? formatDateTime(cur.createdAt) : '-';

  return (
    // لا onClick على الخلفية عمداً: النافذة لا تُغلق إلا بـ«تمت القراءة»
    <div
      className={`${contained ? 'absolute' : 'fixed'} inset-0 ${zClass} bg-[#1F1A13]/60 flex items-center justify-center p-4`}
      style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))', paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-circular-gate=""
      // قارئ الليزر (useLaserScanner) يُسقط ما يُكتب داخل ما وُسم هكذا — والتركيز محبوسٌ هنا، فمسحٌ والنافذة ظاهرة لا يبلغ سلّة فاتورةٍ تحتها
      data-laser-ignore=""
      onKeyDown={onKeyDown}
      // ضغطةٌ على الخلفية أو على نصٍّ لا يقبل التركيز لا تُخرج التركيز من النافذة إلى body — فيبقى Escape وTab محكومَين هنا
      // ولا يبلغ Escape نافذةً تحتها. النصّ والزرّ وحدهما يأخذان الضغطة كعادتها (تمرير النصّ وتحديده، و«تمت القراءة»)
      onMouseDown={(e) => {
        const t = e.target as Node;
        if (!bodyRef.current?.contains(t) && !btnRef.current?.contains(t)) e.preventDefault();
      }}
    >
      <div className="w-full max-w-md max-h-full flex flex-col rounded-3xl bg-white shadow-2xl overflow-hidden border-t-4 border-[#E15A30]">
        <div className="px-5 pt-5 pb-3 space-y-3 flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FBEBE2] text-[#C24A22] px-3 py-1 text-xs font-bold">
              <Megaphone size={14} aria-hidden="true" /> {tr('تعميم إداري')}
            </span>
            {showCounter(counter) && (
              <span className="text-xs font-semibold text-[#9A8F7E] tabular-nums" aria-live="polite">
                {tr('{i} من {n}').replace('{i}', formatNumber(counter.index)).replace('{n}', formatNumber(counter.total))}
              </span>
            )}
          </div>
          <h2 id={titleId} dir="auto" className="text-lg font-bold text-[#1F1A13] leading-snug break-words text-start">
            {cur.title}
          </h2>
        </div>
        <div
          ref={bodyRef}
          id={bodyId}
          tabIndex={0}
          dir="auto"
          className="mx-5 flex-1 min-h-0 overflow-y-auto rounded-2xl bg-[#FAF7F0] border border-[#EFE7D6] p-4 text-sm leading-7 text-[#3A3328] whitespace-pre-wrap break-words text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E15A30]/40"
        >
          {cur.body}
        </div>
        <div className="px-5 pt-3 pb-5 space-y-3 flex-shrink-0">
          <p className="text-xs text-[#9A8F7E] leading-relaxed">
            {tr('أصدره')}: <span className="font-semibold text-[#6E6557]">{issuer}</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span dir="auto">{when}</span>
          </p>
          {failed && <p className="text-xs font-semibold text-[#C0392B]" role="alert">{tr('تعذر تسجيل القراءة — تحقق من اتصالك ثم اعد المحاولة')}</p>}
          <button
            ref={btnRef}
            type="button"
            onClick={() => { void onRead(); }}
            aria-disabled={!armed || busy}
            className={`w-full min-h-[48px] rounded-2xl bg-[#E15A30] hover:bg-[#C94A22] py-3.5 text-white text-base font-bold transition-opacity focus:outline-none focus-visible:ring-4 focus-visible:ring-[#E15A30]/30 ${!armed || busy ? 'opacity-60 cursor-default' : ''}`}
          >
            {busy ? tr('جار الحفظ') : tr('تمت القراءة')}
          </button>
        </div>
      </div>
    </div>
  );
}
