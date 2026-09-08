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
