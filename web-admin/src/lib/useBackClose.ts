import { useEffect, useRef } from 'react';

/**
 * زرّ الرجوع في أندرويد وسحبة الحافة في آيفون — لطبقات واجهةٍ تُدار بالحالة.
 *
 * تطبيق المندوب ولوحة الجوال يبدّلان شاشاتهما بحالة React لا بمسارات، فلا
 * مدخلة في تاريخ المتصفّح يرجع إليها الزرّ ⇒ كان يُنهي التطبيق من أيّ عمق:
 * من نصف فاتورة، أو من ملفّ عميل ومؤقّت زيارته يعدّ. وسحبةُ الحافة في آيفون
 * تجتاز تاريخَ التنقّل نفسه، فحدثٌ واحد يكفي للاثنين: `popstate`.
 *
 * ولأن `popstate` **غير قابل للإلغاء** (وقع التنقّل قبل أن نُستدعى)، فالنمط
 * الوحيد الممكن: ندفع مدخلةً عند فتح الطبقة، ونغلقها حين يخبرنا الحدث أنها
 * سُحبت. ودالّة `close` يجب أن تُغلق دائماً وبلا شرط — لا حوار تأكيد فيها.
 *
 * ═══ لماذا سجلّ مركزيّ ومُوفِّق مؤجَّل، لا push/back داخل كل مكوّن ═══
 *
 * ثلاثة أعطال معروفة يقتلها هذا التصميم من جذرها:
 *
 * ١) **تبديل طبقتين في لقطة واحدة** — «أنشئ عميلاً» يُغلق نفسه ويفتح ملفّ
 *    العميل معاً، و«أصدر فاتورة» يُغلق النموذج ويفتح المستند. و`history.back()`
 *    غير متزامن بينما `pushState` متزامن، فينقلب الترتيب ويصل الرجوع متأخّراً
 *    فيُغلق الطبقة **الجديدة**. بتأجيل المزامنة إلى `queueMicrotask` واحد تصير
 *    الحصيلة «العمق المطلوب = العمق الحالي» ⇒ لا عمل إطلاقاً.
 *
 * ٢) **حلقة الإغلاق المتتالي** — لو استدعى التنظيفُ `history.back()` دائماً،
 *    لسحب الإغلاقُ الآتي من الرجوع مدخلةً ثانية فأغلق طبقتين بضغطة. لذلك
 *    يُزيل `popstate` الطبقة من السجلّ **قبل** استدعاء `close`، فيجد التنظيف
 *    نفسه مزالاً ويصمت.
 *
 * ٣) **تراكم المدخلات** — تمرير `close` سهماً جديداً كل تصيير كان سيدفع مدخلةً
 *    مع كل تصيير حتى يلزم المستخدمَ عشرُ ضغطات للخروج. فالردّ في `useRef`
 *    والتبعية `[open]` وحدها.
 *
 * وStrictMode يشغّل التأثير مرّتين في التطوير (تسجيل ← إلغاء ← تسجيل)، والمُوفِّق
 * المؤجَّل يجعل حصيلتها صفراً أيضاً.
 */

interface Layer { id: number; close: () => void }

let layers: Layer[] = [];
let pushed = 0;            // عدد المدخلات التي ندين بها لتاريخ المتصفّح
let selfPops = 0;          // رجوعٌ أصدرناه نحن لا المستخدم
let scheduled = false;
let nextId = 1;
let bound = false;

const DEPTH = '__fsDepth';

function reconcile(): void {
  scheduled = false;
  const want = layers.length;
  if (want === pushed) return;           // فتحٌ وإغلاق في اللقطة نفسها ⇒ لا عمل
  if (want > pushed) {
    while (pushed < want) {
      pushed += 1;
      window.history.pushState({ ...window.history.state, [DEPTH]: pushed }, '');
    }
    return;
  }
  const steps = pushed - want;
  pushed = want;
  // `go(-n)` يُطلق popstate **واحداً** لا n — فيُعدّ واحداً، وإلا ابتلع العدّادُ
  // ضغطةَ رجوعٍ حقيقية لاحقة فبدا الزرّ ميتاً
  selfPops += 1;
  window.history.go(-steps);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(reconcile);
}

function onPop(e: PopStateEvent): void {
  if (selfPops > 0) { selfPops -= 1; return; }
  const depth = (e.state as Record<string, unknown> | null)?.[DEPTH];
  const d = typeof depth === 'number' ? depth : 0;
  pushed = d;
  // الإزالة قبل الاستدعاء — انظر العطل (٢) أعلاه
  while (layers.length > d) {
    const layer = layers.pop();
    if (layer) layer.close();
  }
}

function bind(): void {
  if (bound) return;
  bound = true;
  window.addEventListener('popstate', onPop);
  // إقلاعٌ بارد فوق مدخلاتٍ قديمة (آيفون يُخلي التطبيق ثم يعيد تحميله وحالةُ
  // React مصفّرة): نُطبّع العمق وإلا صارت ضغطاتُ رجوعٍ ميتة ثم خروجٌ مفاجئ
  const depth = (window.history.state as Record<string, unknown> | null)?.[DEPTH];
  if (typeof depth === 'number' && depth > 0) { pushed = depth; schedule(); }
}

/**
 * يجعل زرّ الرجوع يُغلق هذه الطبقة بدل أن يخرج من التطبيق.
 *
 * يُستدعى **دائماً بلا شرط** (قاعدة الخطّافات) — التحكّم بوسيط `open` وحده،
 * ويُرتَّب من الطبقة الأعلى بصرياً إلى الأدنى.
 *
 * @param open هل الطبقة مفتوحة الآن
 * @param close ما يُغلقها — بلا شرط ولا حوار تأكيد
 */
export function useBackClose(open: boolean, close: () => void): void {
  const ref = useRef(close);
  ref.current = close;

  useEffect(() => {
    if (!open) return;
    bind();
    const id = nextId++;
    layers.push({ id, close: () => ref.current() });
    schedule();
    return () => {
      const i = layers.findIndex(l => l.id === id);
      if (i === -1) return;      // سحبه الرجوع أصلاً ⇒ لا نسحب مدخلةً ثانية
      layers.splice(i, 1);
      schedule();
    };
  }, [open]);
}

/** لأغراض الاختبار فقط — يُصفّر السجلّ بين الحالات */
export function __resetBackStack(): void {
  layers = [];
  pushed = 0;
  selfPops = 0;
  scheduled = false;
}
