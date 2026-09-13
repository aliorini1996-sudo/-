// ============================================================================
// تنقّل بوابة السفير عبر شريط العنوان — نقيّ بلا React ولا DOM.
//
// زرّ الرجوع في أندرويد يمشي في سجلّ المتصفّح لا في حالة React: لو بقيت
// الشاشة في useState لخرج الرجوع من /ax كلياً وضاع نموذج تسجيلٍ نصف مكتمل.
// لذا تُشتقّ الشاشة من العنوان، وكل انتقالٍ بين الشاشات مدخلٌ جديد في السجل:
//   · شاشات ما قبل الجلسة  ⇒ `/ax?view=register|forgot|resend|verify|reset`
//     (الدخول هو `/ax` بلا معامل — الشاشة الأولى)
//   · تبويبات البوابة      ⇒ `/ax#link` … (الرئيسية `/ax` بلا وسم)
//   · روابط البريد `?verify=TOKEN` و`?reset=TOKEN` تُقرأ مرّةً ويُستبدل بها
//     `?view=verify|reset` **استبدالاً** (لا دفعاً): الرمز لا يبقى في الشريط ولا
//     في السجل، والرجوع من أوّل شاشة يخرج من البوابة بلا حلقة.
// ============================================================================

export type AuthView = 'login' | 'register' | 'verify' | 'forgot' | 'reset' | 'resend';
export const AUTH_VIEWS: readonly AuthView[] = ['login', 'register', 'verify', 'forgot', 'reset', 'resend'];

export type Tab = 'home' | 'link' | 'claims' | 'companies' | 'earnings' | 'profile' | 'terms';
export const TAB_IDS: readonly Tab[] = ['home', 'link', 'claims', 'companies', 'earnings', 'profile', 'terms'];

export const VIEW_PARAM = 'view';

export type LinkToken = { kind: 'verify' | 'reset'; token: string };

function params(search: string): URLSearchParams {
  try { return new URLSearchParams(search || ''); } catch { return new URLSearchParams(); }
}

/** رمز رابط البريد في سلسلة الاستعلام (التأكيد يسبق الاستعادة) أو null */
export function linkTokenFromSearch(search: string): LinkToken | null {
  const p = params(search);
  const v = p.get('verify');
  if (v) return { kind: 'verify', token: v };
  const r = p.get('reset');
  if (r) return { kind: 'reset', token: r };
  return null;
}

/** الشاشة من العنوان: رمز البريد أولاً، ثم `?view=`، وإلا الدخول */
export function viewFromSearch(search: string): AuthView {
  const link = linkTokenFromSearch(search);
  if (link) return link.kind;
  const v = params(search).get(VIEW_PARAM);
  return (AUTH_VIEWS as readonly string[]).includes(v ?? '') ? (v as AuthView) : 'login';
}

/** التبويب من الوسم، وإلا الرئيسية */
export function tabFromHash(hash: string): Tab {
  const h = (hash || '').replace(/^#/, '');
  return (TAB_IDS as readonly string[]).includes(h) ? (h as Tab) : 'home';
}

/** سلسلة الاستعلام لشاشة — الدخول بلا معامل ليبقى `/ax` هو الشاشة الأولى */
export function authViewSearch(view: AuthView): string {
  return view === 'login' ? '' : `?${VIEW_PARAM}=${view}`;
}

/** الوسم لتبويب — الرئيسية بلا وسم */
export function tabHash(tab: Tab): string {
  return tab === 'home' ? '' : `#${tab}`;
}

export interface NavTarget { search: string; hash: string }

/**
 * وجهة الانتقال إلى شاشة ما قبل الجلسة — أو null إن كان العنوان عليها أصلاً
 * (نقرةٌ مكرّرة لا تُضيف مدخلاً ثانياً للسجل فيحتاج الرجوع ضغطتين).
 */
export function authTarget(search: string, hash: string, next: AuthView): NavTarget | null {
  const same = !linkTokenFromSearch(search) && viewFromSearch(search) === next && clean(hash) === '';
  return same ? null : { search: authViewSearch(next), hash: '' };
}

/** وجهة الانتقال إلى تبويب — أو null إن كان التبويب نفسه معروضاً */
export function tabTarget(search: string, hash: string, next: Tab): NavTarget | null {
  const same = clean(search) === '' && tabFromHash(hash) === next;
  return same ? null : { search: '', hash: tabHash(next) };
}

/** `?` و`#` الفارغان كالغياب */
function clean(s: string): string {
  const v = s || '';
  return v === '?' || v === '#' ? '' : v;
}

/**
 * هل تُعرض شاشة رابط البريد (تأكيد/استعادة)؟ تحتاج رمزاً في الذاكرة، ومع **جلسةٍ قائمة**
 * لا تُعرض إلا لرابطٍ فُتح للتوّ (`freshLink`) — العودة إليها من سجلّ المتصفّح تذهب للبوابة.
 */
export function showLinkScreen(
  kind: 'verify' | 'reset',
  st: { view: AuthView; token: string | undefined; hasToken: boolean; freshLink: 'verify' | 'reset' | null },
): boolean {
  if (st.view !== kind || !st.token) return false;
  return !st.hasToken || st.freshLink === kind;
}

/**
 * نتيجة رابط التأكيد حسب الحالة **الفعلية** التي يُعيدها الخادم:
 *  · `review`   — أُكّد الآن والطلب ينتظر المراجعة
 *  · `approved` — البريد مؤكَّد والحساب مقبول ⇒ إلى الدخول
 *  · `already`  — مرفوض أو موقوف (أو قيمة غير معروفة) ⇒ نصّ محايد بلا وعد مراجعة
 */
export type VerifyOutcome = 'review' | 'approved' | 'already';
export function verifyOutcome(status: unknown): VerifyOutcome {
  if (status === 'pending_review') return 'review';
  if (status === 'approved') return 'approved';
  return 'already';
}
