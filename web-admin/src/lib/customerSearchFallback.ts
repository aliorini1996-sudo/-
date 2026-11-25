// «رقم العميل» والقوائم المقصوصة (مراجعة ٢٤ نوفمبر ٢٠٢٦): منتقيات العملاء ذات التصفية المحلية (نافذتا الفاتورة والسند، وتطبيق
// المندوب، والأرصدة اليدوية) تجلب أول ١٠٠٠ عميل بالأحدث أولاً — فشركةٌ أكبر تفقد أقدم عملائها، وهم أصحاب الأرقام الصغيرة
// (#1، #2…) أكثر ما يُكتب، فلا يجد «#12» شيئاً. حين تمتلئ القائمة بسقفها يُسأل الخادم عن النصّ المكتوب (GET /customers?search=
// يطابق الرقم تماماً والاسم والجوال والرمز، داخل نطاق المستخدم وعزل المندوب) وتُضمّ نتائجه إلى المجموعة فيصفّيها المنتقي محلياً
// كالبقيّة. قائمةٌ دون سقفها كاملة فلا طلب. ولا يمسّ الكاش المحلي (تطبيق المندوب يبقى يعمل دون اتصال بما خزّنه).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { customerNumberQuery } from './customerNumber';

/** سقف القائمة المحلية (limit المرسَل مع الجلب الأول) */
export const LOCAL_CUSTOMER_CAP = 1000;
/** عدد نتائج الخادم لكل بحث */
export const REMOTE_CUSTOMER_LIMIT = 30;
/** مهلة الكتابة قبل الطلب — طلبٌ واحد لكل كلمةٍ تهدأ */
export const REMOTE_SEARCH_DEBOUNCE_MS = 300;

/** القائمة امتلأت بسقفها ⇒ قد يكون وراءها عملاء لم يُحمَّلوا */
export function isCappedList(loaded: number, cap: number = LOCAL_CUSTOMER_CAP): boolean {
  return loaded >= cap;
}

/** نصٌّ يستحق سؤال الخادم (مقصوصاً كحدّ بحث الخادم 100 حرف): رقم عميل ولو خانةً واحدة، أو حرفان فأكثر — وإلا null */
export function remoteSearchTerm(q: string): string | null {
  const t = q.trim().slice(0, 100);
  if (!t) return null;
  return customerNumberQuery(t) != null || t.length >= 2 ? t : null;
}

/** المحمَّل أوّلاً بترتيبه، ثم ما جلبه البحث ولم يكن فيه (بالمعرّف) — فصفّ القائمة يبقى مصدر الحقيقة لمن فيها */
export function mergeById<T extends { id: string }>(base: readonly T[], extra: readonly T[]): T[] {
  if (!extra.length) return base as T[];
  const seen = new Set(base.map(c => c.id));
  const out = [...base];
  for (const c of extra) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  return out;
}

const EMPTY: never[] = [];

export interface RemoteCustomerSearcher { query: (q: string) => void; cancel: () => void }

/**
 * منطق السؤال بلا React (يُختبر في node): كل تغيّرٍ في النصّ يلغي المؤجَّل قبله، والكلمة الصالحة (remoteSearchTerm) تُسأل بعد
 * المهلة مرّةً واحدة — والفاشلة (انقطاع/رفض) تُنسى فتُعاد عند الكتابة التالية. الصفوف تُسلَّم لـonFound (ولو وصلت بعد تغيّر
 * النصّ: المجموعة تراكمية والتصفية محلية بالنصّ الحالي). cancel عند إزالة المنتقي.
 */
export function remoteCustomerSearcher<T>(
  search: (term: string) => Promise<T[]>,
  onFound: (rows: T[]) => void,
  delayMs: number = REMOTE_SEARCH_DEBOUNCE_MS,
): RemoteCustomerSearcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const asked = new Set<string>();
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return {
    cancel,
    query(q: string) {
      cancel();
      const term = remoteSearchTerm(q);
      if (!term || asked.has(term)) return;
      timer = setTimeout(() => {
        timer = null;
        asked.add(term);
        search(term)
          .then(rows => { if (Array.isArray(rows) && rows.length) onFound(rows); })
          .catch(() => { asked.delete(term); });
      }, delayMs);
    },
  };
}

/**
 * المجموعة = المحمَّل + ما وجده الخادم لما كُتب (يتراكم طوال عمر المنتقي، فالمختار من الخادم يبقى معروضاً بعد مسح البحث).
 * onQueryChange يُعاد حين تكون القائمة مقصوصة وحدها، ويُمرَّر إلى SearchableSelect (أو حقل الكتابة) — والتصفية تبقى محلية.
 * search: الطلب نفسه بنطاق الشاشة (customerApi.list للإدارة، repApi للمندوب) يعيد صفوف العملاء أو يرمي عند الانقطاع.
 */
export function useCustomerSearchFallback<T extends { id: string }>(
  loaded: readonly T[] | undefined,
  search: (term: string) => Promise<T[]>,
  opts: { cap?: number; enabled?: boolean } = {},
): { pool: T[]; onQueryChange?: (q: string) => void } {
  const base = loaded ?? EMPTY;
  const active = (opts.enabled ?? true) && isCappedList(base.length, opts.cap);
  const [found, setFound] = useState<T[]>(EMPTY);
  // آخر دالة بحث (قد تكون سهماً جديداً كل عرض) — المُسائل يُنشأ مرّةً لعمر المنتقي
  const searchRef = useRef(search);
  searchRef.current = search;
  const searcher = useRef<RemoteCustomerSearcher | null>(null);
  if (!searcher.current) {
    searcher.current = remoteCustomerSearcher<T>(term => searchRef.current(term), rows => setFound(prev => mergeById(prev, rows)));
  }
  useEffect(() => () => searcher.current?.cancel(), []);

  const onQueryChange = useCallback((q: string) => searcher.current?.query(q), []);

  const pool = useMemo(() => mergeById(base, found), [base, found]);
  return active ? { pool, onQueryChange } : { pool };
}
