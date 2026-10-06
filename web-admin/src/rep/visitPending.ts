/**
 * زيارات المندوب المقيَّد «بانتظار الاتصال لتسجيلها» — ليست صفّ العمل دون اتصال (offlineDb/offlineSync).
 *
 * المقيَّد بـ«اشتراط تفعيل الموقع» لا يبدأ مؤقّته إلا متصلاً وبقراءة (visitLocation.ts). فإن انقطعت الشبكة لحظة انتهاء
 * الزيارة لم تدخل الصفّ (والخادم يردّ ما يُعاد رفعه منه للمقيَّد): تبقى هنا بقراءة البدء — مكان الوصول — ظاهرةً له،
 * وتُعاد حيّةً (بلا ترويسة إعادة الرفع) كلما عاد الاتصال، فلا تُسجَّل إلا متصلاً. وما يردّه الخادم أو ما لم تُلتقط له
 * قراءة يبقى «لم تُسجَّل» بسببه حتى يُخفيه المندوب — لا يُسقط بلا أثر.
 *
 * localStorage كمؤقّت الزيارة (visitTimer.ts): ينجو من إعادة التحميل، والمنطق صرفٌ يُختبر بمخزونٍ وهميّ.
 */

const KEY = 'rep_visits_awaiting_net';

export interface PendingVisit {
  clientRef: string;
  /** صاحب الزيارة — لا تُرفع بجلسة زميلٍ على الجهاز نفسه (كصفّ العمل دون اتصال) */
  repId?: string;
  customerName: string;
  /** حمولة POST /visits كما بُنيت عند الانتهاء (بإحداثيات البدء) */
  payload: Record<string, unknown>;
  /** لحظة انتهاء الزيارة — ISO */
  endedAt: string;
  /** waiting: تنتظر الاتصال وتُعاد؛ failed: لم تُسجَّل (ردّها الخادم أو بلا قراءة) — تُعرض بسببها ولا تُعاد */
  status: 'waiting' | 'failed';
  error?: string;
}

const isPending = (v: unknown): v is PendingVisit => {
  const p = v as PendingVisit | null;
  return !!p && typeof p.clientRef === 'string' && typeof p.customerName === 'string' && typeof p.endedAt === 'string'
    && !!p.payload && typeof p.payload === 'object' && (p.status === 'waiting' || p.status === 'failed');
};

export function getPendingVisits(): PendingVisit[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(isPending) : [];
  } catch {
    return [];
  }
}

function save(list: PendingVisit[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch { /* مخزونٌ ممتلئ أو محجوب: أفضل جهد */ }
}

/** إضافة أو استبدال (بالمفتاح clientRef) */
export function putPendingVisit(v: PendingVisit): void {
  save([...getPendingVisits().filter((x) => x.clientRef !== v.clientRef), v]);
}

export function removePendingVisit(clientRef: string): void {
  save(getPendingVisits().filter((x) => x.clientRef !== clientRef));
}

/** زيارات صاحب الجلسة — القديمة بلا repId تُعدّ له (كصفّ العمل دون اتصال) */
export function ownPendingVisits(repId: string | undefined, list: PendingVisit[] = getPendingVisits()): PendingVisit[] {
  return list.filter((v) => !v.repId || !repId || v.repId === repId);
}

/** نتيجة محاولة رفعٍ حيّة: نجح، أو خطأ بحالته ورمزه (لا حالة = انقطاع) */
export type PostResult = { ok: true } | { ok: false; status?: number; code?: string; message?: string };

/**
 * done: سُجّلت فتُزال. keep: تبقى تنتظر — انقطاع، أو خطأ خادم مؤقّت، أو جلسة (401)، أو عميلها في صفّ الجهاز لم يُرفع
 * بعد (CUSTOMER_REF_PENDING). failed: رفض أعمال (4xx) — لا تُعاد، وتُعرض بسببها.
 */
export type RetryOutcome = 'done' | 'keep' | 'failed';
export function pendingRetryOutcome(r: PostResult): RetryOutcome {
  if (r.ok) return 'done';
  if (r.status == null || r.status >= 500 || r.status === 401 || r.status === 408 || r.status === 429) return 'keep';
  if (r.code === 'CUSTOMER_REF_PENDING') return 'keep';
  return 'failed';
}

/** من خطأ axios إلى PostResult */
export function postResultOf(err: unknown): PostResult {
  const resp = (err as { response?: { status?: number; data?: { code?: string; message?: string } } })?.response;
  return { ok: false, status: resp?.status, code: resp?.data?.code, message: resp?.data?.message };
}

let running = false;
/**
 * يعيد رفع زيارات صاحب الجلسة المنتظرة واحدةً واحدة بـ`post` (رفعٌ حيّ). يتوقّف عند أول انقطاع (الشبكة لم تعد) ولا
 * يمسّ «لم تُسجَّل» ولا زيارات غيره. آمن للاستدعاء المتكرّر (قفل). يعيد عدد ما سُجّل وما بقي وما رُدّ.
 */
export async function retryPendingVisits(post: (payload: Record<string, unknown>) => Promise<void>, repId: string | undefined,
  fallbackError = 'رفضها الخادم'): Promise<{ done: number; kept: number; failed: number }> {
  const out = { done: 0, kept: 0, failed: 0 };
  if (running) return out;
  running = true;
  try {
    const waiting = ownPendingVisits(repId).filter((v) => v.status === 'waiting')
      .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    for (let i = 0; i < waiting.length; i++) {
      const v = waiting[i];
      let r: PostResult;
      try { await post(v.payload); r = { ok: true }; } catch (err) { r = postResultOf(err); }
      const o = pendingRetryOutcome(r);
      if (o === 'done') { removePendingVisit(v.clientRef); out.done++; continue; }
      if (o === 'failed') {
        putPendingVisit({ ...v, status: 'failed', error: (!r.ok && r.message) || fallbackError });
        out.failed++;
        continue;
      }
      out.kept++;
      // انقطاعٌ أو خطأ خادم: لا جدوى من البقية الآن
      if (!r.ok && (r.status == null || r.status >= 500)) { out.kept += waiting.length - i - 1; break; }
    }
  } finally {
    running = false;
  }
  return out;
}
