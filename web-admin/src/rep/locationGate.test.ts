import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * «اشتراط تفعيل الموقع» — قفل صفحة العميل (أمر المالك، ٧ أكتوبر ٢٠٢٦، بعد التراجع عن القفل الكامل): المندوب المقيَّد يدخل التطبيق
 * ويستعمله، ولا يدخل صفحة أي عميل ما لم يكن موقعه مفعّلاً ومحدَّداً بدقّة وهو متصل وظاهرٌ على الخريطة. حرّاسٌ ثابتة على توصيل الحاجز في RepApp والإعدادات؛ والحكم الصرف في
 * liveGate.test.ts.
 */
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('حارس ثابت: الحاجز على صفحة العميل وحدها، يُفحص فوراً عند دخولها، والرجوع تحته يخرج منها، ويجدّد القيد', () => {
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /const locationRequired = user\?\.requireLocationOn === true;/, 'القيد يُقرأ بـ=== true');
  assert.match(app, /const \{ ok: liveOk, block: liveBlock, check: checkLocation \} = useLocationGate\(!!token && locationRequired\);/);
  assert.match(app, /const customerScope = customerScopeOpen\(\{ modal, docOpen: docResult !== null, docBack \}\);/);
  assert.match(app, /if \(locationRequired && customerScope\) void checkLocation\(\);/);
  // يحجب صفحة العميل ما لم يكن الحكم «حيّ» — وخارجها لا حاجز (بقية التطبيق متاحة)
  assert.match(app, /const gateShown = !!token && !!user && locationRequired && customerScope && !liveOk;/);
  assert.doesNotMatch(app, /locationStatus === 'off'/);
  assert.match(app, /\{gateShown && <LocationOffGate block=\{liveBlock \?\? 'locating'\} onRetry=\{async \(\) => \{ await refreshUser\(\); return checkLocation\(\); \}\} onExit=\{exitCustomerScope\}\s*visitActive=/);
  // «رجوع» وزرّ الجهاز تحته يخرجان من صفحة العميل كلها (الملف ونوافذه ومستنده) — والزيارة الجارية تُنهى ولا تضيع
  assert.match(app, /useBackClose\(gateShown, \(\) => exitCustomerScope\(\)\);/);
  const exit = app.slice(app.indexOf('const exitCustomerScope = useCallback('), app.indexOf('}, [closeCustomerDetail]);'));
  assert.match(exit, /setDocResult\(null\);\s*setDocBack\(null\);\s*setAiPrefill\(null\);\s*closeCustomerDetail\(\);/);
  const gateFn = app.slice(app.indexOf('function LocationOffGate('), app.indexOf('function GeoGate('));
  assert.match(gateFn, /<button onClick=\{onExit\}[^>]*>\s*\{tr\('رجوع'\)\}/);
  assert.match(gateFn, /tr\('لا تدخل صفحة اي عميل حتى يكون موقعك مفعلا ومحددا بدقة وانت متصل وظاهر على الخريطة — وبقية التطبيق متاحة لك'\)/);
  const gate = app.slice(app.indexOf('function LocationOffGate('), app.indexOf('function GeoGate('));
  assert.match(gate, /className="absolute inset-0 z-\[1300\]/, 'الحاجز يعلو كل طبقة (ماسح الباركود z-70، عارض الصور z-1200)');
  // ولا طبقة في تطبيق المندوب تعلوه
  for (const f of ['RepApp.tsx', 'RepDocuments.tsx', 'BarcodeScanner.tsx', 'RepAiScreen.tsx', 'RepRouteScreen.tsx', 'RepDailyReport.tsx']) {
    for (const m of read('rep', f).matchAll(/\bz-\[(\d+)\]/g)) assert.ok(Number(m[1]) <= 1300, `${f}: z-[${m[1]}] فوق الحاجز`);
  }
  // طبقة الحاجز تُدفع فوق طبقات صفحة العميل — وهذه لا تُسحب تحته (يبقى ترتيبها مع أوراقها الداخلية بعد انقطاعٍ لحظي)
  for (const m of ["useBackClose(modal === 'customerDetail', closeCustomerDetail);", 'useBackClose(!!docResult, closeDocResult);']) {
    assert.ok(app.includes(m), m);
  }
  assert.doesNotMatch(app, /useBackClose\(!gateShown && (!!docResult|modal ===)/);
  // زيارةٌ جارية تحت الحاجز: يُقال قبل الضغط إن «رجوع» ينهيها
  assert.match(app, /visitActive=\{!!visitTimer && !!selectedCustomer && visitTimer\.customerId === selectedCustomer\.id\} \/>\}/);
  assert.match(gateFn, /\{visitActive && <p[^>]*>\{tr\('رجوع ينهي زيارتك الجارية لهذا العميل الآن وتسجل حين يعود موقعك'\)\}/);
  // والزيارة المنتظرة بسبب الموقع يقول شريطها ذلك لا «الاتصال»
  assert.match(app, /v\.waitFor === 'location'\)\s*\? tr\('الزيارة بانتظار تفعيل موقعك لتسجيلها'\) : tr\('الزيارة بانتظار الاتصال لتسجيلها'\)/);
  // لا حقلَ مُركَّز تحت الحاجز (لوحة المفاتيح لا تكتب في نموذجٍ مغطّى ولا «إدخال» يُرسله)
  assert.match(app, /if \(gateShown && document\.activeElement instanceof HTMLElement\) document\.activeElement\.blur\(\);/);
  // وما تحته خاملٌ (inert) وخفيٌّ عن قارئ الشاشة: لا Tab ولا TalkBack يبلغ زرّاً مغطّى — والغلاف يضمّ كل ما سوى الحاجز
  assert.match(app, /el\.inert = gateShown;/);
  assert.match(app, /if \(gateShown\) el\.setAttribute\('aria-hidden', 'true'\); else el\.removeAttribute\('aria-hidden'\);/);
  const frame = app.slice(app.indexOf('{gateShown && <LocationOffGate'));
  const wrap = frame.indexOf('<div ref={underGateRef} className="contents">');
  assert.ok(wrap > 0, 'الغلاف الخامل بعد الحاجز مباشرة');
  assert.ok(frame.indexOf('<OutboxPanel') > wrap && frame.indexOf('{!token || !user ? (') > wrap, 'الصندوق الصادر والتطبيق كله داخل الغلاف');
  // القيد يتجدّد مع إعدادات الشركة الدورية، وفوراً حين يردّ الخادم القفل
  assert.match(app, /void refreshUser\(\); \/\/ وصلاحيات المندوب وقيوده معها/);
  assert.match(app, /onLiveRefused\(\(\) => \{ void refreshUser\(\); \}\)/);
  // حكم الموقع لا يرثه من يدخل بعده على الجهاز
  assert.match(app.slice(app.indexOf('const logout = async')), /resetLive\(\);/);
});

test('الحاجز يقول أيّ شرطٍ سقط بالضبط — الأربعة بنصوص المالك', () => {
  const app = read('rep', 'RepApp.tsx');
  const texts = app.slice(app.indexOf('const GATE_TEXT'), app.indexOf('function LocationOffGate('));
  assert.match(texts, /off: \{ title: 'الموقع مطفأ'/);
  assert.match(texts, /locating: \{ title: 'جارٍ تحديد موقعك بدقة…'/);
  assert.match(texts, /offline: \{ title: 'لا يوجد اتصال بالإنترنت'/);
  assert.match(texts, /notOnMap: \{ title: 'لم يظهر موقعك على الخريطة بعد'/);
});

test('حارس ثابت: المقيَّد لا يقرأ موقعاً مخبّأً في زيارته (بدءاً وملاحظةً) — والبصمة ليست صفحة عميل: موقعها أفضل جهد ولا تُردّ', () => {
  const app = read('rep', 'RepApp.tsx');
  const grab = app.slice(app.indexOf('async function grabLocation('), app.indexOf('\n}', app.indexOf('async function grabLocation(')));
  assert.match(grab, /if \(strict\) return strictLiveFix\(\);/);
  assert.doesNotMatch(grab, /maximumAge: 120_000/, 'قراءةٌ عمرها دقيقتان كانت تُثبت موقعاً والموقع مطفأ');
  const att = app.slice(app.indexOf('function RepAttendance('), app.indexOf('function', app.indexOf('function RepAttendance(') + 10));
  assert.match(att, /const loc = await grabLocation\(\);/);
  assert.doesNotMatch(att, /locationRequired|strictLiveFix/, 'البصمة لا يشترط لها القيد موقعاً');
  assert.match(app, /<RepAttendance \/>/);
  // الملاحظة: القراءة لحظة الحفظ لا لحظة فتح النافذة
  const lv = app.slice(app.indexOf('function LogVisit('), app.indexOf('function CreateInvoice('));
  assert.match(lv, /const at = strict \? await grabLocation\(true\) : fix;/);
  assert.match(lv, /\.\.\.fixCoords\(at\),/);
  const gate = read('rep', 'locationGate.ts');
  assert.match(gate, /export async function strictLiveFix\(\): Promise<GeoFix \| null> \{\s*const r = await ensureLive\(\);/);
});

test('حارس ثابت: المراقبة بلا مهلة وبلا مخبّأ، ونقطة كل ٣٠ث، والحكم يُعاد كل ٥ث', () => {
  const g = read('rep', 'locationGate.ts');
  assert.match(g, /watchPosition\([\s\S]*?\{ enableHighAccuracy: true, maximumAge: 0 \},\s*\);/);
  assert.match(g, /window\.setInterval\(recompute, LIVE_TICK_MS\)/);
  assert.match(g, /window\.setInterval\(\(\) => \{ if \(!document\.hidden\) void run\(true\); \}, LIVE_KEEPALIVE_MS\)/);
  assert.match(g, /const d = liveDecision\(liveSnapshot\(\), Date\.now\(\)\);/);
  // يبدأ محجوباً («جارٍ الفحص» يحجب) حتى يثبت الحكم
  assert.match(g, /useState<LiveDecision>\(\{ ok: false, block: 'locating' \}\)/);
  const api = read('rep', 'repApi.ts');
  assert.match(api, /\{ enableHighAccuracy: true, maximumAge: 0, timeout: LIVE_FIX_TIMEOUT_MS \}/, 'القراءة الطازجة لا تقبل مخبّأً');
});

test('حارس ثابت: المقيَّد مُتتبَّعٌ دائماً ولو أُطفئ التتبّع للشركة', () => {
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /const trackStatus = useRepTracking\(!!token && !!user, locationRequired\);/);
  const t = read('rep', 'useRepTracking.ts');
  assert.match(t, /export function useRepTracking\(active: boolean, forced = false\): TrackStatus \{/);
  assert.match(t, /let enabled = forced;\s*if \(!enabled\) \{/);
  assert.match(t, /\}, \[active, forced\]\);/);
});

test('حارس ثابت: القيد في نافذة المندوب بلوحة الإدارة وفي تطبيق الجوال، و«تحديد الكل» لا يمسّه — والتلميح يقول قفل صفحة العميل', () => {
  const modal = read('components', 'forms', 'SalesRepModal.tsx');
  assert.match(modal, /register\('requireLocationOn'\)/);
  assert.match(modal, /requireLocationOn: false,/, 'افتراض المندوب الجديد مطفأ');
  const m = read('m', 'MSalesReps.tsx');
  assert.match(m, /type PermKey = Grant \| 'requireCustomerProximity' \| 'requireLocationOn';/);
  assert.match(m, /requireLocationOn: false,/);
  assert.match(m, /onChange=\{v => set\('requireLocationOn', v\)\}/);
  const grants = m.slice(m.indexOf('const GRANTS = ['), m.indexOf('] as const;', m.indexOf('const GRANTS = [')));
  assert.doesNotMatch(grants, /requireLocationOn/, 'قيدٌ يسلب لا يُقلب مع «تحديد الكل»');
  const HINT = 'عند التفعيل لا يدخل المندوب صفحة اي عميل — ولا يصدر له فاتورة ولا سندا ولا يسجل زيارة ولا يضيف عميلا — الا والموقع مفعل في جواله ومحدد بدقة وهو متصل بالإنترنت وظاهر على الخريطة، وبقية التطبيق متاحة له، ويرسل موقعه للخريطة ولو كان التتبع متوقفا للشركة';
  assert.ok(modal.includes(`tr('${HINT}')`), 'تلميح لوحة الإدارة');
  assert.ok(m.includes(`tr('${HINT}')`), 'تلميح تطبيق الإدارة');
  assert.ok(read('i18n', 'strings.ts').includes(`'${HINT}': { en:`), 'التلميح مترجم');
  // صفحتا التتبّع تقولان إن موقع المقيَّد يُرسل رغم إيقاف التتبّع
  const NOTE = "tr('المندوب المقيد باشتراط تفعيل الموقع يرسل موقعه دائما ولو كان التتبع متوقفا فعل التتبع لتراه على الخريطة')";
  assert.ok(read('pages', 'TrackingPage.tsx').includes(NOTE));
  assert.ok(read('m', 'MTracking.tsx').includes(NOTE));
});
