import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * تبويبات تطبيق الإدارة على الجوال — حرّاس على تبديل «التحصيل» بـ«التقارير».
 *
 * ما تحرسه: عَلَمان متعاكسا الافتراض في الملف نفسه. «النظام المحاسبي» مفعّل
 * افتراضياً فيصحّ فيه `!== false`، و«التقرير اليومي» مطفأ افتراضياً فيلزمه
 * `=== true`. ونسخُ نمط الأول على الثاني — وهو أسهل الأخطاء هنا — يُظهر
 * تبويباً لكل شركة تعذّرت قراءة إعداداتها، ويُخفي عنها التحصيل في اللحظة نفسها.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('العَلَم يُقرأ بـ=== true — لا !== false', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  assert.match(s, /dailyReportEnabled\?: boolean \} \| null\)\?\.dailyReportEnabled === true/,
    'عَلَم مطفأ افتراضياً يجب أن يُقرأ بـ=== true');
  assert.doesNotMatch(s, /dailyReportEnabled !== false/,
    '`!== false` يفتح التبويب لكل شركة تعذّرت قراءة إعداداتها');
});

test('التقارير تحلّ محلّ التحصيل ولا تُضاف إليه', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  // التحصيل يسقط حين تُفعّل الميزة
  assert.match(s, /t\.id === 'receipts' && dailyReportOn\) return false/,
    'التحصيل يجب أن يسقط عند تفعيل التقرير اليومي');
  // والتقارير لا تظهر حين تُطفأ
  assert.match(s, /t\.id === 'dailyReports'\) return dailyReportOn/,
    'تبويب التقارير يجب أن يتبع العَلَم');
});

test('التبويبات لا تتجاوز خمسة في أي حالة', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  const block = s.slice(s.indexOf('const TABS'), s.indexOf('/** حدث تثبيت PWA'));
  const count = (block.match(/\{ id: '/g) || []).length;
  // ستّة معرَّفة، وواحدٌ منها بديلٌ لا إضافة — فالمعروض خمسة كحدّ أقصى
  assert.equal(count, 6, 'عدد التبويبات المعرَّفة تغيّر — راجع أن المعروض يبقى خمسة');
});

test('التبويب خلف صلاحية التقارير', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  assert.match(s, /id: 'dailyReports'[^}]*perm: 'canViewReports'/, 'التبويب بلا صلاحية');
  const perms = read('src', 'm', 'perms.ts');
  assert.match(perms, /'canViewReports'/, 'المفتاح مفقود من PermKey');
});

test('الشاشة موصولة والتسمية مترجَمة', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  assert.match(s, /screen === 'dailyReports'\) return <MDailyReports \/>/, 'الشاشة غير موصولة');
  assert.match(s, /m\.tabDailyReports' \? 'التقارير'/, 'تسمية التبويب مفقودة');
  const st = read('src', 'i18n', 'strings.ts');
  for (const k of ['التقارير اليومية', 'ما ينتظر اعتمادك أنت', 'سبب الإعادة']) {
    assert.ok(st.includes(`'${k}':`), `نصّ غير مترجَم: ${k}`);
  }
});

test('الاعتماد والإعادة موصولان، والإعادة تشترط سبباً في الشاشة', () => {
  const s = read('src', 'm', 'MDailyReports.tsx');
  assert.match(s, /dailyReportApi\.approve\(id\)/, 'الاعتماد غير موصول');
  assert.match(s, /dailyReportApi\.sendBack\(id, reason\)/, 'الإعادة غير موصولة');
  assert.match(s, /disabled=\{!reason\.trim\(\)/, 'الإعادة يجب أن تشترط سبباً قبل الإرسال');
});

/* ═══ الشاشة بلا مقعد: سندات القبض حين تُفعَّل التقارير اليومية ═══
 *
 * التبديل أعلاه يُسقط تبويب «التحصيل»، فتصير شاشة السندات بلا طريقٍ في التطبيق
 * كلّه. وزرُّ التحويل في أعلى شاشة الفواتير هو طريقها — وله ثلاثة مواضع تُفسده
 * بصمت، وهذه حرّاسها. */

test('زرّ التحويل خلف الشروط الثلاثة نفسها التي يحرسها الخادم', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  const i = s.indexOf('const receiptsSeatless');
  assert.ok(i > 0, 'حساب «بلا مقعد» مفقود — لا طريق لشاشة السندات');
  const decl = s.slice(i, s.indexOf(';', i));
  assert.match(decl, /!tabs\.some\(t => t\.id === 'receipts'\)/, 'الزرّ يجب أن يظهر حين لا مقعد لها فقط');
  assert.match(decl, /accountingOn/, 'زرٌّ يُفضي إلى شاشة أرقامٍ محجوبة حين يُطفأ النظام المحاسبي');
  assert.match(decl, /can\(user, 'canManageReceipts'\)/, 'زرٌّ يُفضي إلى ٤٠٣ لمن لا صلاحية له');
});

test('الشاشة بلا مقعد لا تُرتدّ عنها — وإلا كان الزرّ ومضةً لا طريقاً', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  /* أثر النسيان هنا صامتٌ وكامل: أثرُ الضغط يضبط الشاشة، ثمّ يعيدها هذا
   * التأثير فوراً إلى أوّل تبويب — زرٌّ «لا يفعل شيئاً» بلا رسالة ولا خطأ. */
  const i = s.indexOf('if (!tabs.length) return;');
  assert.ok(i > 0, 'تأثير إعادة الضبط تغيّر شكله — راجع هذا الحارس');
  const body = s.slice(i, s.indexOf('}, [tabs', i));
  assert.match(body, /screen === 'receipts' && receiptsSeatless\) return/,
    'الشاشة بلا مقعد يجب أن تُستثنى من إعادة الضبط');
});

test('الزرّ يُمرَّر للقائمتين معاً — الذهاب والعودة', () => {
  const s = read('src', 'm', 'MobileApp.tsx');
  assert.match(s, /kind="invoice"[^/]*onSwitchKind=\{onSwitchDoc\}/, 'شاشة الفواتير بلا زرّ تحويل');
  assert.match(s, /kind="receipt"[^/]*onSwitchKind=\{onSwitchDoc\}/, 'شاشة السندات بلا طريق رجوع');
  // ويُعطى `undefined` حين يكون للسندات مقعدها — فلا مدخلان لشاشة واحدة
  assert.match(s, /onSwitchDoc=\{receiptsSeatless \?/, 'الزرّ يجب أن يسقط حين يكون للسندات تبويبها');
});

test('الشريط السفليّ يُضيء مقعد من فتح الشاشة', () => {
  // أمّا الرجوع فيحرسه اختبار الطبقات أدناه — طبقةٌ مستقلّة لا وجهةٌ مشروطة
  const s = read('src', 'm', 'MobileApp.tsx');
  assert.match(s, /screen === 'receipts' && receiptsSeatless && t\.id === 'invoices'/,
    'شريطٌ بلا مقعدٍ مُضاء يقول للمستخدم إنّه خارج التطبيق');
});

test('زرّ التحويل يعِد بوجهته لا بموضعه', () => {
  const s = read('src', 'm', 'MDocList.tsx');
  const i = s.indexOf('{onSwitchKind && (');
  assert.ok(i > 0, 'الزرّ مفقود من شاشة المستندات');
  const btn = s.slice(i, s.indexOf('</button>', i));
  // أيقونة الوجهة ونصّها، لا أيقونة الشاشة الحاليّة
  assert.match(btn, /kind === 'invoice' \? <CreditCard/, 'أيقونة الزرّ يجب أن تكون أيقونة الوجهة');
  assert.match(btn, /aria-label=/, 'زرٌّ بلا اسمٍ مقروء');
  assert.match(btn, /tr\('التحصيل'\)/, 'نصّ الوجهة مفقود — الأيقونة وحدها لا تُقرأ');
});

test('كل إغلاقٍ يُطفئ شرط طبقته — وإلّا خرج التطبيق عند الضغطة التالية', () => {
  /* `useBackClose` يسحب الطبقة من المكدّس **قبل** `close`، ولا يعيد تسجيلها
   * إلّا حين يتحوّل `open` (تبعيّته الوحيدة، ويحرسها اختبار الخطّاف نفسه).
   * فالطبقة التي تُغلق إلى حالةٍ يبقى شرطها فيها صادقاً تزول من المكدّس بلا
   * عودة، والضغطة التالية تخرج من التطبيق: لا رسالة ولا أثر. */
  const s = read('src', 'm', 'MobileApp.tsx');
  // الجذر يُغلق إلى أوّل تبويب وحده — لا وجهة ثانية مشروطة فيه
  assert.match(s, /useBackClose\(\s*[^;]*screen !== tabs\[0\]\.id,\s*\(\) => setScreen\(tabs\[0\]\.id\),/,
    'الطبقة الجذر يجب أن تُغلق إلى أوّل تبويب حرفياً');
  assert.doesNotMatch(s, /\(\) => setScreen\(screen === 'receipts'/,
    'إغلاقٌ بوجهتين في طبقةٍ واحدة يقتل الطبقة — اجعلها طبقتين');
  // والشاشة بلا مقعد طبقةٌ مستقلّة، والجذر يستثنيها فلا تتداخلان
  assert.match(s, /useBackClose\(onSeatlessDoc, \(\) => setScreen\('invoices'\)\)/,
    'الشاشة بلا مقعد بلا طبقة رجوعٍ خاصّة بها');
  assert.match(s, /!onSeatlessDoc && screen !== tabs\[0\]\.id/,
    'الجذر يجب أن يستثني الشاشة بلا مقعد وإلّا سُجّلت طبقتان لضغطةٍ واحدة');
});
