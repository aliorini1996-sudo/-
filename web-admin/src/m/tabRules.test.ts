import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { visibleTabs, receiptsRoute, MAX_SEATS, TabId } from './tabRules';
import { PermKey } from './perms';

/**
 * قاعدة المقاعد تُشغَّل على **كل** التباديل، لا تُقرأ نصّاً.
 *
 * الحارس القديم كان يعدّ سطور التعريف في المصفوفة ويقول «ستّة معرَّفة وواحدٌ
 * بديل فالمعروض خمسة» — وهو قولٌ عن نيّة الكاتب لا عن سلوك الكود: أيّ خطأ في
 * الشرط نفسه يمرّ من تحته. وهنا تُشغَّل القاعدة على ٦٤ تبديلة صلاحيات × ٤
 * حالات للمفتاحين = ٢٥٦ حالة، ويُقاس فيها ما يهمّ فعلاً.
 */

/** نسخة من TABS في MobileApp — المعرّف والصلاحية وحدهما يدخلان القاعدة */
const TABS: { id: TabId; perm: PermKey }[] = [
  { id: 'home', perm: 'canAccessDashboard' },
  { id: 'invoices', perm: 'canManageInvoices' },
  { id: 'receipts', perm: 'canManageReceipts' },
  { id: 'dailyReports', perm: 'canViewReports' },
  { id: 'customers', perm: 'canManageCustomers' },
  { id: 'tracking', perm: 'canManageTracking' },
];

const PERMS = TABS.map(t => t.perm);

/** كل تباديل الصلاحيات × كل حالات المفتاحين */
function* cases() {
  for (let mask = 0; mask < (1 << PERMS.length); mask++) {
    const granted = new Set(PERMS.filter((_, i) => mask & (1 << i)));
    const allowed = (p: PermKey) => granted.has(p);
    for (const accountingOn of [true, false]) {
      for (const dailyReportOn of [true, false]) {
        yield { granted, allowed, flags: { accountingOn, dailyReportOn }, mask };
      }
    }
  }
}

const label = (c: { granted: Set<PermKey>; flags: { accountingOn: boolean; dailyReportOn: boolean } }) =>
  `[${[...c.granted].join(',') || 'بلا صلاحيات'}] محاسبة=${c.flags.accountingOn} تقرير=${c.flags.dailyReportOn}`;

test('سقف الخمسة مُثبَتٌ على كل التباديل — لا موعود', () => {
  let n = 0;
  for (const c of cases()) {
    const shown = visibleTabs(TABS, c.allowed, c.flags);
    assert.ok(shown.length <= MAX_SEATS, `${shown.length} مقاعد في ${label(c)}`);
    n++;
  }
  assert.equal(n, 256, 'عدد الحالات تغيّر — راجع المولّد');
});

test('لا يظهر مقعدٌ بلا صلاحيته — ولا يسقط مقعدٌ بصلاحيته بلا سبب معلوم', () => {
  for (const c of cases()) {
    const shown = visibleTabs(TABS, c.allowed, c.flags);
    for (const t of shown) {
      assert.ok(c.granted.has(t.perm), `${t.id} ظهر بلا صلاحيته في ${label(c)}`);
    }
    // ولا يسقط مقعدٌ إلّا بأحد أسبابٍ ثلاثة معلومة
    for (const t of TABS) {
      if (!c.granted.has(t.perm)) continue;
      if (shown.some(s => s.id === t.id)) continue;
      const money = t.id === 'invoices' || t.id === 'receipts';
      const ok = (t.id === 'dailyReports' && !c.flags.dailyReportOn)
        || (money && !c.flags.accountingOn)
        || (t.id === 'receipts' && c.flags.dailyReportOn);
      assert.ok(ok, `${t.id} سقط بلا سبب في ${label(c)}`);
    }
  }
});

test('التقارير اليومية تتبع مفتاحها وحده', () => {
  for (const c of cases()) {
    const has = visibleTabs(TABS, c.allowed, c.flags).some(t => t.id === 'dailyReports');
    assert.equal(has, c.flags.dailyReportOn && c.granted.has('canViewReports'), label(c));
  }
});

test('إطفاء النظام المحاسبي يُسقط المستندين معاً', () => {
  for (const c of cases()) {
    if (c.flags.accountingOn) continue;
    const ids = visibleTabs(TABS, c.allowed, c.flags).map(t => t.id);
    assert.ok(!ids.includes('invoices') && !ids.includes('receipts'), label(c));
  }
});

/* ═══ الخاصّية الحاكمة ═══ */

test('كل صلاحية ممنوحة لها طريق — ولا سندات قبضٍ بلا باب', () => {
  /* الثغرة التي أغلقتها هذه القاعدة: «التقارير اليومية» كانت تأخذ مقعد
   * التحصيل من **كل** مستخدم، وزرُّ التحويل يسكن شاشة الفواتير. فموظّف تحصيلٍ
   * مُنع من الفواتير كان يفقد الطريقين معاً: صلاحيةٌ منحها المالك ولا يبلغها
   * صاحبها من أيّ باب — بلا رسالة ولا خطأ. */
  for (const c of cases()) {
    const route = receiptsRoute(TABS, c.allowed, c.flags);
    const entitled = c.granted.has('canManageReceipts') && c.flags.accountingOn;
    if (entitled) {
      assert.notEqual(route, 'none', `سندات القبض بلا طريق في ${label(c)}`);
    } else {
      assert.equal(route, 'none', `طريقٌ إلى سندات القبض بلا استحقاق في ${label(c)}`);
    }
  }
});

test('من له مقعد فواتير يفقد مقعد تحصيله لصالح التقارير — ومن لا مقعد له يحتفظ به', () => {
  for (const c of cases()) {
    if (!c.flags.dailyReportOn || !c.granted.has('canManageReceipts') || !c.flags.accountingOn) continue;
    const ids = visibleTabs(TABS, c.allowed, c.flags).map(t => t.id);
    const invoicesSeat = c.granted.has('canManageInvoices');
    assert.equal(ids.includes('receipts'), !invoicesSeat,
      `مقعد التحصيل مخالفٌ للقاعدة في ${label(c)}`);
    // والطريق موجودٌ في الحالين: مقعدٌ أو زرّ
    assert.equal(receiptsRoute(TABS, c.allowed, c.flags), invoicesSeat ? 'switch' : 'seat', label(c));
  }
});

test('المكوّن يستعمل القاعدة ولا ينسخها', () => {
  /* نسخةٌ ثانية من الشرط داخل المكوّن تعني قاعدتين تتباعدان مع الوقت،
   * وهذه الاختبارات تحرس إحداهما فقط. */
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MobileApp.tsx'), 'utf8');
  assert.match(s, /visibleTabs\(TABS,/, 'المكوّن لا ينادي القاعدة');
  assert.doesNotMatch(s, /t\.id === 'receipts' && dailyReportOn/, 'نسخةٌ ثانية من الشرط بقيت في المكوّن');
});
