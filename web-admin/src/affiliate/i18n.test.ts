import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
  AX_DICT, AX_LANGS, AX_LOCALE, dirOf, interpolate, makeAxI18n, msg, splitTemplate, translate, type AxKey,
} from './i18n';

/**
 * حرّاس قاموس البوابة: كل مفتاح بخمس لغات غير فارغة، والفرنسية بلا فاصلة عليا لاتينية،
 * والمتغيّرات نفسها في كل لغة — وملفات الواجهة لا تحمل نصاً عربياً معروضاً خارج القاموس.
 */
const ARABIC = /[؀-ۿ]/;
const keys = Object.keys(AX_DICT) as AxKey[];
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('كل مفتاح له اللغات الخمس غير فارغة', () => {
  assert.deepEqual([...AX_LANGS], ['ar', 'en', 'fr', 'tr', 'zh']);
  assert.ok(keys.length > 200, `عدد المفاتيح ${keys.length} أقلّ من المتوقّع`);
  for (const k of keys) {
    for (const l of AX_LANGS) {
      const v = AX_DICT[k][l];
      assert.equal(typeof v, 'string', `${k}.${l} ليس نصاً`);
      assert.ok(v.trim().length > 0, `${k}.${l} فارغ`);
    }
    assert.deepEqual(Object.keys(AX_DICT[k]).sort(), [...AX_LANGS].sort(), `${k}: لغات زائدة أو ناقصة`);
  }
});

test('الفرنسية بلا فاصلة عليا لاتينية (قاعدة المستودع) — تُستعمل ’', () => {
  const offenders = keys.filter((k) => AX_DICT[k].fr.includes("'"));
  assert.deepEqual(offenders, [], `فواصل عليا لاتينية في: ${offenders.join(', ')}`);
});

test('العربية عربية، وغيرها بلا نصٍّ عربي متسرّب', () => {
  for (const k of keys) {
    assert.match(AX_DICT[k].ar, ARABIC, `${k}.ar ليست عربية`);
    for (const l of AX_LANGS.filter((x) => x !== 'ar')) {
      assert.doesNotMatch(AX_DICT[k][l], ARABIC, `${k}.${l} فيه نصٌّ عربي`);
    }
  }
});

test('المتغيّرات نفسها في كل لغة — لا {min} ينقص من ترجمة', () => {
  for (const k of keys) {
    const want = vars(AX_DICT[k].ar);
    for (const l of AX_LANGS) assert.deepEqual(vars(AX_DICT[k][l]), want, `${k}.${l}: متغيّرات مختلفة`);
  }
});

test('الترجمة والتعويض', () => {
  assert.equal(translate('ar', 'app.title'), 'سفير فيلد سيلز');
  assert.equal(translate('en', 'app.title'), 'Field Sales Ambassador');
  assert.equal(translate('fr', 'home.hello', { name: 'Sara' }), 'Bonjour Sara');
  assert.equal(translate('zh', 'home.hello', { name: 'Sara' }), 'Sara，您好');
  assert.equal(interpolate('{a} و{b}', { a: 1 }), '1 و{b}', 'متغيّرٌ غائب يبقى ظاهراً');
  assert.deepEqual(splitTemplate('عمولتك {rate} بعد {days} يوماً'), ['عمولتك ', { name: 'rate' }, ' بعد ', { name: 'days' }, ' يوماً']);
  assert.deepEqual(splitTemplate('{x}'), [{ name: 'x' }]);
  assert.deepEqual(msg('val.vat'), { key: 'val.vat' });
  assert.deepEqual(msg('val.cityTooLong', { max: 60 }), { key: 'val.cityTooLong', vars: { max: 60 } });

  const en = makeAxI18n('en');
  assert.equal(en.dir, 'ltr');
  assert.equal(en.m({ key: 'val.cityTooLong', vars: { max: 60 } }), 'City name can be at most 60 characters');
  assert.equal(makeAxI18n('ar').dir, 'rtl');
  for (const l of AX_LANGS) assert.equal(dirOf(l), l === 'ar' ? 'rtl' : 'ltr');
  const parts = en.rich('home.intro', { rate: '30%', days: '10 days' }) as unknown[];
  assert.ok(Array.isArray(parts) && parts.length >= 3, 'rich يُعيد أجزاءً');
});

test('locale التنسيق بأرقام لاتينية وتقويم ميلادي للعربية', () => {
  assert.match(AX_LOCALE.ar, /nu-latn/);
  assert.match(AX_LOCALE.ar, /ca-gregory/);
  for (const l of AX_LANGS) assert.ok(AX_LOCALE[l], l);
});

test('العربية المعروضة حرفياً كما كانت قبل التعريب', () => {
  const same: Array<[AxKey, string]> = [
    ['login.title', 'دخول السفراء'],
    ['link.disclosureTitle', 'نصّ الإفصاح — أرفقه دائماً مع الرابط'],
    ['earn.paymentAmount', 'مبلغ الدفعة (شاملة الضريبة)'],
    ['err.network', 'تعذّر الاتصال بالخادم — تحقق من الإنترنت'],
    ['accepted.forgot', 'إن كان البريد مسجّلاً فستصلك رسالة لاستعادة كلمة المرور'],
    // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦): «التسويات» صارت دفعات الصرف الدورية، والتعديلات «تعديلات»
    ['home.adjustments', 'تعديلات تُحتسب في تسويتك القادمة'],
    ['settle.title', 'التسويات'],
    ['earn.adjustments', 'التعديلات'],
    ['st.payout.draft', 'قيد المعالجة'],
    ['st.payout.recorded', 'مدفوعة'],
    ['st.payout.failed', 'فشل التحويل'],
    ['home.completeTitle', 'أكمل ملفك لاستلام أرباحك'],
    ['tab.missed', 'مطالبة بإحالة فائتة'],
  ];
  for (const [k, ar] of same) assert.equal(AX_DICT[k].ar, ar, k);
  // v2: الانضمام فوريّ — لا «كل طلب يُراجع قبل القبول» ولا «أكّد بريدك» ولا «بعد أول عمولة»
  assert.equal(
    translate('ar', 'reg.subtitle', { rate: '30%', days: '10 أيام', every: '10 أيام', min: '50.00 ر.س' }),
    'عمولتك 30% من أول دفعة مؤكَّدة (شاملة الضريبة) لكل منشأة تشترك عبرك. تُحجز العمولة 10 أيام من الدفع ثم تُعتمد تلقائياً، وتُسوّى كل 10 أيام متى بلغ رصيدك 50.00 ر.س.',
  );
  for (const k of ['accepted.register', 'reg.doneHint', 'status.review.body', 'status.pendingEmail.body', 'payout.unlockAfter', 'login.noVerifyMail']) {
    assert.ok(!(k in AX_DICT), `${k}: نصٌّ لمسار v1 حُذف (مراجعة/تأكيد بريد/قفل الآيبان)`);
  }
  for (const k of Object.keys(AX_DICT) as AxKey[]) {
    assert.doesNotMatch(AX_DICT[k].ar, /يُراجع قبل القبول|بانتظار المراجعة|أكّد بريدك|بعد اعتماد أول عمولة/, `${k}: وعدٌ من v1`);
  }
});

test('الأيام بصيغتها: القوالب تأخذ العبارة كاملة من daysLabel لا رقماً يتبعه «يوماً»', () => {
  // «10 يوماً» خطأٌ نحويّ — الحجز صار 10 أيام (V2_SPEC §0)
  for (const k of ['reg.subtitle', 'home.intro', 'terms.hold', 'earn.info1', 'faq.a.hold'] as AxKey[]) {
    assert.doesNotMatch(AX_DICT[k].ar, /\{days\} يوماً/, k);
  }
  assert.doesNotMatch(AX_DICT['terms.min'].ar, /\{every\} يوماً/);
});

/** يحذف التعليقات (// و/* *\/ و{/* *\/}) مع إبقاء الروابط `https://` داخل النصوص */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

test('لا نصّ عربي معروض في ملفات البوابة خارج القاموس', () => {
  const root = new URL('./', import.meta.url);
  const files: Array<{ rel: string; url: URL }> = [];
  const walk = (u: URL, rel: string) => {
    for (const name of readdirSync(u)) {
      const child = new URL(name, u);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, u), `${rel}${name}/`);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && name !== 'i18n.ts') files.push({ rel: `${rel}${name}`, url: child });
    }
  };
  walk(root, '');
  assert.ok(files.length >= 15, 'ملفات البوابة غير موجودة');

  // استثناءات مقصودة وليست نصوصاً مترجَمة:
  const allowed: Record<string, RegExp[]> = {
    // كلمتا استبدالٍ داخليتان في كاشف الاتصال (مرآة حرفية للخادم) وجداول الأرقام العربية-الهندية
    'validation.ts': [/' تاريخ '/g, /' وقت '/g, /\[٠-٩\]/g, /\[۰-۹\]/g, /'٠١٢٣٤٥٦٧٨٩'/g, /'۰۱۲۳۴۵۶۷۸۹'/g],
    // تمييز العدد العربي (يومان · أيام · يوماً) قاعدة نحوية لا تصلح قالباً واحداً
    'format.ts': [/'يومان'/g, /أيام`/g, /يوماً`/g],
  };
  const offenders: string[] = [];
  for (const f of files) {
    let src = stripComments(readFileSync(f.url, 'utf8'));
    for (const re of allowed[f.rel] ?? []) src = src.replace(re, '');
    const lines = src.split('\n').filter((l) => ARABIC.test(l));
    if (lines.length) offenders.push(`${f.rel}: ${lines.map((l) => l.trim()).slice(0, 3).join(' ‖ ')}`);
  }
  assert.deepEqual(offenders, [], `نصوص عربية خارج القاموس:\n${offenders.join('\n')}`);
});

test('مبدّل اللغة أعلى كل شاشة — غلاف الدخول ورأس البوابة', () => {
  const ui = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8');
  const shell = ui.match(/export function AuthShell[\s\S]*?\n\}\n/);
  assert.ok(shell, 'AuthShell غير موجود');
  assert.match(shell![0], /<AxLanguageToggle \/>/, 'غلاف شاشات الدخول بلا مبدّل لغة');
  assert.match(shell![0], /dir=\{dir\}/, 'الغلاف لا يتبع اتجاه اللغة');
  assert.match(ui, /import LanguageToggle from '\.\.\/components\/LanguageToggle'/);
  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /<header[\s\S]*<AxLanguageToggle \/>[\s\S]*<\/header>/, 'رأس البوابة بلا مبدّل لغة');
  assert.match(app, /dir=\{dir\} lang=\{lang\}/);
});

test('رأس البوابة واتجاه التنبيهات والتنقّل الجوّال (شريط سفليّ + «المزيد» + شريط جانبيّ)', () => {
  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  const header = app.match(/<header[^>]*>/);
  assert.ok(header, 'رأس البوابة غير موجود');
  // backdrop-filter يحبس خلفية إغلاق قائمة اللغة (fixed inset-0) داخل الرأس
  assert.doesNotMatch(header![0], /backdrop-blur|backdrop-filter|\/95/, 'الرأس بخلفية ضبابية تحبس قائمة اللغة');
  assert.match(header![0], /bg-\[#FAF7F0\]/);
  // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — V2_SPEC §7): شريط التبويبات الأفقيّ (وتوسيطه بعد تبديل اللغة)
  // حلّ محلّه شريطٌ سفليّ ثابت و«المزيد» على الجوال وشريطٌ جانبيّ على الحاسوب — الحرّاس البديلة:
  assert.doesNotMatch(app, /overflow-x-auto/, 'شريط التبويبات الأفقيّ ما زال');
  assert.match(app, /<Sidebar tabs=\{visibleTabs\(TAB_IDS, trialOn\)\}/);
  assert.match(app, /<BottomBar active=\{shown\}/);
  assert.match(app, /<MoreSheet[\s\S]*?tabs=\{visibleTabs\(MORE_TABS, trialOn\)\}/);
  assert.match(app, /useEffect\(\(\) => \{ setMoreOpen\(false\); \}, \[location\.hash, location\.search\]\);/, '«المزيد» لا تُغلق مع التنقّل (رجوع أندرويد)');
  assert.match(app, /pb-36 lg:pb-14/, 'المحتوى بلا مساحةٍ للشريط السفليّ الثابت');
  assert.match(app, /<SupportFab code=\{data\.user\.code\} \/>/, 'زرّ واتساب الدعم العائم غير مركّب');
  const shell = readFileSync(new URL('./shell.tsx', import.meta.url), 'utf8');
  assert.match(shell, /const pick = \(id: Tab\) => \{ onSelect\(id\); onClose\(\); \};/, '«المزيد» لا تُغلق بعد الاختيار');
  assert.match(shell, /lg:hidden fixed bottom-0 inset-x-0/, 'الشريط السفليّ ليس للجوال وحده');
  assert.match(shell, /hidden lg:block w-60/, 'الشريط الجانبيّ ليس للحاسوب وحده');
  assert.match(shell, /env\(safe-area-inset-bottom\)/, 'الشريط السفليّ يتجاهل حافة الآيفون');
  assert.match(shell, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.match(shell, /role="dialog" aria-modal="true"/);
  assert.match(shell, /supportWhatsappUrl\(t\('support\.waMessage', \{ code \}\)\)/);
  const fmt = readFileSync(new URL('./format.ts', import.meta.url), 'utf8');
  assert.match(fmt, /export const SUPPORT_WHATSAPP = '966506061608';/, 'رقم واتساب الدعم الرسمي (V2_SPEC §7)');
  // 320px: العلامة تنكمش وتُقصّ، والأزرار لا تنكمش
  assert.match(app, /<div className="min-w-0 flex-1"><BrandLockup compact \/><\/div>/);
  assert.match(app, /flex items-center gap-1\.5 sm:gap-2 shrink-0/);
  const ui = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8');
  const lockup = ui.match(/export function BrandLockup[\s\S]*?\n\}\n/);
  assert.ok(lockup);
  assert.match(lockup![0], /min-w-0/);
  assert.match(lockup![0], /truncate`\}>\{t\('app\.title'\)\}/);

  // التنبيهات بعامّة التطبيق تتبع اتجاه اللغة لا RTL ثابتاً
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /direction: 'rtl'/, 'Toaster ما زال RTL ثابتاً');
  assert.match(main, /const dir = useDir\(\);/);
  assert.match(main, /direction: dir/);
  assert.match(main, /<AppToaster \/>/);
});

test('مصطلحات المراجِع: «ترشيح» غير «إحالة»، و«موقوفة» غير «فترة الحجز»', () => {
  // الإنجليزية: الترشيح nomination والإحالة referral (رابط/رمز)
  for (const k of ['tab.claims', 'claims.formTitle', 'claims.mine', 'claims.submit', 'claims.received', 'src.claim'] as AxKey[]) {
    assert.match(AX_DICT[k].en, /[Nn]ominat/, `${k}.en`);
    assert.doesNotMatch(AX_DICT[k].en, /[Rr]eferr?al/, `${k}.en ما زال referral`);
  }
  for (const k of ['link.title', 'link.code', 'profile.code'] as AxKey[]) assert.match(AX_DICT[k].en, /[Rr]eferral/, `${k}.en`);
  // حالة العمولة «موقوفة» لا تشارك كلمة «hold» مع فترة الحجز العادية
  assert.doesNotMatch(AX_DICT['st.commission.on_hold'].en, /hold/i);
  assert.match(AX_DICT['terms.hold'].en, /Holding period/);
  // التركية: «Referans» للرابط والرمز، ومطابقةٌ لخانة التسجيل
  const strings = readFileSync(new URL('../i18n/strings.ts', import.meta.url), 'utf8');
  assert.match(strings, /'signup\.refLabel': \{[^}]*tr: 'Referans kodu'/, 'خانة التسجيل التركية لا تطابق «Referans kodu»');
  assert.match(AX_DICT['link.codeHint'].tr, /“Referans kodu”/);
  // v2: «مطالبة بإحالة فائتة / Missed referral claim» للجديد — لا تختلط بالترشيح المسبق
  for (const k of ['tab.missed', 'missed.mine', 'missed.received'] as AxKey[]) {
    assert.match(AX_DICT[k].en, /[Mm]issed referral claim/, `${k}.en`);
    assert.doesNotMatch(AX_DICT[k].en, /[Nn]ominat/, `${k}.en يخلط بالترشيح`);
  }
  assert.equal(AX_DICT['tab.missed'].ar, 'مطالبة بإحالة فائتة');
  assert.doesNotMatch(AX_DICT['tab.missed'].ar, /ترشيح|رشّح/);
  assert.match(AX_DICT['method.nomination'].en, /Nomination/);
});
