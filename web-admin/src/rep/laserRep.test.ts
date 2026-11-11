// «قارئ الليزر» في فاتورة المندوب (طلب المالك ١١ نوفمبر ٢٠٢٦) — إصلاحات المراجعة: الحكم المعلّق، والحقل المخصّص، والإطفاء تحت
// الأغطية، ونوع المطابقة على الأصناف كلّها، وإعادة السلّة والتوقيع بعد مسحٍ في خانة بند.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { scanMatcher, type ScanMatchable } from '../lib/laserScanner';
import LaserScanField from './LaserScanField';

const src = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
const rep = src('rep', 'RepApp.tsx');
const field = src('rep', 'LaserScanField.tsx');

/** منطق onScan في RepApp: نوع المطابقة على الأصناف كلّها، ثم البحث به في أصناف الفريق */
function repScan(products: (ScanMatchable & { id: string })[], team: (ScanMatchable & { id: string })[], code: string) {
  const match = scanMatcher(products, code);
  const p = team.find((x) => match(x, code));
  return { p, filteredOwner: !p && products.some((x) => match(x, code)) };
}

test('V9: باركود صنفٍ مستبعَد من الفريق لا يسقط إلى كود صنفٍ آخر يساويه', () => {
  const a = { id: 'a', barcode: '999', code: 'X1' }; // من الفريق، كوده الداخلي X1
  const b = { id: 'b', barcode: 'X1', code: 'B' };   // باركوده X1 لكنه مستبعَد (فريقٌ آخر أو قيد مندوب)
  const r = repScan([a, b], [a], 'X1');
  assert.equal(r.p, undefined, 'لا يُضاف A بنغمة نجاح');
  assert.ok(r.filteredOwner, 'ويُقال سبب استبعاد B');
  // بلا باركودٍ مطابق في الكتالوج كلّه: الكود الداخلي احتياطاً كما كان
  assert.equal(repScan([a], [a], 'x1').p?.id, 'a');
  assert.equal(repScan([a, b], [a, b], '999').p?.id, 'a');
  // والمصدر: الشاشة تحسم النوع على products وتبحث به في teamProducts والقيود ورسالة الفريق
  assert.match(rep, /const match = scanMatcher\(products, code\);/);
  assert.match(rep, /teamProducts\.find\(\(x\) => match\(x, code\)\)/);
  assert.match(rep, /products\.find\(\(x\) => match\(x, code\) && repBlockKey/);
  assert.match(rep, /products\.some\(\(x\) => match\(x, code\)\)/);
  assert.doesNotMatch(rep, /findByScan\(teamProducts/);
});

test('V1: حكم اللوط المعلّق شريطٌ محايد بلا نغمة، والنغمة حين يصل الحكم (وبديلٌ إن تعثّر)', () => {
  assert.match(rep, /if \(!pending\) scanFeedback\(r\.ok\);/);
  assert.match(rep, /showLaser\(r, true\);/);
  assert.match(rep, /r\.later\.then\(x => showLaser\(x\)\)\.catch\(/);
  assert.match(rep, /laserFlash\.pending \? 'bg-\[#6B5E4E\]'/, 'لونٌ محايد لا أحمر');
});

test('V5/V8: الحقل والمستمع يسكتان معاً — منتقي فاتورة البيع، الإصدار، حاجز الموقع، «أثبت تواجدك»', () => {
  assert.match(rep, /const laserActive = !showScanner && !pickSale && !loading && !laserBlocked;/);
  assert.match(rep, /useLaserScanner\([^\n]*, laserActive, \{ onBurstStart: laserBurstStart, onBurstAbort: laserRestore \}\)/);
  assert.match(rep, /!retSourceBlock && laserOn && laserActive && \(\s*<LaserScanField/);
  const passes = rep.match(/<CreateInvoice [^]*?laserBlocked=\{gateShown \|\| !!presence\}/g) ?? [];
  assert.equal(passes.length, 2, 'البيع والمرتجع كلاهما');
  assert.match(rep, /laserBlocked = false \}: \{/);
});

test('V6: رقم الفاتورة الأصلية خارج المستمع العام', () => {
  assert.match(rep, /value=\{manualNo\} onChange=\{e => setManualNo\(e\.target\.value\)\}\s*placeholder="INV-0001" data-laser-ignore=""/);
});

test('V11: مسحٌ في خانة بند يعيد السلّة والتوقيع والرسالة قبل الإضافة أو عند الرفض', () => {
  assert.match(rep, /data-laser-cart=""/);
  assert.match(rep, /a\.closest\('\[data-laser-cart\]'\)/);
  assert.match(rep, /cartRef\.current\.map\(l => \(\{ \.\.\.l \}\)\)/, 'نسخ البنود: upd يعدّلها في مكانها');
  // إضافةٌ وصل حكم لوطها أثناء الدفعة لا تُطمس
  assert.match(rep, /const commitAdd = [^\n]*\n\s*cartAdds\.current\+\+;/);
  assert.match(rep, /if \(cartAdds\.current === s\.adds && shape\(cartRef\.current\) === shape\(s\.lines\)\)/);
  // المسح: الإعادة أولاً ثم الإضافة — والحقل المخصّص (لا دفعة فيه) لا يُعيد لقطةً قديمة
  assert.match(rep, /\(code\) => \{ laserRestore\(\); onLaser\(code\); \}/);
  assert.match(rep, /<LaserScanField onScan=\{onLaser\}/);
  assert.match(rep, /setSignatures\(s\.signatures\); setSigDropped\(s\.sigDropped\); setSigPadKey\(k => k \+ 1\);/);
});

test('V2/V3/V4: الحقل المخصّص — المواضع، والتركيز بعد مغادرة أي عنصر، وسكون القارئ بلا لاحقة', () => {
  assert.match(field, /import \{ burstWindowMs, cleanScan, wedgeChar, WEDGE_DEFAULTS \} from '\.\.\/lib\/laserScanner';/);
  assert.match(field, /wedgeChar\(n\)/);
  assert.match(field, /submit\(phys\.current \|\| val\)/);
  assert.match(field, /document\.addEventListener\('focusout', keepFocus, true\)/);
  assert.match(field, /a\.tagName === 'INPUT' \|\| a\.tagName === 'TEXTAREA' \|\| a\.tagName === 'SELECT' \|\| a\.isContentEditable/);
  // حدود المستمع العام: النافذة، والجري السريع (قارئٌ لا إنسان)، وطول السكون
  assert.match(field, /const BURST_WIN = burstWindowMs\(WEDGE_DEFAULTS\.maxGapMs\);/);
  assert.match(field, /longest\.current >= WEDGE_DEFAULTS\.minLength && !\/\\s\/\.test\(burst\) && cleanScan\(burst\)\.length >= WEDGE_DEFAULTS\.idleMinLength/);
  assert.match(field, /\}, BURST_WIN \+ 30\);/);
  // Enter بعد السكون لا يضيف مرّتين: الإرسال يلغي المؤقّت
  assert.match(field, /const submit = \(raw: string\) => \{\s*resetBuf\(\);/);
  assert.match(field, /const resetBuf = \(\) => \{\s*window\.clearTimeout\(idleT\.current\);/);
  // الحقل يُرسم ويبقى مستثنىً من المستمع العام وبلا لوحة مفاتيح الجوال
  const html = renderToStaticMarkup(createElement(LaserScanField, { onScan: () => undefined, onUseCamera: () => undefined }));
  assert.match(html, /data-laser-field=""/);
  assert.match(html, /inputmode="none"/i);
});
