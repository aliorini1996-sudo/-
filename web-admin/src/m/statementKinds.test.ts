import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * كشف حساب العميل في تطبيق الإدارة — حارسٌ على تغطية أنواع القيود.
 *
 * الصنف نفسه الذي أوقعني في «PENDING» قبل أيّام: خريطةٌ في الواجهة كُتبت من
 * الذاكرة لا من المصدر، فسقط ما نُسي منها إلى الفرع الافتراضي وظهر رمزٌ
 * إنجليزيّ في شاشةٍ عربية. وهنا الأثر أثقل: الكشف يُطبع ويُسلَّم للعميل.
 *
 * ولهذا **تُشتقّ القائمة من الخادم لا تُكتب هنا**: نوعٌ سابعٌ يُضاف غداً في
 * `accounting.ts` أو `import.ts` يُسقط هذا الاختبار، فيُقرَّر له لفظٌ عربيّ
 * بدل أن يُكتشف في كشفٍ بيد عميل.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

/** كل نوعٍ يكتبه الخادم في `accountEntry.create` — مُشتقّاً من المصدر */
function serverEntryTypes(): string[] {
  const files = [
    ['..', 'backend', 'src', 'services', 'accounting.ts'],
    ['..', 'backend', 'src', 'routes', 'import.ts'],
  ];
  const out = new Set<string>();
  for (const f of files) {
    const s = read(...f);
    // كل `accountEntry.create` وما يليه: النوع يُكتب في الأسطر القليلة بعده
    for (const m of s.matchAll(/accountEntry\.create\(\{[\s\S]{0,400}?\}\)/g)) {
      for (const t of m[0].matchAll(/type: (?:'([A-Z_]+)'|[^,\n]*\? '([A-Z_]+)' : '([A-Z_]+)')/g)) {
        for (const g of [t[1], t[2], t[3]]) if (g) out.add(g);
      }
    }
  }
  return [...out].sort();
}

test('الخادم يكتب ستّة أنواع — والقائمة تُشتقّ منه لا تُكتب من الذاكرة', () => {
  const types = serverEntryTypes();
  assert.deepEqual(types, [
    'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT',
    'INVOICE_CREDIT', 'INVOICE_DEBIT',
    'RECEIPT_CREDIT', 'RECEIPT_DEBIT',
  ], `أنواع القيود تغيّرت: ${types.join(' · ')} — راجع خريطة الواجهة`);
});

test('خريطة كشف الحساب تغطّي كل نوعٍ يكتبه الخادم', () => {
  const s = read('src', 'm', 'MCustomerStatement.tsx');
  const i = s.indexOf('const KIND');
  assert.ok(i > 0, 'خريطة أنواع القيود مفقودة من شاشة الكشف');
  const map = s.slice(i, s.indexOf('};', i));
  for (const t of serverEntryTypes()) {
    assert.match(map, new RegExp(`${t}:`), `النوع ${t} بلا لفظٍ عربيّ — يظهر رمزاً إنجليزياً في كشفٍ يُطبع للعميل`);
  }
});

test('لفظ كل نوعٍ صادق: المحايد لا يُسمّى مرتجعاً وحده', () => {
  /* `INVOICE_CREDIT` يكتبه الخادم للمرتجع **وللإلغاء** معاً — ثلاثة مواضع في
   * accounting.ts بوصفين مختلفين. فتسميته «مرتجع» تكذب على صفوف الإلغاء. */
  const acc = read('..', 'backend', 'src', 'services', 'accounting.ts');
  const descs = [...acc.matchAll(/type: 'INVOICE_CREDIT',[\s\S]{0,120}?description: '([^']+)'/g)].map(m => m[1]);
  assert.ok(descs.length >= 2, 'مواضع INVOICE_CREDIT تغيّرت — راجع لفظها في الواجهة');
  assert.ok(descs.some(d => d.includes('إلغاء')) && descs.some(d => d.includes('مرتجع')),
    'النوع لم يعد يجمع الإلغاء والمرتجع — يمكن تضييق لفظه الآن');
  const s = read('src', 'm', 'MCustomerStatement.tsx');
  const map = s.slice(s.indexOf('const KIND'), s.indexOf('};', s.indexOf('const KIND')));
  assert.match(map, /INVOICE_CREDIT: \{ label: 'إلغاء أو مرتجع'/, 'اللفظ يجب أن يسع الحالتين');
});

test('ألفاظ الخريطة كلّها في القاموس — `tr(متغيّر)` يفلت من حارسه العامّ', () => {
  /* حارس القاموس يمسح نداءات `tr('نصّ')` الحرفيّة وحدها، وهذه تمرّ عبر
   * `tr(k.label)`. فلفظٌ يُضاف هنا ولا يُضاف للقاموس يبقى عربيّاً في اللغات
   * الأربع الأخرى **بلا أن يسقط اختبارٌ واحد** — وهو أخفى ما في التدويل. */
  const s = read('src', 'm', 'MCustomerStatement.tsx');
  const map = s.slice(s.indexOf('const KIND'), s.indexOf('};', s.indexOf('const KIND')));
  const labels = [...map.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
  assert.ok(labels.length >= 6, `عدد الألفاظ ${labels.length} — راجع الخريطة`);
  const dict = read('src', 'i18n', 'strings.ts');
  for (const l of new Set(labels)) {
    assert.ok(dict.includes(`'${l}':`), `اللفظ «${l}» ليس في القاموس فيبقى عربياً في كل اللغات`);
  }
});
