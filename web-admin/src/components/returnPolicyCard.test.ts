/**
 * بطاقة «اشتراط اختيار فاتورة البيع للمرتجع» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — حرّاسٌ نصّية (المكوّن يعتمد React Query والنافذة):
 * لمدير الشركة غير المقيَّد وحده، تُحفظ فوراً بمسارها المستقل وتُبطل ['company']، والإطفاء في المرحلة الثانية يمرّ بتأكيد
 * المسؤولية، وأزرارها لا تُرسل نموذج الإعدادات العامة الذي تقع داخله. والقاعدة الفعّالة من lib/returnPolicy.ts (مرآة الخادم).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { returnLinkDefault, returnLinkRequired } from '../lib/returnPolicy';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const card = () => read('components', 'ReturnPolicyCard.tsx');
const page = () => read('pages', 'CompanySettingsPage.tsx');

test('التوصيل: مدير الشركة غير المقيَّد وحده، في الإعدادات العامة بعد بطاقة التشغيلة — لا في تبويب الفوترة', () => {
  const s = page();
  assert.ok(s.includes("import ReturnPolicyCard from '../components/ReturnPolicyCard';"));
  assert.match(s, /const returnPolicyCardOn = role === 'ADMIN' && !scopeEnabled;/, 'الظهور ليس لمدير الشركة غير المقيَّد وحده');
  assert.equal(s.match(/<ReturnPolicyCard\b/g)?.length, 1);
  assert.ok(s.includes('{returnPolicyCardOn && <ReturnPolicyCard company={data} />}'), 'البطاقة بلا شرط ظهورها');
  const at = s.indexOf('<ReturnPolicyCard');
  assert.ok(at > s.indexOf('{lotCardOn && <LotOnInvoiceCard'), 'ليست بجانب بطاقة التشغيلة');
  // في الإعدادات العامة (داخل نموذجها) لا خلف تبويب الفوترة الذي لا تراه شركات المرحلة الأولى
  assert.ok(at > s.indexOf('<form onSubmit') && at < s.indexOf('</form>'));
  assert.ok(at > s.indexOf('<div hidden={showZatca}>'));
  // والنموذج العام لا يحمل الإعداد: مساره المستقل وحده يكتبه
  const mutation = s.slice(s.indexOf('const mutation = useMutation'), s.indexOf('const onLogoChange'));
  assert.doesNotMatch(mutation, /returnRequiresSaleInvoice|requireSaleInvoice/);
});

test('الحفظ: فوراً بـcompanyApi.returnPolicy.put ثم إبطال [company] ورسالة الحفظ — لا مع زرّ «حفظ الإعدادات»', () => {
  const s = card();
  assert.match(s, /mutationFn: \(requireSaleInvoice: boolean \| null\) => companyApi\.returnPolicy\.put\(requireSaleInvoice\)/);
  assert.match(s, /await qc\.invalidateQueries\(\{ queryKey: \['company'\] \}\);/, 'ردّ /company لا يُبطَل — جهاز المندوب والنموذج يقرآن العمود منه');
  assert.ok(s.includes("toast.success(tr('تم حفظ إعداد المرتجع'))"));
  // المفتاح يحفظ عند التبديل، و«استعادة الافتراضي» تُرسل null — ولا تظهر إلا لقيمةٍ مخصّصة
  assert.match(s, /onChange=\{e => toggle\(e\.target\.checked\)\}/);
  assert.match(s, /\{custom && \([\s\S]*?onClick=\{\(\) => save\.mutate\(null\)\}>[\s\S]*?\{tr\('استعادة الافتراضي'\)\}/);
  assert.match(s, /const custom = stored === true \|\| stored === false;/);
});

test('الإطفاء في المرحلة الثانية يمرّ بتأكيد المسؤولية — والتشغيل والمرحلة الأولى بلا تأكيد', () => {
  const s = card();
  const body = s.slice(s.indexOf('const toggle = (next: boolean) => {'), s.indexOf('return (', s.indexOf('const toggle')));
  assert.match(body, /if \(!next && phase2 && !window\.confirm\(tr\(CONFIRM_OFF_PHASE2\)\)\) return;/, 'لا تأكيد قبل الإطفاء في المرحلة الثانية');
  assert.ok(body.indexOf('window.confirm') < body.indexOf('save.mutate(next)'), 'الحفظ قبل التأكيد');
  assert.match(s, /const CONFIRM_OFF_PHASE2 = '[^']*مسؤولة أمام الهيئة[^']*';/);
  assert.match(s, /const phase2 = isPhase2Company\(company\);/);
  // تحذير المسؤولية مكتوبٌ في البطاقة ما دام الإطفاء قائماً في المرحلة الثانية
  assert.match(s, /\{!effective && phase2 && \(\s*<div role="note"/);
  // الحالة الفعّالة من القاعدة المشتركة لا من قراءةٍ خاصة للعمود
  assert.match(s, /: returnLinkRequired\(company\);/);
  assert.match(s, /const phaseDefault = returnLinkDefault\(company\);/);
});

test('العبارات: الشرح بحسب المرحلة والحالة، والافتراضي ظاهر', () => {
  const s = card();
  for (const k of [
    'اشتراط اختيار فاتورة البيع للمرتجع', 'الافتراضي لشركتك', 'مرتجع بلا فاتورة بيع مسموح', 'مرتجع برقم فاتورة من نظام سابق مسموح',
    'مشترط في المرحلة الثانية', 'غير مشترط في المرحلة الأولى',
  ]) assert.ok(s.includes(`tr('${k}')`), k);
  assert.match(s, /: phase2 \? tr\('مرتجع برقم فاتورة من نظام سابق مسموح'\) : tr\('مرتجع بلا فاتورة بيع مسموح'\)/);
});

test('داخل نموذج الإعدادات العامة: كل زرٍّ type="button" — زرٌّ بلا نوع يُرسل النموذج كلّه', () => {
  const s = card();
  const all = s.match(/<button\b/g)?.length ?? 0;
  const typed = s.match(/<button\s+type="button"/g)?.length ?? 0;
  assert.ok(all > 0);
  assert.equal(typed, all);
  assert.doesNotMatch(s, /type="submit"/);
});

test('القاعدة المعروضة: null افتراضيّ المرحلة، والصريح يغلبه في المرحلتين', () => {
  const p1 = { countryCode: 'SA' };
  const p2 = { countryCode: 'SA', zatcaPhase2StartedAt: '2026-10-02T00:00:00.000Z' };
  assert.deepEqual([returnLinkDefault(p1), returnLinkDefault(p2)], [false, true]);
  assert.deepEqual([null, undefined, true, false].map((v) => returnLinkRequired({ ...p1, returnRequiresSaleInvoice: v })), [false, false, true, false]);
  assert.deepEqual([null, undefined, true, false].map((v) => returnLinkRequired({ ...p2, returnRequiresSaleInvoice: v })), [true, true, true, false]);
});
