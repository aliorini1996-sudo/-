import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { WifiOff } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { aiAccountantApi } from '../api/client';
import { MHeader } from './mobileUi';
import AiAccountantChat from '../components/aiAccountant/AiAccountantChat';
import MDocViewer, { type MDocViewerDoc } from './MDocViewer';

/**
 * «المحاسب الذكي AI» على الجوال (/m) — قسمٌ من الرئيسية بجانب «الموردون» (قرار المالك)، صفحةٌ كاملة فوق الشريطين
 * بترويستها وزرّ رجوعها كبقيّة الأقسام. المحادثة نفسها التي في الويب (`compact`: ملء الارتفاع وحشوٌ أصغر)، بالـAPI نفسه
 * وبطاقات التقرير والقيد والمستند نفسها — فلا نسخة جوّالية تنحرف عنها.
 *
 * الجسم لا يُمرَّر هنا (لا MScreen): المحادثة تمرّر رسائلها وحدها وتثبّت مدخلها أسفلها، وتمريرٌ ثانٍ حولها يُزيح المدخل
 * عن موضعه. والبوّابات كلّها في الخادم (العلم والمحاسبة وصلاحية التقارير والنطاق)؛ القوقعة لا تُظهر البلاطة إلا بها.
 *
 * ما يخصّ الجوال وحده (رفع المستندات — طلب المالك ١٨ نوفمبر):
 * - عارض المستند طبقةٌ بملء الشاشة (MDocViewer) بزرّ الرجوع، تمرّره المحادثة المشتركة بـ`renderViewer` بدل عارض سطح المكتب.
 * - لوحة المفاتيح لا تغطّي بطاقة المستند: ما تغطّيه من أسفل الشاشة يُطرح من ارتفاع الصفحة (visualViewport)، فيستقرّ المدخل
 *   فوقها وتقصر الرسائل؛ ومن كان في آخر المحادثة يبقى فيه، وحقلٌ في البطاقة يُكشف حين يُركَّز عليه.
 * - بلا اتصال: شريطٌ يقول إن الرفع يحتاج الإنترنت — لا طابور للمستندات على الجهاز (الملف والقيد يُحفظان في الخادم وحده).
 */

/** أقلّ من هذا ليس لوحة مفاتيح — شريط أدوات المتصفّح يظهر ويختفي مع التمرير */
const KB_MIN_PX = 80;
/** هامش الحقل المكشوف عن حافّتي المساحة المرئيّة */
const REVEAL_GAP_PX = 12;
/** «في آخر المحادثة»: بعدٌ عن القاع أقلّ من هذا */
const AT_BOTTOM_PX = 48;
/** حقول الكتابة التي تفتح لوحة المفاتيح (القوائم المنسدلة تفتح منتقي النظام لا اللوحة) */
const TYPING_FIELD = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="hidden"])';

/**
 * ما تغطّيه لوحة المفاتيح من أسفل التخطيط: ارتفاعه ناقص المرئيّ منه (visualViewport) وإزاحته. أندرويد القديم
 * (resizes-content) يُقصّر التخطيط نفسه ⇒ صفرٌ فلا يُعوَّض مرّتين؛ وآيفون وكروم ١٠٨+ (resizes-visual) يُبقيانه ⇒ الفرق.
 */
export function keyboardInset(layoutH: number, vvH: number, vvTop: number): number {
  const covered = Math.round(layoutH - vvH - vvTop);
  return covered >= KB_MIN_PX ? covered : 0;
}

/**
 * كم يُمرَّر صندوق الرسائل ليظهر الحقل بين أعلى المرئيّ منه وأسفله (فوق لوحة المفاتيح): موجبٌ للأسفل، وصفرٌ إن ظهر.
 * الحقل الأطول من المساحة يُظهَر أعلاه.
 */
export function revealDelta(field: { top: number; bottom: number }, box: { top: number; bottom: number }, view: { top: number; bottom: number }): number {
  const top = Math.max(box.top, view.top) + REVEAL_GAP_PX;
  const bottom = Math.min(box.bottom, view.bottom) - REVEAL_GAP_PX;
  if (field.bottom > bottom) return Math.min(field.bottom - bottom, field.top - top);
  if (field.top < top) return field.top - top;
  return 0;
}

/** أقرب سلفٍ يُمرَّر فعلاً (صندوق الرسائل في المحادثة) — دون تجاوز جذر الشاشة */
function scrollerOf(el: Element | null, stop: Element | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n && n !== stop; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

const visibleView = () => {
  const vv = window.visualViewport;
  return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: window.innerHeight };
};

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** بايتات المستند للعارض (GET /ai-accountant/documents/:id/content) — الشركة والرافع والصلاحية يحرسها الخادم */
async function loadDocContent(id: string): Promise<Blob> {
  const res = await aiAccountantApi.documents.content(id);
  const data: unknown = res.data;
  return data instanceof Blob ? data : new Blob([data as BlobPart]);
}

export default function MAiAccountant({ onBack }: { onBack: () => void }) {
  const tr = useTr();
  const rootRef = useRef<HTMLDivElement>(null);

  // ─── الاتصال: نمط القوقعة (MobileApp) — navigator.onLine وحدثا online/offline ───
  const [online, setOnline] = useState(isOnline);
  useEffect(() => {
    const sync = () => setOnline(isOnline());
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    sync();
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  // ─── لوحة المفاتيح ───
  const [kb, setKb] = useState(0);
  const kbNow = useRef(0);
  /** حقل البطاقة المركَّز عليه — يُكشف بعد انزلاق اللوحة واستقرار الارتفاع الجديد */
  const field = useRef<HTMLElement | null>(null);
  /** صندوق الرسائل كان في قاعه قبل تغيّر اللوحة ⇒ يبقى فيه بعده (آخر بطاقة فوق المدخل لا تحت اللوحة) */
  const pinned = useRef<HTMLElement | null>(null);
  const timer = useRef(0);

  const reveal = useCallback(() => {
    const el = field.current;
    if (!el || !el.isConnected || document.activeElement !== el) return;
    const box = scrollerOf(el, rootRef.current);
    if (!box) return;
    const d = revealDelta(el.getBoundingClientRect(), box.getBoundingClientRect(), visibleView());
    if (d) box.scrollBy({ top: d, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const next = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
      if (next === kbNow.current) return;
      // يُقاس قبل أن يُرسم الارتفاع الجديد
      const box = scrollerOf(rootRef.current?.querySelector('[data-entry]') ?? null, rootRef.current);
      pinned.current = box && box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX ? box : null;
      kbNow.current = next;
      setKb(next);
    };
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);
  // مهلة الكشف لا تعيش بعد مغادرة الشاشة (ولو بلا visualViewport)
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // بعد رسم الارتفاع الجديد: حقل البطاقة المركَّز يُكشف، وإلا فالقاع يبقى قاعاً
  useLayoutEffect(() => {
    const box = pinned.current;
    pinned.current = null;
    const f = field.current;
    if (f && f.isConnected && document.activeElement === f) { reveal(); return; }
    if (box?.isConnected) box.scrollTop = box.scrollHeight;
  }, [kb, reveal]);

  const onFocusIn = (e: FocusEvent<HTMLDivElement>) => {
    const el = e.target;
    // حقول الرسائل وحدها (بطاقة المستند داخل فقاعة) — المدخل أسفل الصفحة يستقرّ فوق اللوحة بالارتفاع نفسه
    if (!(el instanceof HTMLElement) || !el.matches(TYPING_FIELD) || !el.closest('[data-entry]')) return;
    field.current = el;
    reveal();
    // اللوحة تنزلق نحو ثلث ثانية، وبعض المتصفّحات لا تُطلق resize حتى تستقرّ
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(reveal, 350);
  };

  // عارض المستند: طبقة الجوال بدل عارض سطح المكتب — بمفتاح المستند فتبديله يعيد الجلب ويُبطل رابط السابق، و`src` معاينةٌ
  // محلّية يملكها المستدعي إن مرّرها (اختياري: المحادثة قد تمرّر المستند وحده)
  const renderViewer = useCallback(
    (doc: MDocViewerDoc, onClose: () => void, src?: string | null) =>
      <MDocViewer key={doc.id} doc={doc} onClose={onClose} load={loadDocContent} src={src} />,
    [],
  );

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-[#FAF7F0]" style={kb ? { paddingBottom: kb } : undefined} onFocus={onFocusIn}>
      <MHeader title={tr('المحاسب الذكي')} subtitle={tr('اسأل عن أرقام شركتك واطلب التقارير وسجل المصروفات بالكلام')} onBack={onBack} />
      {!online && (
        <div role="status" className="flex-shrink-0 flex items-start gap-2 px-3 py-1.5 bg-[#FAEFD8] text-[#8A6A12] border-b border-[#F0DDB0] text-[11px] leading-snug">
          <WifiOff size={13} className="flex-shrink-0 mt-px" />
          <span className="min-w-0">{tr('لا يوجد اتصال — رفع المستندات يحتاج اتصالاً بالإنترنت ولا يحفظ على الجهاز')}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        <AiAccountantChat compact renderViewer={renderViewer} />
      </div>
    </div>
  );
}
