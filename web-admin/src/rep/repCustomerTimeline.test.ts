// «السجل الزمني» للعميل في تطبيق المندوب (طلب المالك ٢٦ نوفمبر ٢٠٢٦: «أضف أيقونة لفتح السجل الزمني لمعرفة الجميع كل سجل
// عمل أي أحد مع هذا العميل … واجعل سجل العميل هذا لا يمكن لأحد تغيير أي شيء فيه نهائياً») — حرّاسٌ نصّية على الربط:
//   • الأيقونة في بطاقة العميل بجوار «تعديل»، ولا يحجبها إذن التعديل (لكل مندوبٍ فتح ملفّ العميل).
//   • تفتح ورقة RepCustomerTimeline ملء الشاشة، والرجوع يغلقها وحدها.
//   • الورقة تقرأ من GET /customers/:id/activity وحده — لا طلب كتابة ولا زرّ حذفٍ أو تعديل.
//   • دون اتصال: رسالةٌ ودودة وإعادة محاولة داخل الورقة وحدها، والعميل المضاف دون اتصال لا يُطلب سجلّه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => fs.readFileSync(path.join(here, ...p), 'utf8').replace(/\r\n/g, '\n');
/** المصدر بلا تعليقات — كي لا تُطابَق كلمةٌ في شرحٍ على أنها كود */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const repApp = read('RepApp.tsx');
const sheet = read('RepCustomerTimeline.tsx');
const sheetCode = code(sheet);

/** جسم دالةٍ من المصدر: من توقيعها حتى أول دالةٍ علويّة بعدها */
function fnBody(src: string, sig: string): string {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `غائب: ${sig}`);
  const next = src.indexOf('\nfunction ', at + sig.length);
  return src.slice(at, next < 0 ? undefined : next);
}
const detailFn = fnBody(repApp, 'function CustomerDetail(');

// ═══ الأيقونة في بطاقة العميل ═══

test('الأيقونة (History) مستوردة، والورقة مستوردة من ملفّها', () => {
  assert.match(repApp, /import \{[^}]*\bHistory\b[^}]*\} from 'lucide-react';/, 'أيقونة History غير مستوردة');
  assert.ok(repApp.includes("import RepCustomerTimeline from './RepCustomerTimeline';"), 'الورقة غير مستوردة');
});

test('الأيقونة في بطاقة العميل بجوار «تعديل» — في مجموعة الأزرار نفسها وقبل زرّ التعديل', () => {
  const at = detailFn.indexOf('<p className="font-bold text-lg">{customer.name}</p>');
  assert.ok(at >= 0, 'بطاقة العميل');
  const editAt = detailFn.indexOf("{tr('تعديل')}", at);
  assert.ok(editAt > at, 'زرّ «تعديل» في البطاقة');
  const hero = detailFn.slice(at, editAt);
  const groupAt = hero.indexOf('<div className="flex-shrink-0 flex items-center gap-2">');
  const iconAt = hero.indexOf('<History size={15} />');
  const canEditAt = hero.indexOf('{canEdit && (');
  assert.ok(groupAt >= 0, 'مجموعة الأزرار التي تجمع الأيقونة و«تعديل»');
  assert.ok(iconAt > groupAt, 'الأيقونة داخل مجموعة الأزرار');
  assert.ok(canEditAt > iconAt, 'الأيقونة قبل «تعديل» وخارج شرطه');
  assert.ok(hero.includes("onClick={() => setTimelineOpen(true)} aria-label={tr('السجل الزمني')} title={tr('السجل الزمني')}"),
    'الأيقونة تفتح الورقة وتحمل اسمها لقارئ الشاشة');
});

test('الأيقونة لكل مندوبٍ يفتح ملفّ العميل — لا يحجبها إذن تعديل ولا محاسبة ولا عزل', () => {
  const at = detailFn.indexOf('<div className="flex-shrink-0 flex items-center gap-2">');
  const btn = detailFn.slice(at, detailFn.indexOf('<History size={15} />', at));
  assert.doesNotMatch(btn, /canEdit|accountingOn|unassigned|perms\.|disabled=/, 'شرطٌ يحجب الأيقونة');
});

test('الورقة: حالةٌ في ملفّ العميل، والرجوع (أندرويد/سحبة آيفون) يغلقها وحدها', () => {
  assert.ok(detailFn.includes('const [timelineOpen, setTimelineOpen] = useState(false);'));
  assert.ok(detailFn.includes('useBackClose(timelineOpen, () => setTimelineOpen(false));'), 'الرجوع غير موصول');
  // وصلاحية «عرض كشف الحساب» (لا مال بدونها — C3)، والإغلاق دالّةٌ ثابتة فلا تُعاد الورقة مع نبضة مؤقّت الزيارة (C23)
  assert.ok(detailFn.includes('{timelineOpen && <RepCustomerTimeline customer={customer} accountingOn={accountingOn} canViewStatement={canViewStatement} taxOff={isTaxOff(company)} onClose={closeTimeline} />}'),
    'الورقة لا تُعرض أو لا تأخذ علمَي المحاسبة و«إزالة الضريبة» وصلاحية كشف الحساب');
  assert.ok(detailFn.includes('const closeTimeline = useCallback(() => setTimelineOpen(false), []);'), 'الإغلاق ليس دالّةً ثابتة');
  // خارج حاوية التمرير: أول ابنٍ لجذر الملفّ فلا تتمرّر مع محتواه
  const root = detailFn.indexOf('<div className="h-full flex flex-col bg-gray-50">');
  const scroll = detailFn.indexOf('<div className="p-4 overflow-y-auto flex-1 pb-4">');
  const sheetAt = detailFn.indexOf('{timelineOpen && <RepCustomerTimeline');
  assert.ok(root >= 0 && sheetAt > root && sheetAt < scroll, 'الورقة داخل حاوية التمرير');
});

test('لا نافذة جديدة في نوع Modal — الورقة طبقةٌ داخل ملفّ العميل فيبقى مؤقّت الزيارة وحاجز الموقع كما هما', () => {
  assert.doesNotMatch(repApp, /setModal\('customerTimeline'\)|'customerTimeline'/);
});

// ═══ الورقة: قراءةٌ فقط من مسار السجل ═══

test('الورقة تقرأ من GET /customers/:id/activity بمؤشّر before والتصنيف', () => {
  assert.ok(sheetCode.includes('repApi.get(`/customers/${id}/activity`, { params: activityQuery({ before, category }) });'), 'مسار السجل ومعاملاته');
  assert.ok(sheetCode.includes('return normalizePage(res.data?.data);'), 'الصفحة بمطبِّع المكتبة المشتركة');
  assert.ok(sheetCode.includes("import ActivityTimeline from '../components/customerActivity/ActivityTimeline';"), 'المكوّن المشترك');
  assert.ok(sheetCode.includes('<ActivityTimeline key={attempt} fetchPage={fetchPage} accountingOn={accountingOn} taxOff={taxOff} compact />'),
    'المكوّن المشترك بـcompact وعلم المحاسبة');
});

test('قراءةٌ فقط: لا طلب كتابة، ولا زرّ حذفٍ أو تعديل، ولا تخزين على الجهاز', () => {
  assert.doesNotMatch(sheetCode, /repApi\.(post|put|patch|delete)\b/, 'طلب كتابة من ورقة السجل');
  assert.doesNotMatch(sheetCode, /method:\s*['"`]/, 'طريقة طلبٍ صريحة');
  assert.doesNotMatch(sheetCode, /\b(Trash2|Pencil|Edit3?|Save)\b/, 'أيقونة حذفٍ أو تعديل');
  assert.doesNotMatch(sheetCode, /outboxAdd|cacheSet|localStorage/, 'السجل يُكتب على الجهاز');
  assert.equal((sheetCode.match(/repApi\./g) || []).length, 1, 'طلبٌ واحد فقط: القراءة');
});

test('ملء الشاشة فوق ملفّ العميل وتحت حاجز الموقع، برجوعٍ وعنوانٍ واسم العميل ورقمه', () => {
  assert.ok(sheetCode.includes('className="absolute inset-0 z-[60] bg-gray-50 flex flex-col"'), 'طبقة ملء الشاشة');
  assert.ok(sheetCode.includes("<button type=\"button\" onClick={onClose} aria-label={tr('رجوع')}><ArrowRight size={20} /></button>"), 'سهم الرجوع');
  assert.ok(sheetCode.includes("{tr('السجل الزمني')}"), 'العنوان');
  assert.ok(sheetCode.includes('{customer?.name || \'\'}'), 'اسم العميل');
  assert.ok(sheetCode.includes('formatCustomerNumber(customer?.number)'), 'رقم العميل');
});

// ═══ دون اتصال: لا حجب لبقيّة التطبيق ═══

test('الصفحة الأولى: لا اتصال/خارج النطاق/خلل ← رسالةٌ ودودة وإعادة محاولة داخل الورقة', () => {
  assert.ok(sheetCode.includes("import { isNetworkError } from './offlineSync';"));
  assert.match(sheetCode, /if \(isNetworkError\(err\)\) return 'offline';/, 'لا اتصال');
  assert.match(sheetCode, /status === 404 \|\| status === 403 \? 'denied' : 'error'/, 'العميل خارج النطاق');
  assert.ok(sheetCode.includes(".catch((e) => { if (alive) setFailure(failureOf(e)); });"), 'الفشل حالةٌ لا استثناءٌ طائش');
  assert.ok(sheetCode.includes("retryLabel={tr('اعد المحاولة')} onRetry={retry}"), 'زرّ إعادة المحاولة');
  assert.ok(sheetCode.includes('const retry = () => setAttempt((a) => a + 1);'));
  assert.match(sheetCode, /\}, \[load, local, attempt\]\);/, 'إعادة المحاولة تعيد الجلب');
});

test('لا طلبٌ مكرّر للصفحة الأولى: الغلاف يسلّمها لأول طلبٍ من القائمة، وما بعدها من الخادم', () => {
  assert.ok(sheetCode.includes("if (!before && (!category || category === 'all') && primed.current) {"));
  assert.ok(sheetCode.includes('primed.current = null;'));
  assert.ok(sheetCode.includes('return load(before, category);'), '«تحميل المزيد» وتبديل القسم من الخادم');
});

test('العميل المضاف دون اتصال لا يُطلب سجلّه — رسالةٌ بدل 404', () => {
  assert.ok(sheetCode.includes("const local = !id || id.startsWith('local-') || customer?._offline === true;"));
  assert.match(sheetCode, /useEffect\(\(\) => \{\n\s*if \(local\) return;/, 'الجلب لا يجري للعميل المحلي');
});

// ═══ الترجمة: كل نصٍّ عربي في الورقة له مدخل في القاموس ═══
// (النصوص تمرّ بـtr متغيّرةً من FAILURE_TEXT فلا يلتقطها حارس langs.test.ts — نلتقطها هنا)

test('كل نصٍّ عربي في الورقة مترجَم في strings.ts', () => {
  const dict = read('..', 'i18n', 'strings.ts');
  const have = new Set<string>();
  for (const m of dict.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:\s*\{/gm)) have.add(m[1]);
  const used = new Set<string>();
  for (const m of sheetCode.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) if (/[؀-ۿ]/.test(m[1])) used.add(m[1]);
  assert.ok(used.size >= 10, `عدد النصوص ${used.size} أقلّ من المتوقّع`);
  const missing = [...used].filter((k) => !have.has(k));
  assert.deepEqual(missing, [], 'نصوص بلا ترجمة: ' + missing.join(' | '));
});
