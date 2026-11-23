import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IDLE_GRACE_DEFAULT, IDLE_MINUTES_DEFAULT, IDLE_REMINDER_KEY, IDLE_STILL_WORKING_PATH, IDLE_NO_OPEN_SHIFT,
  ATTENDANCE_REFRESH_EVENT, AUTO_CHECKOUT_EDITOR, AUTO_CHECKOUT_REASON, humanEditOf, idleClosedKind, idleFieldNum, idleGraceOk,
  idleMinutesOk, idleReminderOf, idleSaveFields, idleSettingsOf, withCount,
} from './idlePunchOut';
import { attendanceDayCells, formatPeriods, periodAutoOut, punchDetailRows, PUNCH_DETAIL_WIDTHS, type WorkDayLike } from './workPeriods';

// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): إعداد المندوب في اللوحة والجوال، و«هل ما زلت تعمل؟»
// في تطبيق المندوب، ووسم «انصراف تلقائي» في التقارير وأوراقها — المنطق الصرف هنا، والربط بحرّاسٍ على المصدر.

const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const MIN = 60_000;

test('الإعداد: الغائب مطفأٌ بـ٤٥/١٥، والقيمة خارج الحدّين تعود للافتراض، والتفعيل بـtrue صريحة', () => {
  assert.deepEqual(idleSettingsOf(undefined), { idlePunchOutEnabled: false, idlePunchOutMinutes: 45, idlePunchOutGraceMinutes: 15 });
  assert.deepEqual(idleSettingsOf({}), { idlePunchOutEnabled: false, idlePunchOutMinutes: IDLE_MINUTES_DEFAULT, idlePunchOutGraceMinutes: IDLE_GRACE_DEFAULT });
  assert.deepEqual(idleSettingsOf({ idlePunchOutEnabled: true, idlePunchOutMinutes: 60, idlePunchOutGraceMinutes: 20 }),
    { idlePunchOutEnabled: true, idlePunchOutMinutes: 60, idlePunchOutGraceMinutes: 20 });
  assert.deepEqual(idleSettingsOf({ idlePunchOutMinutes: 5, idlePunchOutGraceMinutes: 500 }),
    { idlePunchOutEnabled: false, idlePunchOutMinutes: 45, idlePunchOutGraceMinutes: 15 });
  // حدود الخادم نفسها (salesReps.ts ⇒ idleSettingsError): ١٠–٤٨٠ و٥–١٢٠، أعدادٌ صحيحة
  assert.ok(idleMinutesOk(10) && idleMinutesOk(480) && !idleMinutesOk(9) && !idleMinutesOk(481) && !idleMinutesOk(45.5) && !idleMinutesOk(Number.NaN));
  assert.ok(idleGraceOk(5) && idleGraceOk(120) && !idleGraceOk(4) && !idleGraceOk(121) && !idleGraceOk('15'));
  // الحقل الفارغ في الجوال لا يُقرأ «صفر دقيقة»
  assert.ok(Number.isNaN(idleFieldNum('')) && Number.isNaN(idleFieldNum('  ')));
  assert.equal(idleFieldNum('30'), 30);
});

test('جسم الحفظ: المطفأ لا يرسل دقيقتيه (قيمةٌ مخفيةٌ خاطئة لا تردّ الحفظ بـ400)، والمفعّل يرسلهما كما هما', () => {
  assert.deepEqual(idleSaveFields({ name: 'أحمد', idlePunchOutEnabled: false, idlePunchOutMinutes: 3, idlePunchOutGraceMinutes: Number.NaN }),
    { name: 'أحمد', idlePunchOutEnabled: false });
  assert.deepEqual(idleSaveFields<{ name: string; idlePunchOutEnabled?: boolean }>({ name: 'أحمد' }), { name: 'أحمد', idlePunchOutEnabled: false });
  const on = { name: 'أحمد', idlePunchOutEnabled: true, idlePunchOutMinutes: 30, idlePunchOutGraceMinutes: 10 };
  assert.deepEqual(idleSaveFields(on), on);
});

test('التذكير من ردّ الخادم: الغائب لا يغيّر شيئاً، وnull لا تذكير، والمفتاح idlePunchOutReminder', () => {
  const at = '2026-11-23T08:00:00.000Z';
  assert.equal(idleReminderOf({ presence: null }), undefined, 'خادمٌ قبل الميزة');
  assert.equal(idleReminderOf(null), undefined);
  assert.equal(IDLE_REMINDER_KEY, 'idlePunchOutReminder');
  assert.equal(idleReminderOf({ presence: null, idlePunchOutReminder: null }), null);
  assert.equal(idleReminderOf({ idlePunchOutReminder: { remindedAt: 'أمس', idleMinutes: 45, graceMinutes: 15 } }), null, 'لحظةٌ لا تُقرأ ⇒ لا نافذة');
  assert.equal(idleReminderOf({ idle: { remindedAt: at, idleMinutes: 45, graceMinutes: 15 } }), undefined, 'مفتاحٌ غير مفتاح الخادم');
  // serverNow من الخادم لا يُقرأ: لا عدّ تنازليّ في النافذة
  const r = idleReminderOf({ presence: null, idlePunchOutReminder: { remindedAt: at, idleMinutes: 60, graceMinutes: 20, serverNow: Date.parse(at) + 2 * MIN } })!;
  assert.deepEqual(r, { remindedAt: at, idleMinutes: 60, graceMinutes: 20 });
  // أعدادٌ فاسدة ⇒ الافتراض
  assert.deepEqual(idleReminderOf({ idlePunchOutReminder: { remindedAt: at, idleMinutes: 0, graceMinutes: 'x' } }),
    { remindedAt: at, idleMinutes: 45, graceMinutes: 15 });
  assert.equal(withCount('منذ {n} دقيقة', 7), 'منذ 7 دقيقة');
});

test('ردّ «ما زلت أعمل» المرفوض: انصرافٌ تلقائي سبق ⇒ auto، ولا نوبة مفتوحة ⇒ closed، وغيرهما خطأٌ يُعاد فيه الضغط', () => {
  assert.equal(idleClosedKind(409, { code: IDLE_NO_OPEN_SHIFT, autoCheckedOut: true }), 'auto');
  assert.equal(idleClosedKind(409, { code: IDLE_NO_OPEN_SHIFT, autoCheckedOut: false }), 'closed');
  assert.equal(idleClosedKind(409, { code: IDLE_NO_OPEN_SHIFT }), 'closed', 'بلا العَلَم ⇒ لا ادّعاء انصرافٍ تلقائي');
  assert.equal(idleClosedKind(409, { code: 'LOCATION_REQUIRED' }), null);
  assert.equal(idleClosedKind(500, { code: IDLE_NO_OPEN_SHIFT, autoCheckedOut: true }), null);
  assert.equal(idleClosedKind(undefined, undefined), null, 'بلا اتصال');
});

test('التقارير: «انصراف تلقائي» يتبع وقت الانصراف في خلية الفترات وورقة البصمات — لا لفترةٍ مفتوحة ولا ليومٍ بلا بصمة', () => {
  const tr = (s: string) => s;
  const clock = (iso: string) => iso.slice(11, 16);
  const fx = { tr, clock, minutes: (m: number) => `${m}د`, visitDur: () => null };
  const auto = { start: '2026-11-23T05:00:00.000Z', end: '2026-11-23T09:30:00.000Z', source: 'PUNCH' as const, outAuto: true };
  const open = { start: '2026-11-23T11:00:00.000Z', end: null, source: 'PUNCH' as const, outAuto: true };
  assert.ok(periodAutoOut(auto));
  assert.ok(!periodAutoOut(open), 'المفتوحة لا انصراف لها');
  assert.ok(!periodAutoOut({ ...auto, source: 'ACTIVITY' }));
  assert.ok(!periodAutoOut({ ...auto, outAuto: undefined }), 'خادمٌ أقدم');
  assert.equal(formatPeriods([auto, open], clock, 'لم ينصرف'), '05:00 – 09:30 · 11:00 – لم ينصرف', 'بلا الوسم ما لم يُمرَّر');
  assert.equal(formatPeriods([auto, open], clock, 'لم ينصرف', 'انصراف تلقائي'), '05:00 – 09:30 (انصراف تلقائي) · 11:00 – لم ينصرف');
  const day: WorkDayLike & { date: string } = {
    date: '2026-11-23', firstActivity: auto.start, lastActivity: auto.end, absent: false, spanMinutes: 270, appMinutes: 200,
    visitsCount: 0, visitsSec: 0, breakMinutes: 0, periods: [auto],
  };
  assert.equal(attendanceDayCells(day, fx)['فترات العمل'], '05:00 – 09:30 (انصراف تلقائي)');
  const { rows } = punchDetailRows([{ name: 'أحمد', days: [day] }], false, fx);
  assert.equal(rows[0]['الانصراف'], '09:30 (انصراف تلقائي)');
  // عرض الأعمدة لكل عمودٍ في الورقة بترتيبه، و«الانصراف» يتّسع للوسم (لا يُقصّ في Excel)
  const cols = Object.keys(rows[0]);
  assert.equal(PUNCH_DETAIL_WIDTHS.length, cols.length, 'عرضٌ لكل عمود');
  assert.equal(Object.keys(punchDetailRows([{ name: 'أحمد', days: [day] }], true, fx).rows[0]).length, cols.length + 1, 'withRep يسبقها عمود المندوب');
  const outW = PUNCH_DETAIL_WIDTHS[cols.indexOf('الانصراف')];
  assert.ok(outW >= '05:00 PM (Automatic check-out)'.length - 2, `عرض «الانصراف» ${outW}`);
  const reports = read('src', 'pages', 'ReportsPage.tsx');
  assert.match(reports, /colWidths: \[22, \.\.\.PUNCH_DETAIL_WIDTHS\]/);
  assert.match(reports, /colWidths: \[\.\.\.PUNCH_DETAIL_WIDTHS\]/);
  assert.doesNotMatch(reports, /\[22, 12, 10, 42, 10, 42, 12\]|\[12, 10, 42, 10, 42, 12\]/, 'عروضٌ قديمة أقصر من الأعمدة');
  assert.equal(punchDetailRows([{ name: 'أحمد', days: [{ ...day, periods: [{ ...auto, outAuto: undefined }] }] }], false, fx).rows[0]['الانصراف'], '09:30');
});

test('حارس الإعداد: نافذة اللوحة وشاشة الجوال تعرضان المفتاح والدقيقتين تحته وتحفظان بـidleSaveFields', () => {
  const modal = read('src', 'components', 'forms', 'SalesRepModal.tsx');
  assert.match(modal, /<PermToggle label=\{tr\('تذكير بالانصراف عند الخمول ثم انصراف تلقائي'\)\} \{\.\.\.register\('idlePunchOutEnabled'\)\} \/>/);
  assert.match(modal, /\{watch\('idlePunchOutEnabled'\) && \(<>[\s\S]{0,200}register\('idlePunchOutMinutes', idleMinutesRules\)[\s\S]{0,300}register\('idlePunchOutGraceMinutes', idleGraceRules\)/);
  assert.match(modal, /<form onSubmit=\{handleSubmit\(\(d\) => onSave\(idleSaveFields\(d\)\)\)\}/);
  assert.match(modal, /\.\.\.idleSettingsOf\(defaults\),/);
  const m = read('src', 'm', 'MSalesReps.tsx');
  assert.match(m, /<MToggle label=\{tr\('تذكير بالانصراف عند الخمول ثم انصراف تلقائي'\)\}\s*checked=\{idleOn\}/);
  assert.match(m, /\{idleOn && \(<>[\s\S]{0,400}tr\('دقائق الخمول قبل التذكير'\)[\s\S]{0,400}tr\('مهلة الرد قبل الانصراف التلقائي \(دقيقة\)'\)/);
  assert.match(m, /\.\.\.idleSaveFields\(\{ idlePunchOutEnabled: idleOn, idlePunchOutMinutes: idleMinNum, idlePunchOutGraceMinutes: idleGraceNum \}\),/);
  assert.match(m, /disabled=\{!discOk \|\| !proxOk \|\| !punchOk \|\| !idleOk \|\| save\.isPending\}/);
  // قيدٌ تقييديّ: خارج PermKey فلا يقلبه «تحديد الكل»
  assert.doesNotMatch(m.slice(m.indexOf('type PermKey'), m.indexOf(';', m.indexOf('type PermKey'))), /idlePunchOut/);
});

test('حارس تطبيق المندوب: التذكير من ردّ النبضة، والنافذة تُرسل «ما زلت أعمل» وتُحدّث شاشة البصمة، و«انصراف تلقائي» في الشاشة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /useEffect\(\(\) => onHeartbeat\(\(d\) => \{\s*const r = idleReminderOf\(d\);/);
  assert.match(app, /<IdlePunchOutModal key=\{idleReminder\.remindedAt\} reminder=\{idleReminder\}/);
  assert.match(app, /window\.addEventListener\(ATTENDANCE_REFRESH_EVENT, load\);/);
  assert.match(app, /state\.last\.checkOutAuto === true/);
  assert.match(app, /sh\.checkOutAt && sh\.checkOutAuto === true/);
  assert.match(app, /idleOn=\{user\.idlePunchOutEnabled === true\}/);
  const modal = read('src', 'rep', 'IdlePunchOutModal.tsx');
  assert.match(modal, /await repApi\.post\(IDLE_STILL_WORKING_PATH, \{\}\);/);
  assert.match(modal, /window\.dispatchEvent\(new Event\(ATTENDANCE_REFRESH_EVENT\)\)/);
  assert.doesNotMatch(modal, /useEffect\([^)]*stillWorking\(\)/, 'لا ردّ تلقائي: الجوال المتروك لا يجيب عن صاحبه');
  // لا عدّ تنازليّ إلى انصرافٍ لن يقع: النبضة التي أظهرت النافذة نشاطٌ ألغى انصراف هذا التذكير في الخادم
  assert.doesNotMatch(modal, /idleMinutesLeft|idleAutoOutAt|setInterval|يسجل انصرافك تلقائيا بعد|انتهت مهلة الرد/);
  assert.match(modal, /tr\('لم يرصد لك نشاط ولا تنقل منذ \{n\} دقيقة'\)/);
  assert.match(modal, /tr\('ان انتهى عملك سجل بصمة الانصراف الآن'\)/);
  assert.equal(ATTENDANCE_REFRESH_EVENT, 'rep:attendance-refresh');
  const hb = read('src', 'rep', 'useHeartbeat.ts');
  assert.match(hb, /beatListeners\.forEach\(\(fn\) => \{ try \{ fn\(d as Record<string, unknown>, beatAt\); \} catch/);
  // إشعار التذكير (الوسم idle-punch) يبقى حتى يُلمس كـ«أثبت تواجدك» — بلا ردٍّ خلال المهلة انصرافٌ تلقائي
  const sw = read('public', 'sw.js');
  assert.match(sw, /requireInteraction: data\.tag === 'presence' \|\| data\.tag === 'idle-punch',/);
  // وإشعار «انصراف تلقائي» يحلّ محلّه بالوسم نفسه فينبّه (صوتٌ واهتزاز) لا يستبدله بصمت
  assert.match(sw, /renotify: data\.tag === 'presence' \|\| data\.tag === 'idle-punch',/);
});

test('نافذة تعديل البصمات: ختم النظام وحده ليس «آخر تعديل»، وتعديلٌ بشريٌّ بعده يظهر باسم صاحبه', () => {
  assert.equal(humanEditOf({ editedBy: AUTO_CHECKOUT_EDITOR, checkOutAuto: true }), null, 'انصرافٌ تلقائي لم يُعدَّل');
  assert.equal(humanEditOf({ editedBy: 'سارة', checkOutAuto: true }), 'سارة', 'عدّل الحضور وأبقى وقت الانصراف');
  assert.equal(humanEditOf({ editedBy: AUTO_CHECKOUT_EDITOR, checkOutAuto: false }), AUTO_CHECKOUT_EDITOR, 'الوسم سقط بتعديل الوقت');
  assert.equal(humanEditOf({ editedBy: null, checkOutAuto: true }), null);
  assert.equal(humanEditOf({ editedBy: 'سارة' }), 'سارة', 'خادمٌ أقدم بلا الوسم');
});

test('حارس الوسم: «انصراف تلقائي» في جدول الويب والجوال ونافذة تعديل البصمات وسجلّ تدقيقها', () => {
  assert.match(read('src', 'pages', 'ReportsPage.tsx'), /\{periodAutoOut\(p\) && \(\s*<span data-auto-checkout/);
  const m = read('src', 'm', 'MReports.tsx');
  assert.match(m, /periodsOf\(d\)\.some\(periodAutoOut\) \? tr\('انصراف تلقائي'\) : ''/);
  assert.match(m, /\{periodAutoOut\(p\) && <span data-auto-checkout/);
  const edit = read('src', 'components', 'attendance', 'AttendanceEditModal.tsx');
  assert.match(edit, /r\.checkOutAt && r\.checkOutAuto === true/);
  assert.match(edit, /a === 'AUTO_CHECKOUT' \? tr\('انصراف تلقائي'\)/);
  assert.match(edit, /\{humanEditOf\(r\) && <span>\{tr\('آخر تعديل'\)\}: \{humanEditOf\(r\)\}/);
  assert.doesNotMatch(edit, /\{r\.editedBy && <span>/, 'ختم النظام يُعرض «آخر تعديل»');
  assert.match(edit, /a\.actorName === AUTO_CHECKOUT_EDITOR \? tr\('النظام'\)/);
  assert.match(edit, /a\.reason === AUTO_CHECKOUT_REASON \? tr\('انصراف تلقائي بعد خمول'\)/);
});

test('عقد الخادم (متى وُجد في الشجرة): مسار «ما زلت أعمل» ومفتاح التذكير ورموز الرفض وحقول المندوب كما يقرؤها التطبيق', (t) => {
  const backend = path.resolve(process.cwd(), '..', 'backend', 'src');
  if (!fs.existsSync(path.join(backend, 'services', 'idlePunchOut.ts'))) { t.skip('الخادم بلا الميزة في هذه الشجرة'); return; }
  const tracking = read('..', 'backend', 'src', 'routes', 'tracking.ts');
  // repApi على /api، وموجّه التتبّع مركّبٌ على /api/tracking
  const sub = IDLE_STILL_WORKING_PATH.replace(/^\/tracking/, '');
  assert.ok(tracking.includes(`router.post('${sub}'`), `الخادم بلا POST /api${IDLE_STILL_WORKING_PATH}`);
  const hbAt = tracking.indexOf("router.post('/heartbeat'");
  const hb = tracking.slice(hbAt, tracking.indexOf('\nrouter.', hbAt + 10));
  assert.match(hb, new RegExp(`data: \\{[^}]*\\b${IDLE_REMINDER_KEY}\\b`), 'ردّ النبضة بلا مفتاح التذكير');
  const sw = tracking.slice(tracking.indexOf(`router.post('${sub}'`), tracking.indexOf('\nrouter.', tracking.indexOf(`router.post('${sub}'`) + 10));
  assert.ok(sw.includes(`code: '${IDLE_NO_OPEN_SHIFT}', autoCheckedOut: true`), 'ردّ «ما زلت أعمل» بلا عَلَم الانصراف التلقائي');
  const svc = read('..', 'backend', 'src', 'services', 'idlePunchOut.ts');
  for (const k of ['remindedAt', 'idleMinutes', 'graceMinutes']) assert.match(svc, new RegExp(`\\b${k}\\b`), k);
  // وسم الإشعار الذي يُبقيه عامل الخدمة حتى يُلمس، ورابطه شاشة البصمة
  assert.match(svc, /url: '\/rep\?screen=attendance', tag: 'idle-punch'/);
  // وحالة الحضور للنوبة المفتوحة تحمل التذكير، والمغلقة تحمل وسم «انصراف تلقائي» لآخر نوبة
  const today = tracking.slice(tracking.indexOf("router.get('/attendance/today'"), tracking.indexOf('\nrouter.', tracking.indexOf("router.get('/attendance/today'") + 10));
  assert.ok(today.includes(IDLE_REMINDER_KEY), 'حالة الحضور بلا مفتاح التذكير');
  assert.match(today, /checkOutAuto: true/);
  // اسم منفّذ الانصراف التلقائي وسببه في سجلّ التدقيق كما تقارنهما نافذة تعديل البصمات
  assert.ok(read('..', 'backend', 'src', 'services', 'workDay.ts').includes(`export const AUTO_CHECKOUT_EDITOR = '${AUTO_CHECKOUT_EDITOR}';`), 'AUTO_CHECKOUT_EDITOR');
  assert.ok(svc.includes(`export const IDLE_AUDIT_REASON = '${AUTO_CHECKOUT_REASON}';`), 'IDLE_AUDIT_REASON');
  assert.match(svc, /actorName: IDLE_ACTOR_NAME/);
  const reps = read('..', 'backend', 'src', 'routes', 'salesReps.ts');
  for (const k of ['idlePunchOutEnabled', 'idlePunchOutMinutes', 'idlePunchOutGraceMinutes']) assert.match(reps, new RegExp(`\\b${k}: `), k);
});
