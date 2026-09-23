/**
 * حرّاس نصّية على المصدر — فوترة ZATCA المرحلة الثانية (Z5.6c): شاشة متابعة المستندات وسلوك تطبيق المندوب.
 *
 * كما في `printGuards.test.ts`: ما تحرسه هذه الحرّاس **ينجح** في زمن التنفيذ بلا استثناء يُرمى — شاشةٌ تدخل حزمة كلّ
 * شركة، أو ردّ 202 يُفتح ورقةً ضريبية، أو 426 يترك المندوب في حلقةٍ بلا مخرج. والمكوّنات تعتمد react-query وIndexedDB
 * والكاميرا فلا تُرسَم هنا؛ فالحارس يثبت أنّ موضع الشرط في المصدر لم يختفِ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZATCA_QUEUE_PHRASES } from './docQueue';
import { ZATCA_ISSUE_PHRASES } from './issueOutcome';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('شاشة المتابعة كسولةٌ ومحروسة بنظام الشركة — لا تدخل حزمة من لم يُفعَّل', () => {
  const tab = read('components/zatca/ZatcaPhase2Tab.tsx');
  assert.doesNotMatch(tab, /^import ZatcaDocsPanel/m, 'استيراد ثابت يُدخل الشاشة في حزمة التبويب لكل شركة تفتحه');
  assert.match(tab, /const loadZatcaDocsPanel = \(\) => import\('\.\/ZatcaDocsPanel'\);/);
  assert.match(tab, /const Panel = useMemo\(\(\) => lazy\(loadZatcaDocsPanel\), \[attempt\]\);/, 'إعادة المحاولة بعد فشل التحميل لا تُنشئ مكوّناً كسولاً جديداً');
  // العرض مشروط بالنظام: شركة المرحلة الأولى لا ترى البطاقة أصلاً
  assert.match(tab, /\{ov\.regime === 'PHASE2' && <DocsFollowUpCard \/>\}/);
  // وحاجز الأخطاء يحرسها فلا يُسقط فشلُها التبويبَ ومسوّدة بيانات المنشأة فيه
  const card = tab.indexOf('function DocsFollowUpCard()');
  assert.ok(card > 0);
  const body = tab.slice(card, card + 1600);
  assert.match(body, /<ZatcaTabBoundary onRetry=\{\(\) => setAttempt\(n => n \+ 1\)\}>/);
  assert.ok(body.indexOf('<ZatcaTabBoundary') < body.indexOf('<Panel />'), 'المكوّن الكسول خارج الحاجز');

  // ولا يستوردها أحدٌ استيراداً ثابتاً في أيّ مكان آخر
  const importers = walk(SRC)
    .filter(f => /from '[^']*ZatcaDocsPanel'/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(SRC, f).replace(/\\/g, '/'));
  assert.deepEqual(importers, [], 'استيراد ثابت لشاشة المتابعة خارج التحميل الكسول');
});

test('الشاشة: الإجراءات لمستخدمي الشركة وحدهم، ورسالة الخادم عند الرفض، وحدّ النافذة مقولٌ بعدده', () => {
  const s = read('components/zatca/ZatcaDocsPanel.tsx');
  assert.match(s, /const allowed = useAuthStore\(s => s\.isAdmin\)\(\);/, 'الإجراءات بلا حارس صلاحية');
  assert.match(s, /zatcaQueueRows\(q\.data\?\.rows, \{ allowed \}\)/, 'الصفوف تُبنى بلا تمرير الصلاحية فتظهر أزرارٌ تُردّ 403');
  // الإجراءات الثلاثة التي يفتحها الخادم — لا رابعَ لها في العميل
  assert.match(s, /invoiceApi\.einvoiceRetry : kind === 'withdraw' \? invoiceApi\.einvoiceWithdraw : invoiceApi\.einvoiceReissue/);
  // ولا إجراء إلا عبر الحوار المشترك (لا نداءَ من `onClick` مباشرة)
  assert.match(s, /<ZatcaActionDialog kind=\{ask\.kind\}/);
  assert.match(s, /onClick=\{\(\) => setAsk\(\{ row: r, kind: k \}\)\}/);
  // رسالة الخادم أوّلاً عند الرفض (هي التي تحمل السبب)
  assert.match(s, /toast\.error\(serverMessage\(err\) \?\? tr\('تعذر تنفيذ الإجراء'\)\)/);
  // حدّ البيانات مقولٌ للمستخدم لا مسكوتٌ عنه — ومعه قصُّ النافذة نفسها عند السقف
  assert.match(s, /tr\('العدد عن النافذة المعروضة وحدها لا عن كل مستندات الشركة'\)/);
  assert.match(s, /limit: WINDOW_LIMIT/);
  assert.match(s, /const truncated = \(q\.data\?\.total \?\? 0\) > WINDOW_LIMIT;/, 'العدد الكلّي لا يُقرأ فيُقَصّ الطابور صامتاً');
  assert.match(s, /\{truncated && \(/, 'لا تحذير حين تسقط أقدم المستندات من النافذة');
  // ولا تبني الشاشة رمز مرحلةٍ أولى ولا تطبع ورقة (الطباعة مكانها قوالب المستندات)
  assert.doesNotMatch(s, /buildZatcaQr|QrImage/);
});

test('حوارٌ واحدٌ للإجراء الواحد: جدول الفواتير وشاشة المتابعة على حارسٍ واحد، والكلمة بلغة القارئ', () => {
  const dlg = read('components/zatca/ZatcaActionDialog.tsx');
  // مصدر الحكم واحد، والزرّ معطَّل حتى تُكتب الكلمة التي يطلبها القرار
  assert.match(dlg, /const c = zatcaActionConfirm\(kind\);/);
  assert.match(dlg, /const word = c\.typed === null \? null : tr\(c\.typed\);/, 'كلمة التأكيد غير مترجَمة فلا يكتبها من لا لوحة عربية له');
  assert.match(dlg, /const ready = word === null \|\| typed\.trim\(\) === word \|\| typed\.trim\(\) === c\.typed;/);
  assert.match(dlg, /disabled=\{!ready \|\| busy\}/);
  // الكلمة مكتوبة في متن الحوار لا في اللافتة وحدها
  assert.match(dlg, /\{tr\('اكتب هذه الكلمة للتأكيد'\)\}/);
  assert.match(dlg, /placeholder=\{word\}/);
  assert.match(dlg, /aria-label=\{word\}/);
  // و`tr` بالحقن: قاموس التبويب الكسول لا يُسحب إلى حزمة اللوحة
  assert.doesNotMatch(dlg, /zatcaPhrases/);

  // جدول الفواتير: السحب لا يُنفَّذ من `onClick` مباشرة كما كان — الإبطال النهائي بلا تأكيد
  const page = read('pages/InvoicesPage.tsx');
  assert.match(page, /onClick=\{\(\) => setZatcaAsk\(\{ id: inv\.id, number: inv\.number, kind: k \}\)\}/);
  assert.doesNotMatch(page, /onClick=\{\(\) => zatcaAction\(/, 'إجراءُ الفوترة يُنفَّذ بنقرةٍ واحدة بلا حوار');
  assert.match(page, /<ZatcaActionDialog/);
});

test('المندوب: ردّ 202 يُخرج سند تسليم لا فاتورة ضريبية، وما لا ورقة له يقف عند الرسالة', () => {
  const s = read('rep/RepApp.tsx');
  const post = s.indexOf("const res = await repApi.post('/invoices', payload);");
  assert.ok(post > 0, 'نداء الإصدار لم يعد بهذا الشكل — راجع الحارس');
  const guard = s.indexOf('if (res.status !== 201) {', post);
  const tail = s.slice(guard, guard + 1400);
  assert.ok(guard > post, 'حارس حالة الردّ اختفى');
  assert.match(tail, /const pendingMsg = tr\('صدرت الفاتورة وبانتظار اعتماد الهيئة لا تسلم فاتورة ضريبية الآن'\);/);
  assert.match(tail, /const out = zatcaIssueOutcome\(res, pendingMsg\);/);
  // لا ورقة إلا لسند التسليم، والقرار هو الذي يقولها
  assert.match(tail, /if \(out\.kind !== 'deliveryNote'\) return;/);
  assert.ok(tail.indexOf("if (out.kind !== 'deliveryNote') return;") < tail.indexOf('onDone({'), 'الورقة تُفتح قبل التحقّق من نوع القرار');
  // وورقة التسليم تحمل عرض المستند (وهو ما يُخفي الضريبة والرمز ويغيّر العنوان)
  assert.match(tail, /zatca: out\.view,/);
});

test('المندوب: 426 يُعرض معه زرّ تحديثٍ يُلغي عامل الخدمة — في الإصدار وفي فتح المستند', () => {
  const s = read('rep/RepApp.tsx');
  assert.match(s, /if \(isZatcaOutdatedClient\(err\)\) setNeedsUpdate\(true\);/, 'مسار الإصدار بلا كشفٍ للحزمة القديمة');
  assert.match(s, /setOpenOutdated\(isZatcaOutdatedClient\(err\)\);/, 'فتح المستند بلا كشفٍ للحزمة القديمة');
  const calls = s.match(/zatcaReloadForUpdate\(\{ sw: navigator\.serviceWorker \?\? null, reload: \(\) => window\.location\.reload\(\) \}\)/g);
  assert.equal(calls?.length, 2, 'زرّ التحديث ناقصٌ في أحد الموضعين');
  assert.match(s, /\{tr\('تحديث التطبيق وإعادة الفتح'\)\}/);
});

test('المندوب: منع الإصدار دون اتصال يُقال في السلّة، وحال الصفّ الصادر مشروحة', () => {
  const s = read('rep/RepApp.tsx');
  // الحارس في submit (يحرسه printGuards) والإخبار المسبق في السلّة
  assert.match(s, /\{zatcaPhase2 && !online && \(/, 'لا لافتة انقطاعٍ قبل ملء السلّة');
  assert.match(s, /const \[online, setOnline\] = useState\(\(\) => navigator\.onLine\);/);
  assert.match(s, /window\.addEventListener\('offline', down\);/, 'الحالة لا تتحدّث عند انقطاع الشبكة');
  // شرح «قيد مراجعة الإدارة» في لوحة العمل دون اتصال (Z5.0 كانت وسماً بلا تفسير)
  assert.match(s, /\{docs\.some\(underCutoverReview\) && \(/);
  assert.match(s, /tr\('مستندات صدرت دون اتصال قبل تفعيل الفوترة الإلكترونية محجوزة لمراجعة الإدارة ولن تضيع ولا يلزمك شيء'\)/);
});

test('كل نصّ تُنتجه شاشة المتابعة أو مسار الإصدار مترجَمٌ بأربع لغات في أحد القاموسين بلا تكرار', () => {
  const general = read('i18n/strings.ts');
  const tabDict = read('components/zatca/zatcaPhrases.ts');
  const entry = (src: string, p: string): string | null => {
    const at = src.indexOf(`\n  '${p}': {`);
    return at < 0 ? null : src.slice(at + 1, src.indexOf('\n', at + 1));
  };
  for (const p of new Set([...ZATCA_QUEUE_PHRASES, ...ZATCA_ISSUE_PHRASES])) {
    const inGeneral = entry(general, p);
    const inTab = entry(tabDict, p);
    assert.ok(inGeneral || inTab, `نصّ غير مترجم في أيّ قاموس: ${p}`);
    // تكرار المفتاح في القاموسين يجعل الترجمتين تنزلقان (وzatcaLogic.test يمنعه أصلاً)
    assert.ok(!(inGeneral && inTab), `«${p}» مكرّر في القاموسين`);
    for (const lang of ['en', 'fr', 'tr', 'zh']) {
      assert.match((inGeneral ?? inTab) as string, new RegExp(`\\b${lang}: '`), `${p} بلا ${lang}`);
    }
  }
  // نصوص الشاشة الكسولة لا تُحشر في حزمة الدخول: ما لم يكن مشتركاً مع اللوحة مكانه zatcaPhrases
  assert.ok(entry(tabDict, 'متابعة المستندات الضريبية'), 'عنوان الشاشة خارج قاموس التبويب الكسول');
  // ونصّ المندوب (حزمة أخرى لا تحمّل قاموس التبويب) في القاموس العامّ
  assert.ok(entry(general, 'تحديث التطبيق وإعادة الفتح'), 'نصّ تطبيق المندوب خارج القاموس العامّ');
});
