// كشف حساب العميل في لوحة الويب (صفحة العملاء ← «كشف حساب PDF»): المستند المفتوح كان يحمل نسخة الشركة لحظة فتحه، فحفظ
// «نصوص المطبوعات» وهو مفتوح لا يصل طباعته ولا مشاركته — كما أُصلح في الفواتير والسندات (c99276b، D-G3/D-G6).
// الصفحة ضخمة تعتمد على المتصفّح فلا تُرسَم هنا؛ والحارس يثبت موضع الشرط في المصدر، والسلوك عبر withLiveCompany نفسها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLiveCompany } from './companyRefresh';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('صفحة العملاء: كشف الحساب المفتوح يأخذ تجدّد الشركة، وفتحه ينتظر الشركة إن لم تكتمل', () => {
  const s = read('pages/CustomersPage.tsx');
  assert.match(s, /import \{ withLiveCompany \} from '\.\.\/rep\/companyRefresh';/);
  assert.match(s, /const fetchCompany = async \(\) => \{ const res = await companyApi\.get\(\); return res\.data\.data as Company; \};/);
  assert.match(s, /useQuery\(\{ queryKey: \['company'\], queryFn: fetchCompany \}\)/, 'الاستعلام والضمان بدالّة واحدة');
  assert.match(s, /useEffect\(\(\) => \{ setDocResult\(d => \(d \? withLiveCompany\(d, company\) : d\)\); \}, \[company\]\);/,
    'تجدّد الشركة لا يصل الكشف المفتوح: إعادة طباعته بالنصوص القديمة');
  const call = "statementDocFromData(customer, entries, user?.name || tr('الإدارة'), co, { teamScoped: teamScoped === true })";
  const c = s.indexOf(call);
  assert.ok(c > 0, 'بناء الكشف لا يستعمل الشركة المضمونة');
  const ensure = s.lastIndexOf("company ?? await qc.ensureQueryData({ queryKey: ['company'], queryFn: fetchCompany })", c);
  assert.ok(ensure > 0 && c - ensure < 400, 'الشركة لا تُضمن قبل بناء الكشف');
  assert.match(s.slice(Math.max(0, ensure - 40), c), /try \{ co = company \?\? await/, 'فشل الضمان يجب ألا يمنع فتح الكشف');
  // لا بناءٌ آخر للكشف بنسخة الشركة لحظة الفتح
  assert.equal(s.split('statementDocFromData(').length - 1, 1);
});

test('withLiveCompany على كشف الحساب: الشركة المتجدّدة تُستبدل والباقي كما هو؛ والفارغة لا تمحو النسخة', () => {
  const oldCo = { name: 'شركة', printTexts: null };
  const newCo = { name: 'شركة', printTexts: { v: 1, edits: { 'h.phone': { text: 'رقم الهاتف', alt: null, hidden: false } } } };
  const doc = { kind: 'statement' as const, company: oldCo as unknown, repName: 'الإدارة', entries: [{ debit: 5 }], finalBalance: 5 };
  const live = withLiveCompany(doc, newCo);
  assert.notEqual(live, doc);
  assert.equal(live.company, newCo);
  assert.deepEqual({ ...live, company: null }, { ...doc, company: null });
  assert.equal(withLiveCompany(doc, undefined), doc);
  assert.equal(withLiveCompany(doc, null), doc);
  assert.equal(withLiveCompany(doc, oldCo), doc, 'بلا تغيير: الهوية نفسها — لا إعادة رسم');
});
