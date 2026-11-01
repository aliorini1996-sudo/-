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

test('PrintDeviceTools وRepDocuments يستوردان printerForJob وdirectPrintAvailable من transport/direct — لا من btSerial', () => {
  for (const f of ['components/print/PrintDeviceTools.tsx', 'rep/RepDocuments.tsx']) {
    const s = read(f);
    const imp = /import \{([^}]*)\} from '(?:\.\.\/)+lib\/print\/transport\/direct';/.exec(s);
    assert.ok(imp, `${f}: لا استيراد من transport/direct`);
    for (const name of ['printerForJob', 'directPrintAvailable']) assert.match(imp[1], new RegExp(`\\b${name}\\b`), `${f}: ${name}`);
    assert.doesNotMatch(s, /from '[./]*lib\/print\/transport\/btSerial'/, `${f} يستورد btSerial`);
  }
  // والنقل نفسه: مسار التطبيق قبل Web Serial في send() — والبايتات نفسها
  const pd = read('rep/printDirect.ts');
  const send = pd.slice(pd.indexOf('async function send('), pd.indexOf('async function settleFrame('));
  assert.ok(send.indexOf('if (isAppLink(port)) return sendViaApp(') > 0 && send.indexOf('if (isAppLink(port))') < send.indexOf('return sendJob(port, job,'));
  assert.match(send, /bytes: job\.bytes, marks: job\.marks, cancel,/);
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
  assert.match(result, /if \(e\.kind === 'appUpdate'\) setAppPrompt\('hard'\);/);
});

test('appBridge.ts: إسنادٌ واحد لـlocation.href ولا إعادة تحميل ولا تبديل ولا رابط بديل', () => {
  const s = read('lib/print/transport/appBridge.ts');
  assert.equal(s.split('location.href =').length - 1, 1);
  assert.doesNotMatch(s, /reload|assign\(|replace\(|browser_fallback_url/);
  assert.doesNotMatch(s, /market:\/\//);
});

test('AppUpdatePrompt.tsx: رابط Google Play في نافذةٍ جديدة — بلا market:// ولا رمز QR ولا طباعة', () => {
  const s = read('components/print/AppUpdatePrompt.tsx');
  assert.match(s, /<a href=\{PLAY_STORE_URL\} target="_blank" rel="noopener noreferrer"/);
  assert.match(s, /import \{ PLAY_STORE_URL \} from '\.\.\/\.\.\/lib\/print\/transport\/bridgeContract';/);
  assert.doesNotMatch(s, /market:|QRCode|buildZatcaQr|toDataURL|printWith\(/);
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
  assert.match(s, /fallback: true, app: e\.kind === 'appUpdate' \? 'hard' : undefined \}/);
  assert.match(s, /app: e instanceof DirectPrintError && e\.kind === 'appUpdate' \? 'hard' : undefined,/);
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
  assert.match(rd, /import \{ directPrintAvailable, onLateHandoff, printerForJob \} from '\.\.\/lib\/print\/transport\/direct';/);
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

test('الخيار المعطّل على أندرويد يلمّح للتحديث القادم بلا سبب تقني، والنصّ القديم لغير أندرويد وحده', () => {
  const s = read('components/print/PrintDeviceTools.tsx');
  assert.ok(s.includes("available ? tr('يرسل للطابعة مباشرة بلا تطبيق وسيط') : directOnAndroid() ? tr('تصل مع التحديث القادم لتطبيق فيلد سيلز') : tr('الطباعة المباشرة تتطلب Chrome 138 أو أحدث')"));
});
