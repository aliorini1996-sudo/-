// ============================================================================
// تنقّل بوابة السفير عبر شريط العنوان — نقيّ بلا React ولا DOM.
//
// زرّ الرجوع في أندرويد يمشي في سجلّ المتصفّح لا في حالة React: لو بقيت
// الشاشة في useState لخرج الرجوع من /ax كلياً وضاع نموذج تسجيلٍ نصف مكتمل.
// لذا تُشتقّ الشاشة من العنوان، وكل انتقالٍ بين الشاشات مدخلٌ جديد في السجل:
//   · شاشات ما قبل الجلسة  ⇒ `/ax?view=register|forgot|reset`
//     (الدخول هو `/ax` بلا معامل — الشاشة الأولى)
//   · تبويبات البوابة      ⇒ `/ax#link` … (الرئيسية `/ax` بلا وسم)
//   · رابط الاستعادة `?reset=TOKEN` يُقرأ مرّةً ويُستبدل به `?view=reset`
//     **استبدالاً** (لا دفعاً): الرمز لا يبقى في الشريط ولا في السجل.
//
// v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — الانضمام فوريّ): لا تأكيد بريد ولا إعادة إرسال. روابط
// البريد القديمة `?verify=TOKEN` و`?view=verify|resend` تذهب للدخول (`isLegacyAuthLink`).
//
// على الجوال شريطٌ سفليّ بأربعة (الرئيسية · شركاتي · أرباحي · المزيد) و«المزيد» ورقةٌ
// منزلقة بالباقي؛ وعلى الحاسوب (≥lg) شريطٌ جانبيّ بالكل — والتبويب من الوسم في الحالين.
// ============================================================================

export type AuthView = 'login' | 'register' | 'forgot' | 'reset';
export const AUTH_VIEWS: readonly AuthView[] = ['login', 'register', 'forgot', 'reset'];

// `trial` («افتح حساباً تجريبياً») يظهر حين يفعّله الخادم (settings.portalTrialEnabled)؛
// `#trial` والتبويب مطفأ يعود للرئيسية في AffiliateApp لا هنا — فالذهاب والإياب يبقيان نقيّين.
// `missed` = «مطالبة بإحالة فائتة» (جديد v2) — غير «رشّح شركة» (`claims`، الترشيح المسبق).
export type Tab =
  | 'home' | 'companies' | 'earnings'
  | 'link' | 'claims' | 'trial' | 'missed' | 'pricing' | 'materials' | 'faq' | 'support' | 'profile' | 'terms';
export const TAB_IDS: readonly Tab[] = [
  'home', 'companies', 'earnings',
  'link', 'claims', 'trial', 'missed', 'pricing', 'materials', 'faq', 'support', 'profile', 'terms',
];

/** الشريط السفليّ على الجوال — ثلاثة تبويبات ثم «المزيد» */
export const BOTTOM_TABS: readonly Tab[] = ['home', 'companies', 'earnings'];
/** ورقة «المزيد» بترتيب المواصفة (V2_SPEC §7) — والخروج آخرها في الواجهة */
export const MORE_TABS: readonly Tab[] = ['link', 'claims', 'trial', 'missed', 'pricing', 'materials', 'faq', 'support', 'profile', 'terms'];

/** التبويبات الظاهرة — «افتح حساباً تجريبياً» يغيب حين يطفئه الخادم */
export function visibleTabs(tabs: readonly Tab[], trialOn: boolean): Tab[] {
  return tabs.filter((t) => trialOn || t !== 'trial');
}

/** هل التبويب داخل «المزيد»؟ (فيُبرَز زرّ «المزيد» في الشريط السفليّ) */
export function isMoreTab(tab: Tab): boolean {
  return !BOTTOM_TABS.includes(tab);
}

export const VIEW_PARAM = 'view';

export type LinkToken = { kind: 'reset'; token: string };

function params(search: string): URLSearchParams {
  try { return new URLSearchParams(search || ''); } catch { return new URLSearchParams(); }
}

/** رمز رابط الاستعادة في سلسلة الاستعلام أو null (رابط التأكيد القديم ليس رمزاً بعد v2) */
export function linkTokenFromSearch(search: string): LinkToken | null {
  const r = params(search).get('reset');
  return r ? { kind: 'reset', token: r } : null;
}

/**
 * رابط بريدٍ من v1 لم يعد له شاشة: `?verify=TOKEN` (تأكيد البريد) أو `?view=verify|resend`.
 * AffiliateApp يستبدله بـ`/ax` نظيفاً — الدخول، أو البوابة لمن له جلسة.
 */
export function isLegacyAuthLink(search: string): boolean {
  const p = params(search);
  if (p.get('reset')) return false;
  if (p.has('verify')) return true;
  const v = p.get(VIEW_PARAM);
  return v === 'verify' || v === 'resend';
}

/** الشاشة من العنوان: رمز الاستعادة أولاً، ثم `?view=`، وإلا الدخول */
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
  const same = !linkTokenFromSearch(search) && !isLegacyAuthLink(search)
    && viewFromSearch(search) === next && clean(hash) === '';
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
 * هل تُعرض شاشة رابط الاستعادة؟ تحتاج رمزاً في الذاكرة، ومع **جلسةٍ قائمة** لا تُعرض إلا
 * لرابطٍ فُتح للتوّ (`freshLink`) — العودة إليها من سجلّ المتصفّح تذهب للبوابة.
 */
export function showLinkScreen(
  kind: 'reset',
  st: { view: AuthView; token: string | undefined; hasToken: boolean; freshLink: 'reset' | null },
): boolean {
  if (st.view !== kind || !st.token) return false;
  return !st.hasToken || st.freshLink === kind;
}
