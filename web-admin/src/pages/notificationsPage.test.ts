import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PHRASES } from '../i18n/strings';

// rep-offline-6: إشعار الإدارة لفاتورةٍ دون اتصال أُعيد تفسير كمياتها بعد «إضافة وحدة فرعية أصغر» (D16، invoices.ts
// recordReplayRebased: type REPLAY_UNITS_REBASED) كان يظهر برمزه الإنجليزي الخام وسماً — tr(typeLabels[n.type] || n.type)
const page = fs.readFileSync(path.resolve(process.cwd(), 'src', 'pages', 'NotificationsPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const objectOf = (name: string): Record<string, string> => {
  const from = page.indexOf(`const ${name}: Record<string, string> = {`);
  assert.ok(from >= 0, `غائب: ${name}`);
  const open = page.indexOf('{', from);
  const close = page.indexOf('\n};', open);
  return new Function(`return ${page.slice(open, close + 2)};`)() as Record<string, string>;
};

test('وسم إشعار إعادة الرفع بعد تحويل الوحدات (وحجز اللوط) عربيٌّ مترجم لا رمزٌ خام', () => {
  const labels = objectOf('typeLabels');
  for (const type of ['REPLAY_UNITS_REBASED', 'LOT_REPLAY_HELD']) {
    const ar = labels[type];
    assert.ok(ar && /[؀-ۿ]/.test(ar), `${type} بلا وسم عربي`);
    assert.ok(!ar.includes('الأساس'), 'D21');
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[ar]?.[lang]?.trim(), `${lang} فارغة: ${ar}`);
  }
  // ميدانيّان لا محاسبيّان: لا يخفيهما إطفاء المحاسبة
  const acc = page.slice(page.indexOf('const ACCOUNTING_TYPES'), page.indexOf(']);', page.indexOf('const ACCOUNTING_TYPES')));
  assert.ok(acc.length > 0);
  assert.doesNotMatch(acc, /REPLAY_UNITS_REBASED|LOT_REPLAY_HELD/);
  // الأنواع القائمة كما هي
  assert.equal(labels.INVOICE_CANCELLED, 'إلغاء فاتورة');
  assert.ok(objectOf('typeColors').REPLAY_UNITS_REBASED);
});
