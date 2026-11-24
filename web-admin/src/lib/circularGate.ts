/**
 * «التعميمات» — بوّابة «تمت القراءة» (طرف المستهلك، طلب المالك ٢٣ نوفمبر ٢٠٢٦).
 *
 * الإدارة تُصدر تعميماً (قراراً أو إعلاناً إدارياً) للمناديب أو لمستخدمي الشركة؛ فإذا فتح الموظف التطبيق ظهرت له نافذةٌ صغيرة
 * بنصّ التعميم لا تُغلق إلا بـ«تمت القراءة». هنا منطقها النقيّ وحده (بلا React ولا شبكة) ليُختبر: ترتيب المعلّق وتنقيته،
 * وحكم ردّ الإقرار، وصفّ الإقرارات دون اتصال لتطبيق المندوب (localStorage — تخزينٌ قد يرمي فكلّه في try/catch).
 *
 * المكوّن: components/circulars/CircularGate.tsx — مركَّبٌ في القواقع الثلاث (لوحة الويب /app، وتطبيق الإدارة /m، وتطبيق المندوب /rep).
 */

/** تعميمٌ معلّق كما يردّه GET /api/circulars/pending */
export interface PendingCircular {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  createdByName: string | null;
}

/** إقرارٌ سُجّل على الجهاز ولم يصل الخادم بعد (تطبيق المندوب دون اتصال) — مربوطٌ بصاحبه: جهازٌ مشترك لا يُقرّ عن غيره */
export interface AckEntry {
  id: string;
  /** معرّف المندوب الذي ضغط «تمت القراءة» — الرفع بجلسته هو وحده */
  uid: string;
  /**
   * لحظة الضغط (ms، ساعة الجهاز) — تُرفع readAt مع الإقرار فيُسجَّل بها لا بلحظة الرفع، ويُقبل ولو سُحب التعميم أو انتهى قبل
   * عودة الاتصال ما دامت الضغطة قبل ذلك (الخادم يصحّحها بانحراف الساعة X-FS-Device-Now ويحصرها). وللتقادم
   */
  at: number;
}

/** مفتاح صفّ الإقرارات في localStorage (مساحة المندوب) */
export const CIRCULAR_ACK_QUEUE_KEY = 'rep_circular_ack_queue';
/** دورة الجلب أثناء بقاء التطبيق مفتوحاً */
export const CIRCULAR_REFRESH_MS = 5 * 60_000;
/** أقلّ فاصلٍ بين جلبين يطلبهما الرجوع إلى التطبيق أو عودة الاتصال — المندوب يتنقّل بين الكاميرا والخرائط مراراً */
export const CIRCULAR_MIN_GAP_MS = 30_000;
/** مهلة «التسليح»: الزرّ لا يقبل ضغطةً في أوّل لحظات ظهور التعميم — لمسةٌ كانت متّجهةً لما تحته لا تُحتسب قراءة */
export const CIRCULAR_ARM_MS = 700;
/**
 * مهلتا طلبَي الجلب والإقرار في القواقع الثلاث: شبكةٌ «متصلة» لا يمرّ فيها شيء (إشارةٌ بلا بيانات) كانت تُبقي الإقرار معلّقاً
 * فالزرّ على «جار الحفظ» والنافذة تحجب التطبيق كله، والجلبُ المعلّق يوقف كل جلبٍ بعده. بالمهلة يفشل الطلب بلا ردّ ⇒ «يُعاد»
 * (ackOutcome): يُصفّ الإقرار في تطبيق المندوب ويمضي، ورسالةٌ وإعادة في اللوحة
 */
export const CIRCULAR_FETCH_TIMEOUT_MS = 10_000;
export const CIRCULAR_ACK_TIMEOUT_MS = 8_000;
/** سقف الصفّ — أقدمه يسقط أوّلاً */
export const ACK_QUEUE_MAX = 200;
/** إقرارٌ أقدم من هذا لا يُرفع (تعميمٌ سُحب أو انتهى منذ زمن) */
export const ACK_QUEUE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * ردّ /circulars/pending إلى قائمةٍ نظيفة مرتّبة (الأقدم أوّلاً، والتعادل بالمعرّف): ما ليس مصفوفةً = لا شيء،
 * وصفٌّ بلا معرّف أو بلا عنوانٍ ونصّ يسقط، والمكرّر بالمعرّف يُعرض مرّة.
 */
export function pendingRowsOf(data: unknown): PendingCircular[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: PendingCircular[] = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = str(o.id).trim();
    const title = str(o.title);
    const body = str(o.body);
    if (!id || seen.has(id) || (!title.trim() && !body.trim())) continue;
    seen.add(id);
    const by = str(o.createdByName).trim();
    out.push({ id, title, body, createdAt: str(o.createdAt), createdByName: by || null });
  }
  return orderPending(out);
}

/** لحظة التعميم (ms) — وتاريخٌ لا يُقرأ يُعدّ أحدثَ شيء فيُعرض آخِراً */
const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
};

/** الأقدم أوّلاً (كما يعِد الخادم)، والتعادل بالمعرّف فلا يتبدّل المعروض بين جلبين */
export function orderPending(rows: PendingCircular[]): PendingCircular[] {
  return [...rows].sort((a, b) => {
    const d = timeOf(a.createdAt) - timeOf(b.createdAt);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** ما يُعرض: المعلّق بلا ما أقرّ به هذا الجهاز (إقرارٌ في الطريق أو في الصفّ) — ردٌّ سبق الإقرار لا يُعيد نافذته */
export function visiblePending(rows: PendingCircular[], hidden: ReadonlySet<string>): PendingCircular[] {
  return rows.filter((r) => !hidden.has(r.id));
}

/** العدّاد «١ من ٣»: الموضع = ما أُقرّ به في هذه الجولة + ١، والمجموع = ما أُقرّ به + الباقي */
export function counterOf(ackedInRun: number, remaining: number): { index: number; total: number } {
  const done = Math.max(0, Math.floor(ackedInRun));
  const left = Math.max(0, Math.floor(remaining));
  return { index: left > 0 ? done + 1 : done, total: done + left };
}

/** يُعرض العدّاد حين يكون في الجولة أكثر من تعميم */
export const showCounter = (c: { total: number }): boolean => c.total > 1;

/**
 * حكم ردّ POST /circulars/:id/ack:
 *  - done  — نجح (٢xx): سُجّلت القراءة.
 *  - drop  — رفضٌ نهائيّ لا تُصلحه الإعادة: 404 (غير موجَّه لي، أو سُحب أو انتهى **قبل** لحظة الضغط — ضغطةٌ قبل ذلك تُقبل
 *            بلحظتها)، 403 (جلسة دخول المالك/الموظف)،
 *            400/409/422 — يُرفع من القائمة بلا إعادة.
 *  - retry — لا ردّ (انقطاع/مهلة) أو 401 (تجديد الجلسة) أو 408/429 أو 5xx: يُعاد لاحقاً.
 */
export function ackOutcome(status: number | null | undefined): 'done' | 'drop' | 'retry' {
  if (status == null || !Number.isFinite(status) || status === 0) return 'retry';
  if (status >= 200 && status < 300) return 'done';
  if (status === 401 || status === 408 || status === 429 || status >= 500) return 'retry';
  return 'drop';
}

/** رمز حالة خطأ axios (أو null حين لا ردّ — انقطاع) */
export function statusOf(err: unknown): number | null {
  const s = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return typeof s === 'number' ? s : null;
}

/** قراءة الصفّ من نصّه المخزَّن — أيّ تلفٍ = صفٌّ فارغ، والصفوف الناقصة تسقط */
export function parseAckQueue(raw: string | null | undefined): AckEntry[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: AckEntry[] = [];
  for (const e of v) {
    const o = (e ?? {}) as Record<string, unknown>;
    const id = str(o.id).trim();
    const uid = str(o.uid).trim();
    const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
    if (id && uid) out.push({ id, uid, at });
  }
  return dedupeAcks(out);
}

/** صفّ بلا تكرار (المعرّف + صاحبه) — يبقى الأقدم: هو لحظة القراءة الأولى */
function dedupeAcks(q: AckEntry[]): AckEntry[] {
  const seen = new Set<string>();
  const out: AckEntry[] = [];
  for (const e of q) {
    const k = `${e.uid}\u0000${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** تقليم: المتقادم يسقط، والسقف يُسقط الأقدم */
export function pruneAcks(q: AckEntry[], now: number): AckEntry[] {
  const fresh = q.filter((e) => now - e.at <= ACK_QUEUE_MAX_AGE_MS);
  return fresh.length > ACK_QUEUE_MAX ? fresh.slice(fresh.length - ACK_QUEUE_MAX) : fresh;
}

/** إضافة إقرارٍ للصفّ — مكرّرٌ لصاحبه نفسه لا يُضاف ثانيةً */
export function enqueueAck(q: AckEntry[], id: string, uid: string, now: number): AckEntry[] {
  if (!id || !uid) return q;
  return pruneAcks(dedupeAcks([...q, { id, uid, at: now }]), now);
}

/** إقرارات هذا المندوب وحده — الرفع بجلسته فلا يُقرّ عن زميلٍ دخل قبله على الجهاز نفسه */
export const ownAcks = (q: AckEntry[], uid: string): AckEntry[] => q.filter((e) => e.uid === uid);

/** إسقاط ما حُسم من إقرارات صاحبه (نجح أو رُفض نهائياً) — صفوف غيره كما هي */
export function removeAcks(q: AckEntry[], uid: string, ids: ReadonlySet<string>): AckEntry[] {
  return q.filter((e) => e.uid !== uid || !ids.has(e.id));
}

/** تخزينٌ بواجهة localStorage — يُمرَّر في الاختبار */
export interface KeyStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const defaultStore = (): KeyStore | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

/** قراءة الصفّ — تخزينٌ محجوب (وضعٌ خاص) أو تالف = صفٌّ فارغ */
export function readAckQueue(store: KeyStore | null = defaultStore()): AckEntry[] {
  if (!store) return [];
  try { return parseAckQueue(store.getItem(CIRCULAR_ACK_QUEUE_KEY)); } catch { return []; }
}

/** كتابة الصفّ — الفارغ يُمحى مفتاحه، والفشل صامت (الإقرار يُعاد طلبه من الخادم في الجولة التالية) */
export function writeAckQueue(q: AckEntry[], store: KeyStore | null = defaultStore()): void {
  if (!store) return;
  try {
    if (q.length === 0) store.removeItem(CIRCULAR_ACK_QUEUE_KEY);
    else store.setItem(CIRCULAR_ACK_QUEUE_KEY, JSON.stringify(q));
  } catch { /* تخزينٌ ممتلئ أو محجوب */ }
}

/**
 * رفع صفّ هذا المندوب بالتسلسل بعد جلبٍ ناجح: ما حُسم (نجح أو رُفض نهائياً) يخرج، وما يُعاد يبقى. يقف عند أوّل انقطاع —
 * لا عشرات الطلبات الفاشلة على شبكةٍ سقطت للتوّ. كل إقرارٍ يُرفع بلحظة ضغطه (readAt = e.at): يُسجَّل بها، ويُقبل ولو أُغلق التعميم
 * بعدها. يعيد المعرّفات المحسومة (لتُخفى من ردٍّ جُلب قبل الرفع).
 */
export async function flushAckQueue(
  uid: string,
  ack: (id: string, readAt: number) => Promise<unknown>,
  store: KeyStore | null = defaultStore(),
  now: number = Date.now(),
): Promise<Set<string>> {
  const settled = new Set<string>();
  if (!uid) return settled;
  const mine = ownAcks(pruneAcks(readAckQueue(store), now), uid);
  for (const e of mine) {
    let outcome: 'done' | 'drop' | 'retry';
    try { await ack(e.id, e.at); outcome = 'done'; } catch (err) { outcome = ackOutcome(statusOf(err)); }
    if (outcome === 'retry') break;
    settled.add(e.id);
  }
  // يُقرأ الصفّ ثانيةً قبل الكتابة: ضغطةٌ أُضيفت أثناء الرفع لا تُمحى
  writeAckQueue(removeAcks(pruneAcks(readAckQueue(store), now), uid, settled), store);
  return settled;
}

/** هل حان جلبٌ يطلبه محفِّز (الرجوع للتطبيق/عودة الاتصال)؟ الإقلاع والدورة يجلبان بلا شرط الفاصل */
export function fetchDue(lastMs: number, nowMs: number, minGapMs: number = CIRCULAR_MIN_GAP_MS): boolean {
  return !lastMs || nowMs - lastMs >= minGapMs || nowMs < lastMs;
}

/**
 * لا بوّابة لجلسةٍ ليست لموظفٍ في الشركة: مالك المنصة وموظفها، و«دخول» أيٍّ منهما إلى شركة (علم impersonating أو علامة
 * من دخل أو حمولة التوكن). الخادم يردّها [] ويرفض إقرارها 403 — والواجهة لا تسأل أصلاً.
 */
export function circularGateSkipped(s: {
  role?: string | null;
  impersonating?: unknown;
  staffImpersonation?: boolean;
  impersonationToken?: boolean;
}): boolean {
  if (s.role === 'SUPER_ADMIN' || s.role === 'PLATFORM_STAFF') return true;
  return !!s.impersonating || s.staffImpersonation === true || s.impersonationToken === true;
}
