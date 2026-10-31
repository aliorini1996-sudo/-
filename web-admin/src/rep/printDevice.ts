/**
 * إعداد الطباعة على هذا الجهاز («إعدادات الطباعة» M2، التصميم §2) — على نمط repTeam.ts.
 *
 * الطابعة صفةُ السيارة أو الجوال لا المندوب ولا الشركة: شاحنات MIP480 ورول 80 مم جنباً إلى جنب في شركة واحدة. فالشركة
 * تضع قالب كل مستند (routing)، وكل جهاز يحفظ اختياره عنده — مفتاحٌ لكل شركة ومستخدم في localStorage، يعمل أوف-لاين
 * (القوالب تصل مع /company المخبّأ) ولا يحتاج عموداً في الخادم. ولا يُحترم الاختيار إلا بإذن الشركة (repMayChoose) وبقاء
 * القالب وصلاحه لنوع المستند (profileFor في lib/print/printSettings.ts) — وإلا فاختيار الشركة.
 *
 * والطريقة (transport) محفوظةٌ هنا أيضاً (M3): «بلوتوث مباشر» تختاره الشاشة من «تغيير»، وإذن المنفذ نفسه عند Chrome لا هنا
 * (Web Serial يحفظه لكل أصلٍ وجهاز) — rep/printDirect.ts: transportFor.
 */
import { useEffect, useState } from 'react';
import { tokenTenantId } from './jwt';
import { DEVICE_ROLL_WIDTHS, DOC_KINDS, PROFILE_ID_RE, type DeviceRollMm, type DevicePrintChoice, type PrintDocKind } from '../lib/print/printSettings';

export interface PrintIdentity { tenantId: string; userId: string }

const EVENT = 'fs-print-device-change';
export const printDeviceKey = (id: PrintIdentity): string => `fs_print:${id.tenantId}:${id.userId}`;

/**
 * هوية الجهاز في المساحة الحالية — المندوب (/rep: rep_token/rep_user)، وتطبيق الإدارة (/m: m_token/m_user)، والمالك
 * (sa_*)، وموظف المنصة (/staff: st_*)، واللوحة (token/user). مرآة sessionSpace في store/authStore.ts بلا استيراد المتجر (له آثارٌ عند التحميل)،
 * والقراءة ممرَّرة فتُختبر وحدها. الغائب «local»: اختيارٌ يبقى للجهاز ولو لم تُعرف الهوية.
 */
export function printIdentityFrom(pathname: string, read: (key: string) => string | null): PrintIdentity {
  const [tokenKey, userKey] = pathname === '/rep' || pathname.startsWith('/rep/') ? ['rep_token', 'rep_user']
    : pathname === '/m' || pathname.startsWith('/m/') ? ['m_token', 'm_user']
    : pathname.startsWith('/platform') || pathname.startsWith('/owner') ? ['sa_token', 'sa_user']
    : pathname === '/staff' || pathname.startsWith('/staff/') ? ['st_token', 'st_user']
    : ['token', 'user'];
  let user: { id?: unknown; tenantId?: unknown } | null = null;
  try { user = JSON.parse(read(userKey) || 'null'); } catch { user = null; }
  const tenant = tokenTenantId(read(tokenKey)) ?? (typeof user?.tenantId === 'string' && user.tenantId ? user.tenantId : null);
  const userId = typeof user?.id === 'string' && user.id ? user.id : null;
  return { tenantId: tenant ?? 'local', userId: userId ?? 'local' };
}

export function currentPrintIdentity(): PrintIdentity {
  const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
  return printIdentityFrom(typeof window === 'undefined' ? '/' : window.location.pathname, read);
}

/** المحفوظ كما يُقرأ — صفوفٌ لا يعرفها هذا الإصدار تُسقط، والتالف لا شيء (لا يرمي) */
export function parseDeviceChoice(raw: string | null): DevicePrintChoice | null {
  let v: unknown;
  try { v = JSON.parse(raw || 'null'); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: DevicePrintChoice = {};
  if (o.byKind && typeof o.byKind === 'object' && !Array.isArray(o.byKind)) {
    const byKind: Partial<Record<PrintDocKind, string>> = {};
    for (const k of DOC_KINDS) {
      const id = (o.byKind as Record<string, unknown>)[k];
      if (typeof id === 'string' && PROFILE_ID_RE.test(id)) byKind[k] = id;
    }
    if (Object.keys(byKind).length) out.byKind = byKind;
  }
  if (o.transport === 'bt-serial' || o.transport === 'system') out.transport = o.transport;
  const hint = (o.portHint as { name?: unknown } | undefined)?.name;
  if (typeof hint === 'string' && hint.length <= 80) out.portHint = { name: hint };
  if (o.slow === true) out.slow = true;
  if ((DEVICE_ROLL_WIDTHS as readonly unknown[]).includes(o.rollMm)) out.rollMm = o.rollMm as DeviceRollMm;
  if (o.rollVia === 'bt-serial') out.rollVia = 'bt-serial';
  if (o.lang === 'tspl') out.lang = 'tspl';
  if (o.tsplFlip === true) out.tsplFlip = true;
  return Object.keys(out).length ? out : null;
}

/**
 * طريقة الاتصال ورابطٌ بطيء (M3) — «نظام الطباعة» هو الافتراضي فلا يُحفظ صراحةً؛ والنتيجة الفارغة null (كما withKindChoice).
 */
export function withConnection(
  choice: DevicePrintChoice | null,
  patch: { transport?: 'bt-serial' | 'system'; slow?: boolean; rollMm?: DeviceRollMm; lang?: 'escpos' | 'tspl'; tsplFlip?: boolean },
): DevicePrintChoice | null {
  const next: DevicePrintChoice = { ...(choice ?? {}) };
  if (patch.transport !== undefined) {
    if (patch.transport === 'bt-serial') next.transport = 'bt-serial';
    else delete next.transport;
  }
  if (patch.slow !== undefined) {
    if (patch.slow) next.slow = true;
    else delete next.slow;
  }
  // عرض رول الجهاز (deviceRollProfile): 58 الافتراضي فلا يُحفظ صراحةً
  if (patch.rollMm !== undefined) {
    if (patch.rollMm !== 58) next.rollMm = patch.rollMm;
    else delete next.rollMm;
  }
  // لغة الطابعة: ESC/POS الافتراضي فلا يُحفظ؛ والعودة إليه تُسقط قلب اتجاه TSPL معه
  if (patch.lang !== undefined) {
    if (patch.lang === 'tspl') next.lang = 'tspl';
    else { delete next.lang; delete next.tsplFlip; }
  }
  if (patch.tsplFlip !== undefined) {
    if (patch.tsplFlip) next.tsplFlip = true;
    else delete next.tsplFlip;
  }
  return Object.keys(next).length ? next : null;
}

/**
 * اختيار الجهاز كما تراه أدوات قالب الجهاز (deviceRoll): طريقتها rollVia لا transport قوالب الشركة — PrintDeviceTools تقرأ وتكتب
 * transport فتُعرض لها هذه الصورة، وما تكتبه يعود بـfromRollView: transport الأصلي كما هو، والجديد في rollVia.
 */
export function rollViewOf(choice: DevicePrintChoice | null): DevicePrintChoice | null {
  const v: DevicePrintChoice = { ...(choice ?? {}) };
  delete v.transport;
  if (choice?.rollVia === 'bt-serial') v.transport = 'bt-serial';
  return Object.keys(v).length ? v : null;
}

export function fromRollView(original: DevicePrintChoice | null, next: DevicePrintChoice | null): DevicePrintChoice | null {
  const out: DevicePrintChoice = { ...(next ?? {}) };
  delete out.transport;
  delete out.rollVia;
  if (original?.transport) out.transport = original.transport;
  if (next?.transport === 'bt-serial') out.rollVia = 'bt-serial';
  return Object.keys(out).length ? out : null;
}

/** خيارات الإرسال المباشر من اختيار الجهاز (useDirectPrint().run): الرابط البطيء ولغة الطابعة واتجاه TSPL */
export function directOpts(choice: DevicePrintChoice | null | undefined): { slow?: boolean; lang?: 'tspl'; tsplFlip?: boolean } {
  return { slow: choice?.slow, lang: choice?.lang, tsplFlip: choice?.tsplFlip };
}

/** اختيار قالبٍ لنوع مستند — null يعيده لاختيار الشركة؛ والنتيجة الفارغة null */
export function withKindChoice(choice: DevicePrintChoice | null, kind: PrintDocKind, profileId: string | null): DevicePrintChoice | null {
  const byKind: Partial<Record<PrintDocKind, string>> = { ...(choice?.byKind ?? {}) };
  if (profileId === null) delete byKind[kind];
  else byKind[kind] = profileId;
  const next: DevicePrintChoice = { ...(choice ?? {}) };
  if (Object.keys(byKind).length) next.byKind = byKind;
  else delete next.byKind;
  return Object.keys(next).length ? next : null;
}

export function readDeviceChoice(id: PrintIdentity): DevicePrintChoice | null {
  try { return parseDeviceChoice(localStorage.getItem(printDeviceKey(id))); } catch { return null; }
}

export function writeDeviceChoice(id: PrintIdentity, choice: DevicePrintChoice | null): void {
  try {
    if (choice) localStorage.setItem(printDeviceKey(id), JSON.stringify(choice));
    else localStorage.removeItem(printDeviceKey(id));
  } catch { /* تخزينٌ محجوب: يبقى للجلسة */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key: printDeviceKey(id), choice } }));
}

/** اختيار هذا الجهاز — يتبع التغيير من أي شاشة مفتوحة */
export function usePrintDeviceChoice(id: PrintIdentity): [DevicePrintChoice | null, (c: DevicePrintChoice | null) => void] {
  const key = printDeviceKey(id);
  const [choice, setChoice] = useState<DevicePrintChoice | null>(() => readDeviceChoice(id));
  useEffect(() => {
    setChoice(readDeviceChoice(id));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; choice: DevicePrintChoice | null }>).detail;
      if (d?.key === key) setChoice(d.choice);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [key]); // المفتاح يحمل الهوية كلّها
  return [choice, (c) => writeDeviceChoice(id, c)];
}
