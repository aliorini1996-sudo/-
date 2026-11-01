// «الطباعة في كل حال» (قرار المالك ١ نوفمبر ٢٠٢٦) — حرّاسٌ نصّية على المصدر: الواجهات تمرّ بالموزّع (transport/direct) لا
// بـbtSerial مباشرةً فيُفعَّل «بلوتوث مباشر» على أندرويد؛ ودعوة التحديث في كتلة الطباعة؛ والجسر لا يغادر الصفحة ولا يعيدها؛
// ولا سبب تقنيّاً (اسم متصفح أو Web Serial أو WebView) في أيّ نصٍّ جديد يراه المندوب؛ وكل رسالةٍ مترجمة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIRECT_PRINT_MESSAGES } from '../lib/print/printErrors';
import { PHRASES } from '../i18n/strings';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const TECH = /Chrome|Samsung|WebView|Serial/i;

test('PrintDeviceTools وRepDocuments يستوردان printerForJob من transport/direct وdirectAvailableFor من printDirect — لا من btSerial', () => {
  for (const f of ['components/print/PrintDeviceTools.tsx', 'rep/RepDocuments.tsx']) {
    const s = read(f);
    const imp = /import \{([^}]*)\} from '(?:\.\.\/)+lib\/print\/transport\/direct';/.exec(s);
    assert.ok(imp, `${f}: لا استيراد من transport/direct`);
    assert.match(imp[1], /\bprinterForJob\b/, `${f}: printerForJob`);
    // التوفّر لكل قالب (النقطية لا تُرسل من تطبيق الآيفون) — لا directPrintAvailable للجهاز كلّه
    const pdImp = /import \{([^}]*)\} from '(?:\.\/|(?:\.\.\/)+rep\/)printDirect';/.exec(s);
    assert.ok(pdImp, `${f}: لا استيراد من printDirect`);
    assert.match(pdImp[1], /\bdirectAvailableFor\b/, `${f}: directAvailableFor`);
    assert.doesNotMatch(s, /directPrintAvailable\(/, `${f}: directPrintAvailable`);
    assert.doesNotMatch(s, /from '[./]*lib\/print\/transport\/btSerial'/, `${f} يستورد btSerial`);
  }
  // والنقل نفسه: مسار الآيفون ثم مسار أندرويد قبل Web Serial في send() — والبايتات نفسها
  const pd = read('rep/printDirect.ts');
  const send = pd.slice(pd.indexOf('async function send('), pd.indexOf('async function settleFrame('));
  assert.ok(send.indexOf('if (isAppLink(port)) return sendViaApp(') > 0 && send.indexOf('if (isAppLink(port))') < send.indexOf('return sendJob(port, job,'));
  assert.ok(send.indexOf('if (isIosLink(port)) return sendViaIos(') > 0 && send.indexOf('if (isIosLink(port))') < send.indexOf('return sendJob(port, job,'));
  assert.equal((send.match(/bytes: job\.bytes, marks: job\.marks, cancel, slow: !!ui\.slow, label: ui\.docLabel \?\? ''/g) || []).length, 2);
});

test('RepDocuments: دعوة التحديث داخل كتلة الطباعة المباشرة قبل {zBlocked ? (، والوسم عنوان المستند', () => {
  const s = read('rep/RepDocuments.tsx');
  const result = s.slice(s.indexOf('export function DocumentResult('));
  const start = result.indexOf('{canDirect && directProfile && (');
  const end = result.indexOf('{zBlocked ? (');
  assert.ok(start > 0 && end > start);
  const block = result.slice(start, end);
  assert.match(block, /\{appPrompt === 'hard' \? <AppUpdateButton \/> : <p className="mt-1 text-red-700\/80">\{tr\(DIRECT_PRINT_FALLBACK\)\}<\/p>\}/);
  assert.match(block, /\{appPrompt === 'soft' && <AppUpdateHint \/>\}/);
  for (const name of ['<AppUpdateButton', '<AppUpdateHint']) {
    assert.equal(result.split(name).length - 1, 1, `${name} مرّة واحدة`);
    assert.ok(block.includes(name), `${name} خارج الكتلة`);
  }
  assert.equal((result.match(/\{ \.\.\.directOpts\(deviceChoice\), label: title \}/g) || []).length, 2);
  assert.match(result, /if \(sent\.outcome === 'handed'\) setAppPrompt\('soft'\);/);
  assert.match(result, /if \(e\.kind === 'appUpdate' \|\| e\.kind === 'appUpdateIos'\) setAppPrompt\('hard'\);/);
});

test('appBridge.ts: إسنادٌ واحد لـlocation.href ولا إعادة تحميل ولا تبديل ولا رابط بديل', () => {
  const s = read('lib/print/transport/appBridge.ts');
  assert.equal(s.split('location.href =').length - 1, 1);
  assert.doesNotMatch(s, /reload|assign\(|replace\(|browser_fallback_url/);
  assert.doesNotMatch(s, /market:\/\//);
});

test('AppUpdatePrompt.tsx: رابط المتجر في نافذةٍ جديدة (Google Play، وApp Store على الآيفون) — بلا market:// ولا itms-apps ولا رمز QR ولا طباعة', () => {
  const s = read('components/print/AppUpdatePrompt.tsx');
  assert.match(s, /<a href=\{storeUrl\} target="_blank" rel="noopener noreferrer"/);
  assert.match(s, /const storeUrl = classifyPrintPlatform\(currentPlatformInput\(\)\)\.os === 'ios' \? APP_STORE_URL : PLAY_STORE_URL;/);
  assert.match(s, /import \{ APP_STORE_URL, PLAY_STORE_URL \} from '\.\.\/\.\.\/lib\/print\/transport\/bridgeContract';/);
  assert.doesNotMatch(s, /market:|itms-apps:|QRCode|buildZatcaQr|toDataURL|printWith\(/);
});

test('main.tsx يلتقط علامة الجسر قبل ReactDOM.createRoot', () => {
  const s = read('main.tsx');
  assert.match(s, /import \{ captureBridgeLaunch \} from '\.\/lib\/print\/transport\/appBridge';/);
  const call = s.indexOf('\ncaptureBridgeLaunch();');
  assert.ok(call > 0 && call < s.indexOf('ReactDOM.createRoot('), 'الالتقاط بعد أوّل رسم');
});

test('لا سبب تقنيّاً في نصوص أندرويد الجديدة: رسالتا appUpdate وtooLarge ونصوص AppUpdatePrompt وDirectPrintUi', () => {
  assert.doesNotMatch(DIRECT_PRINT_MESSAGES.appUpdate, TECH);
  assert.doesNotMatch(DIRECT_PRINT_MESSAGES.tooLarge, TECH);
  for (const f of ['components/print/AppUpdatePrompt.tsx', 'components/print/DirectPrintUi.tsx']) {
    const lits = [...read(f).matchAll(/tr\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(lits.length > 0, f);
    for (const l of lits) assert.doesNotMatch(l, TECH, `${f}: ${l}`);
  }
});

test('كل رسالة طباعةٍ مباشرة لها ترجمة بأربع لغات — وبلا فاصلة عليا في الفرنسية', () => {
  for (const [kind, ar] of Object.entries(DIRECT_PRINT_MESSAGES)) {
    const p = PHRASES[ar];
    assert.ok(p, `${kind}: لا ترجمة`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(p[lang] && p[lang].trim(), `${kind}.${lang}`);
    assert.ok(!/['’]/.test(p.fr), `${kind}.fr فيه فاصلة عليا`);
  }
  for (const ar of ['تحديث التطبيق', 'إن لم تطبع الورقة فحدث تطبيق فيلد سيلز من Google Play', 'الطباعة جاهزة', 'اطبع الآن']) {
    assert.ok(PHRASES[ar], ar);
    assert.ok(!/['’]/.test(PHRASES[ar].fr), ar);
  }
});

test('PrintDeviceTools: التسليم بلا مفتاح ⇒ تلميح التحديث لا علامة نجاح، وappUpdate ⇒ زرّ التحديث مكان البديل، ومسار التطبيق زرّ ربطٍ واحد', () => {
  const s = read('components/print/PrintDeviceTools.tsx');
  assert.match(s, /const appPath = directPath\(\) === 'app';/);
  assert.match(s, /if \(port && r === 'handed'\) setMsg\(\{ tone: 'ok', text: '', app: 'soft' \}\);\n\s*else if \(port\) setMsg\(/);
  assert.match(s, /fallback: true, app: e\.kind === 'appUpdate' \|\| e\.kind === 'appUpdateIos' \? 'hard' : undefined \}/);
  assert.match(s, /app: e instanceof DirectPrintError && \(e\.kind === 'appUpdate' \|\| e\.kind === 'appUpdateIos'\) \? 'hard' : undefined,/);
  assert.match(s, /\{msg && msg\.app === 'soft' && <AppUpdateHint \/>\}\n\s*\{msg && msg\.app !== 'soft' && \(/);
  assert.match(s, /\{msg\.app === 'hard' \? <AppUpdateButton \/> : <p className="mt-1 text-\[#6E6557\]">\{tr\(DIRECT_PRINT_FALLBACK\)\}<\/p>\}/);
  assert.match(s, /\{msg\.app === 'hard' && !msg\.fallback && <AppUpdateButton \/>\}/);
  // «ربط الطابعة»: 'linked' وحده يُعلن الربط — التطبيق يختار طابعته في شاشته
  assert.match(s, /const r = await linkPrinter\(\);\n\s*if \(r === 'linked'\) \{/);
  assert.match(s, /\{appPath \? \(\n\s*<button type="button" onClick=\{link\}[^\n]*\{tr\('ربط الطابعة'\)\}<\/button>\n\s*\) : \(/);
});

test('DirectPrintUi: لمسة «اطبع الآن» تُحلّ داخل النقرة والإلغاء يرفضها، ومرحلة التسليم بلا زرّ إلغاء', () => {
  const s = read('components/print/DirectPrintUi.tsx');
  assert.match(s, /c\.signal\.addEventListener\('abort', onAbort, \{ once: true \}\);/);
  assert.match(s, /onTap: \(\) => \{ c\.signal\.removeEventListener\('abort', onAbort\); resolve\(\); \}/);
  assert.match(s, /if \(c\.signal\.aborted\) \{ reject\(new Error\('cancelled'\)\); return; \}/);
  assert.match(s, /onHandoff: \(\) => \{ last\.current = 'handoff'; setJob\(\{ phase: 'handoff', pct: 100 \}\); \}/);
  assert.match(s, /docLabel: opts\?\.label,/);
  // زرّ الإلغاء: الغطاء الأصليّ ولمسة «اطبع الآن» — لا في «جار الإرسال إلى الطابعة» (التطبيق يحمل الإلغاء بعده)
  assert.equal(s.split('onClick={onCancel}').length - 1, 2);
  const handoff = s.slice(s.indexOf("if (job.phase === 'tap' || job.phase === 'handoff') {"));
  const bar = handoff.slice(handoff.indexOf(') : ('), handoff.indexOf('</div>\n      </div>\n    );'));
  assert.doesNotMatch(bar, /onCancel|%/, 'لا إلغاء ولا نسبة في التسليم');
});

test('التسليم المتأخّر يستبدل دعوة التحديث بحصيلته — في المستند وفي أدوات الطباعة، والاشتراك ما دامت الدعوة معروضة', () => {
  const rd = read('rep/RepDocuments.tsx');
  assert.match(rd, /import \{ onLateHandoff, printerForJob \} from '\.\.\/lib\/print\/transport\/direct';/);
  assert.match(rd, /useEffect\(\(\) => \{\n\s*if \(appPrompt !== 'hard'\) return undefined;\n\s*return onLateHandoff\(\(outcome\) => \{\n\s*setDirectError\(null\);\n\s*setAppPrompt\(outcome === 'handed' \? 'soft' : null\);\n\s*if \(outcome === 'done'\) setStatus\(tr\('✓ تم الإرسال إلى الطابعة'\)\);\n\s*\}\);\n\s*\}, \[appPrompt, tr\]\);/);
  const pt = read('components/print/PrintDeviceTools.tsx');
  assert.match(pt, /const appHard = msg\?\.app === 'hard';\n\s*useEffect\(\(\) => \{\n\s*if \(!appHard\) return undefined;\n\s*return onLateHandoff\(/);
  assert.match(pt, /if \(m\?\.app !== 'hard'\) return m;\n\s*if \(!m\.fallback\) return null;\n\s*return outcome === 'done' \? \{ tone: 'ok', text: tr\('✓ تم الإرسال إلى الطابعة'\) \} : \{ tone: 'ok', text: '', app: 'soft' \};/);
  assert.match(pt, /\}, \[appHard, tr\]\);/);
});

test('appBridge.ts: WebView وحده يفتح من إطارٍ مخفيّ — والإطار الأعلى لغيره', () => {
  const s = read('lib/print/transport/appBridge.ts');
  assert.match(s, /frame: isAndroidWebView\(navigator\.userAgent\) \? hiddenFrame : null,/);
  assert.ok(s.includes('return /; wv\\)/.test(ua);'), 'وسم WebView');
  assert.match(s, /if \(env\.frame\) \{[\s\S]*?\} else \{\n\s*env\.win\.location\.href = url;\n\s*\}/);
});

test('الخيار المعطّل يلمّح بلا سبب تقني على الجوال (أندرويد والآيفون) — ونصّ المتصفح القديم لسطح المكتب وحده (directHint)', () => {
  const s = read('components/print/PrintDeviceTools.tsx');
  assert.ok(s.includes("available ? tr('يرسل للطابعة مباشرة بلا تطبيق وسيط') : directHintText()"));
  assert.match(s, /const hint = directHintFor\(profile\);/);
  const sw = s.slice(s.indexOf('const directHintText = (): string => {'), s.indexOf('const radio = ('));
  assert.ok(sw.length > 0);
  assert.ok(sw.includes("case 'soon': return tr('تصل مع التحديث القادم لتطبيق فيلد سيلز');"));
  assert.ok(sw.includes("case 'updateIos': return tr('حدث تطبيق فيلد سيلز من App Store لتفعيلها');"));
  assert.ok(sw.includes("case 'iosApp': return tr('متاحة في تطبيق فيلد سيلز على الآيفون');"));
  assert.ok(sw.includes("case 'impactIos': return tr('الطابعة النقطية لا تطبع من الآيفون — اطبعها من جوال أندرويد أو شارك ملف PDF');"));
  // «Chrome 138» في الفرع الافتراضي وحده ('browser' = سطح المكتب — مصفوفة directHint في platform.test.ts)
  assert.equal(s.split('Chrome 138').length - 1, 1);
  assert.ok(sw.includes("default: return tr('الطباعة المباشرة تتطلب Chrome 138 أو أحدث');"));
  const mobile = [...sw.matchAll(/case '(?:soon|updateIos|iosApp|impactIos)': return tr\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(mobile.length, 4);
  for (const l of mobile) {
    assert.doesNotMatch(l, TECH, l);
    assert.ok(PHRASES[l] && !/['’]/.test(PHRASES[l].fr), l);
  }
  // دعوة التحديث تحت الخيارين بعد نشر الآيفون (1.0)، وتلميح الإقران على الآيفون: من شاشة التطبيق لا من الإعدادات
  assert.ok(s.includes("{!available && hint === 'updateIos' && <AppUpdateButton />}"));
  assert.ok(s.includes("{iosPath ? tr('شغل الطابعة وقربها من الجوال ثم اضغط ربط الطابعة — لا تقرنها من إعدادات البلوتوث في الآيفون') : tr('اقرن الطابعة أولا من إعدادات البلوتوث في الجوال')}"));
});

test('تطبيق الآيفون في أدوات الطباعة: كتلة الربط كـWeb Serial باسم الطابعة، وإغلاق شاشة الاختيار بلا رسالة، ولا تقفل الشاشة أثناء الإرسال', () => {
  const s = read('components/print/PrintDeviceTools.tsx');
  assert.match(s, /const iosPath = directPath\(\) === 'ios-app';/);
  assert.match(s, /const available = directAvailableFor\(profile\);/);
  assert.ok(s.includes("{linked ? (linkedName ? `${tr('الطابعة مربوطة')}: ${linkedName}` : tr('الطابعة مربوطة')) : tr('لم تربط طابعة بعد')}"));
  assert.match(s, /if \(iosPath && e instanceof DirectPrintError && e\.kind === 'pickPrinter'\) return;/);
  const ui = read('components/print/DirectPrintUi.tsx');
  assert.ok(ui.includes("{sending && directOnIos() && <p className=\"text-xs text-[#6E6557] mt-1\">{tr('لا تقفل الشاشة حتى تنتهي الطباعة')}</p>}"));
  // «نظام الطباعة» في تطبيق الآيفون: قبل إنشاء الإطار في المسارات الثلاثة
  const page = read('rep/printPage.ts');
  for (const fn of ['export async function printPageNode(', 'export async function printHtmlDocument(']) {
    const body = page.slice(page.indexOf(fn));
    assert.ok(body.indexOf('if (iosSystemPrintAvailable())') > 0 && body.indexOf('if (iosSystemPrintAvailable())') < body.indexOf("document.createElement('iframe')"), fn);
  }
  const th = read('rep/thermal.ts');
  const ph = th.slice(th.indexOf('function printHTML('));
  assert.ok(ph.indexOf('if (iosSystemPrintAvailable()) return iosSystemPrint(html, geom.paperWidthMm, \'\');') > 0);
  assert.ok(ph.indexOf('if (iosSystemPrintAvailable())') < ph.indexOf("document.createElement('iframe')"));
  assert.equal(th.split('await classicOut(opts, `').length - 1, 2, 'تعذّر الآيفون يصل الشاشة من الشريط الكلاسيكي');
});
