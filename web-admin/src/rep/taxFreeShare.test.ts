/**
 * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — المشاركة: رابط المشتري ورسالته للمرحلة الثانية وحدها، والختم بلا ضريبة لا يجتمع معها
 * (الخادم يمنع الجمع). دفاعٌ ثانٍ على الواجهة: صفٌّ مختومٌ لا رابط له، وعنوان رسالته «فاتورة»/«فاتورة مرتجع» بصياغة الشركة، ونصّها
 * الاحتياطي بلا «الضريبية» ولا عبارة الهيئة. وبلا ختم: كل ذلك كما اليوم حرفاً.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShareableRow, shareMessageOf } from '../lib/zatca/shareView';
import { shareMessageTitle } from '../lib/zatca/shareTitle';
import { TAX_FREE_TITLES } from '../lib/taxMode';

const LINK = 'https://fieldsa.net/e/tok';
const TAX = /ضريب|الهيئة|هيئة الزكاة|مبسطة|إشعار دائن|إشعار مدين/;
const texts = (edits: Record<string, { text: string | null; alt: string | null; hidden: boolean }>) => ({
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits,
});

test('صفٌّ مختومٌ بلا ضريبة لا رابط مشترٍ له — وبلا ختم الحكم كما اليوم', () => {
  const row = { zatcaPhase: 2, einvoiceStatus: 'reported' };
  assert.equal(isShareableRow(row), true);
  assert.equal(isShareableRow({ ...row, taxFree: false }), true);
  assert.equal(isShareableRow({ ...row, taxFree: null }), true);
  assert.equal(isShareableRow({ ...row, taxFree: true }), false);
  assert.equal(isShareableRow({ zatcaPhase: 1, einvoiceStatus: null, taxFree: true }), false);
});

test('عنوان الرسالة للمختوم: «فاتورة»/«فاتورة مرتجع» بصياغة الشركة — والمحذوف يعود للعنوان نفسه', () => {
  assert.equal(shareMessageTitle({ taxFree: true }, null), TAX_FREE_TITLES.sale);
  assert.equal(shareMessageTitle({ taxFree: true, isReturn: true }, null), TAX_FREE_TITLES.return);
  // الختم يغلب أيّ حقيقةٍ من المرحلة الثانية
  assert.equal(shareMessageTitle({ taxFree: true, subtype: '01', mirror: 'cleared', documentKind: 'INVOICE' }, null), 'فاتورة');
  assert.equal(shareMessageTitle({ taxFree: true, documentKind: 'CREDIT_NOTE' }, null), 'فاتورة');
  // صياغة الشركة لعنوان الفاتورة تسري كما تسري على الورقة
  assert.equal(shareMessageTitle({ taxFree: true }, texts({ 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } })), 'فاتورة مبيعات');
  assert.equal(shareMessageTitle({ taxFree: true }, texts({ 'inv.title': { text: null, alt: null, hidden: true } })), 'فاتورة');
  for (const t of [shareMessageTitle({ taxFree: true }, null), shareMessageTitle({ taxFree: true, isReturn: true }, null)]) assert.doesNotMatch(t!, TAX);
});

test('بلا ختم: عنوان الرسالة كما اليوم حرفاً', () => {
  for (const f of [{ subtype: '02' }, { subtype: '01' }, { mirror: 'cleared' }, { isReturn: true }, { documentKind: 'DEBIT_NOTE' }, {}]) {
    assert.equal(shareMessageTitle({ ...f, taxFree: false }, null), shareMessageTitle(f, null));
    assert.equal(shareMessageTitle({ ...f, taxFree: null }, null), shareMessageTitle(f, null));
  }
});

test('نصّ الرسالة للمختوم: لا «الضريبية» في العنوان الاحتياطي ولا عبارة الهيئة ولو وصلت مرآةٌ نهائية', () => {
  for (const input of [
    { number: 'INV-1', taxFree: true },
    { number: null, taxFree: true },
    { number: 'INV-1', taxFree: true, mirror: 'cleared', phase: 2 },
    { number: 'INV-1', taxFree: true, title: 'فاتورة', mirror: 'reported' },
  ]) {
    const m = shareMessageOf(input, LINK);
    assert.doesNotMatch(m, TAX, m);
    assert.ok(m.endsWith(LINK));
  }
  assert.equal(shareMessageOf({ number: 'INV-1', taxFree: true, sellerName: 'شركة' }, LINK), `فاتورتكم رقم INV-1 من شركة:\n${LINK}`);
});

test('بلا ختم: نصّ الرسالة كما اليوم حرفاً', () => {
  for (const input of [
    { number: 'INV-1' }, { number: null }, { number: 'INV-1', title: 'فاتورة ضريبية', mirror: 'cleared', phase: 2 },
    { number: 'INV-2', title: 'فاتورة ضريبية مبسطة', mirror: 'reported' }, { number: 'INV-3', sellerName: 'شركة', mirror: 'cleared', phase: 1 },
  ]) {
    const today = shareMessageOf(input, LINK);
    assert.equal(shareMessageOf({ ...input, taxFree: false }, LINK), today);
    assert.equal(shareMessageOf({ ...input, taxFree: null }, LINK), today);
  }
  assert.equal(shareMessageOf({ number: 'INV-1' }, LINK), `فاتورتكم الضريبية رقم INV-1:\n${LINK}`);
});
