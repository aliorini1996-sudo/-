import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IDLE_GRACE_DEFAULT, IDLE_MINUTES_DEFAULT, IDLE_REMINDER_KEY, IDLE_STILL_WORKING_PATH, IDLE_NO_OPEN_SHIFT,
  ATTENDANCE_REFRESH_EVENT, AUTO_CHECKOUT_EDITOR, AUTO_CHECKOUT_REASON, humanEditOf, idleClosedKind, idleFieldNum, idleGraceOk,
  idleMinutesOk, idleReminderOf, idleSaveFields, idleSettingsOf, withCount, fmtCountdown, idleAfterBeat, idleDeadlineMs, idleRemainingMs,
  type IdleReminder, type IdleShown,
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

test('التذكير من ردّ الخادم: الغائب لا يغيّر شيئاً، وnull لا تذكير، والمفتاح idlePunchOutReminder، وفرق الساعتين من serverNow', () => {
  const at = '2026-11-23T08:00:00.000Z';
  assert.equal(idleReminderOf({ presence: null }), undefined, 'خادمٌ قبل الميزة');
  assert.equal(idleReminderOf(null), undefined);
  assert.equal(IDLE_REMINDER_KEY, 'idlePunchOutReminder');
  assert.equal(idleReminderOf({ presence: null, idlePunchOutReminder: null }), null);
  assert.equal(idleReminderOf({ idlePunchOutReminder: { remindedAt: 'أمس', idleMinutes: 45, graceMinutes: 15 } }), null, 'لحظةٌ لا تُقرأ ⇒ لا نافذة');
  assert.equal(idleReminderOf({ idle: { remindedAt: at, idleMinutes: 45, graceMinutes: 15 } }), undefined, 'مفتاحٌ غير مفتاح الخادم');
  // serverNow ساعة الخادم لحظة الردّ: جوالٌ ساعته متأخّرة ٧ دقائق ⇒ فرقٌ موجب ٧ دقائق
  const serverNow = Date.parse(at) + 2 * MIN;
  const r = idleReminderOf({ presence: null, idlePunchOutReminder: { remindedAt: at, idleMinutes: 60, graceMinutes: 20, serverNow } }, serverNow - 7 * MIN)!;
  assert.deepEqual(r, { remindedAt: at, idleMinutes: 60, graceMinutes: 20, clockOffsetMs: 7 * MIN });
  // أعدادٌ فاسدة ⇒ الافتراض، وبلا serverNow (أو فاسدٍ) لا تصحيح
  assert.deepEqual(idleReminderOf({ idlePunchOutReminder: { remindedAt: at, idleMinutes: 0, graceMinutes: 'x' } }, 123),
    { remindedAt: at, idleMinutes: 45, graceMinutes: 15, clockOffsetMs: 0 });
  assert.equal(idleReminderOf({ idlePunchOutReminder: { remindedAt: at, idleMinutes: 45, graceMinutes: 15, serverNow: 'x' } }, 123)!.clockOffsetMs, 0);
  assert.equal(withCount('منذ {n} دقيقة', 7), 'منذ 7 دقيقة');
});

test('العدّ التنازليّ الحقيقيّ: الانصراف عند التذكير + المهلة بساعة الخادم، وساعة الجوال مصحّحة بفرقها', () => {
  const at = '2026-11-23T08:00:00.000Z';
  const T = Date.parse(at);
  // الردّ وصل عند التذكير + ٣ دقائق بساعة الخادم، وساعة الجوال متقدّمة ١٠ دقائق
  const phoneAtReply = T + 3 * MIN + 10 * MIN;
  const r = idleReminderOf({ idlePunchOutReminder: { remindedAt: at, idleMinutes: 45, graceMinutes: 15, serverNow: T + 3 * MIN } }, phoneAtReply)!;
  assert.equal(idleDeadlineMs(r), T + 15 * MIN);
  assert.equal(idleRemainingMs(r, phoneAtReply), 12 * MIN, 'لا يُنقص تقدّم ساعة الجوال من المهلة');
  assert.equal(idleRemainingMs(r, phoneAtReply + 11 * MIN + 30_000), 30_000);
  assert.equal(idleRemainingMs(r, phoneAtReply + 13 * MIN), 0, 'لا سالب بعد انقضائه');
  // «د:ث» بثوانٍ مقرّبةٍ لأعلى، والدقائق فوق ٥٩ للمهلة الطويلة
  assert.equal(fmtCountdown(12 * MIN), '12:00');
  assert.equal(fmtCountdown(30_000), '00:30');
  assert.equal(fmtCountdown(1), '00:01', 'لا 00:00 والمهلة لم تنقضِ');
  assert.equal(fmtCountdown(0), '00:00');
  assert.equal(fmtCountdown(-5), '00:00');
  assert.equal(fmtCountdown(120 * MIN), '120:00');
});

test('النافذة بعد ردّ النبضة: تُفتح وتُحدَّث بالتذكير، ويغلقها ردٌّ بلا تذكير قبل انقضاء العدّ (ألغاه الخادم) لا بعده', () => {
  const at = '2026-11-23T08:00:00.000Z';
  const T = Date.parse(at);
  const mk = (serverNow: number, phone = serverNow): IdleReminder =>
    idleReminderOf({ idlePunchOutReminder: { remindedAt: at, idleMinutes: 45, graceMinutes: 15, serverNow } }, phone)!;
  const none = new Set<string>();
  // خادمٌ بلا الحقل: لا تغيير
  assert.equal(idleAfterBeat(null, undefined, T, none), null);
  // أوّل ردٍّ بالتذكير يفتحها
  const open = idleAfterBeat(null, mk(T + MIN), T + MIN, none)!;
  assert.equal(open.remindedAt, at);
  assert.equal(open.beatAt, T + MIN);
  // التذكير نفسه من نبضةٍ تالية يُحدّث فرق الساعتين (بلا إعادة تركيب: المفتاح remindedAt نفسه)
  const again = idleAfterBeat(open, mk(T + 2 * MIN, T + 2 * MIN - 5_000), T + 2 * MIN, none)!;
  assert.equal(again.clockOffsetMs, 5_000);
  assert.equal(again.remindedAt, open.remindedAt);
  // ردٌّ بلا تذكير والعدّ جارٍ: ألغاه الخادم (تنقّلٌ فعلي أو مستند أو «ما زلت أعمل» من جهازٍ آخر) ⇒ تُغلق
  assert.equal(idleAfterBeat(again, null, T + 3 * MIN, none, T + 3 * MIN), null);
  // ردٌّ من نبضةٍ أُطلقت قبل التي أكّدته لا يغلقه
  assert.equal(idleAfterBeat(again, null, T + MIN, none, T + 3 * MIN), again);
  // بعد انقضاء العدّ تبقى (الأرجح أنّ الانصراف التلقائي وقع: يعرفه المندوب بضغطه)، وكذا وهي تعرض نتيجة ردّ
  assert.equal(idleAfterBeat(again, null, T + 16 * MIN, none, T + 16 * MIN), again);
  const settled: IdleShown = { ...again, settled: true };
  assert.equal(idleAfterBeat(settled, null, T + 3 * MIN, none, T + 3 * MIN), settled);
  assert.equal(idleAfterBeat(settled, mk(T + 4 * MIN), T + 4 * MIN, none)!.settled, true, 'التحديث يُبقي عرض النتيجة');
  // تذكيرٌ أُجيب لا يُعاد فتحه، وتذكيرٌ جديدٌ آخر يحلّ محلّه
  assert.equal(idleAfterBeat(null, mk(T + 5 * MIN), T + 5 * MIN, new Set([at])), null);
  const next = idleReminderOf({ idlePunchOutReminder: { remindedAt: '2026-11-23T09:00:00.000Z', idleMinutes: 45, graceMinutes: 15, serverNow: T + 61 * MIN } }, T + 61 * MIN)!;
  assert.equal(idleAfterBeat(again, next, T + 61 * MIN, none)!.remindedAt, '2026-11-23T09:00:00.000Z');
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
  // ومدى «الموقع» يُلفّ فوقه (locationRadiusSaveFields — ٢٥ نوفمبر ٢٠٢٦) فيبقى idleSaveFields على النموذج كله
  assert.match(modal, /<form onSubmit=\{handleSubmit\(\(d\) => onSave\(locationRadiusSaveFields\(idleSaveFields\(d\)\)\)\)\}/);
  assert.match(modal, /\.\.\.idleSettingsOf\(defaults\),/);
  const m = read('src', 'm', 'MSalesReps.tsx');
  assert.match(m, /<MToggle label=\{tr\('تذكير بالانصراف عند الخمول ثم انصراف تلقائي'\)\}\s*checked=\{idleOn\}/);
  assert.match(m, /\{idleOn && \(<>[\s\S]{0,400}tr\('دقائق الخمول قبل التذكير'\)[\s\S]{0,400}tr\('مهلة الرد قبل الانصراف التلقائي \(دقيقة\)'\)/);
  assert.match(m, /\.\.\.idleSaveFields\(\{ idlePunchOutEnabled: idleOn, idlePunchOutMinutes: idleMinNum, idlePunchOutGraceMinutes: idleGraceNum \}\),/);
  assert.match(m, /disabled=\{!discOk \|\| !proxOk \|\| !punchOk \|\| !idleOk \|\| !locOk \|\| save\.isPending\}/);
  // قيدٌ تقييديّ: خارج PermKey فلا يقلبه «تحديد الكل»
  assert.doesNotMatch(m.slice(m.indexOf('type PermKey'), m.indexOf(';', m.indexOf('type PermKey'))), /idlePunchOut/);
});

test('حارس تطبيق المندوب: التذكير من ردّ النبضة، والنافذة تعدّ تنازلياً وتُرسل «ما زلت أعمل» وتُحدّث شاشة البصمة، و«انصراف تلقائي» في الشاشة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /useEffect\(\(\) => onHeartbeat\(\(d, beatAt\) => \{\s*const r = idleReminderOf\(d\);\s*setIdleReminder\(\(cur\) => idleAfterBeat\(cur, r, beatAt, handledIdle\.current\)\);/);
  assert.match(app, /<IdlePunchOutModal key=\{idleReminder\.remindedAt\} reminder=\{idleReminder\}/);
  assert.match(app, /onSettled=\{settleIdle\}/);
  assert.match(app, /window\.addEventListener\(ATTENDANCE_REFRESH_EVENT, load\);/);
  assert.match(app, /state\.last\.checkOutAuto === true/);
  assert.match(app, /sh\.checkOutAt && sh\.checkOutAuto === true/);
  assert.match(app, /idleOn=\{user\.idlePunchOutEnabled === true\}/);
  const modal = read('src', 'rep', 'IdlePunchOutModal.tsx');
  assert.match(modal, /await repApi\.post\(IDLE_STILL_WORKING_PATH, \{\}\);/);
  assert.match(modal, /window\.dispatchEvent\(new Event\(ATTENDANCE_REFRESH_EVENT\)\)/);
  assert.doesNotMatch(modal, /useEffect\([^)]*stillWorking\(\)/, 'لا ردّ تلقائي: الجوال المتروك لا يجيب عن صاحبه');
  // عدٌّ تنازليّ حقيقيّ إلى الانصراف التلقائي (النبضة لا تلغيه — قرار المالك): ساعة الجوال كل ثانية مصحّحةً بساعة الخادم
  assert.match(modal, /setInterval\(\(\) => setPhoneNow\(Date\.now\(\)\), 1000\)/);
  assert.match(modal, /const remaining = idleRemainingMs\(reminder, phoneNow\);/);
  assert.match(modal, /\{fmtCountdown\(remaining\)\}/);
  assert.match(modal, /tr\('الوقت المتبقي قبل الانصراف التلقائي'\)/);
  assert.match(modal, /tr\('انتهت المهلة ويسجل انصرافك تلقائيا خلال لحظات'\)/);
  assert.match(modal, /withCount\(tr\('بلا استخدام للتطبيق ولا موقع يصل من جوالك منذ \{n\} دقيقة'\), reminder\.idleMinutes\)/);
  assert.match(modal, /tr\('لا يلغي الانصراف التلقائي إلا ما زلت أعمل أو تنقل فعلي أو إصدار مستند'\)/);
  assert.match(modal, /tr\('ان انتهى عملك سجل بصمة الانصراف الآن'\)/);
  assert.match(modal, /tr\('ما زلت أعمل'\)/);
  assert.match(modal, /tr\('سجل الانصراف الآن'\)/);
  assert.doesNotMatch(modal, /ولا تنقل منذ/, 'النصّ القديم: الخمول ليس «بلا تنقّل»');
  // وقت الانصراف التلقائي آخر نشاطٍ **سبق التذكير**: النافذة تُعرض بعد فتح التطبيق (نشاطٌ لا يلغيه) فلا «آخر نشاط» مطلقاً
  assert.match(modal, /tr\('سجل انصرافك تلقائيا بوقت آخر نشاط لك قبل التذكير وان كنت تعمل سجل حضورا جديدا'\)/);
  assert.match(app, /tr\('لم ترد على التذكير ولم يرصد تنقل ولا مستند فسجل انصرافك بوقت آخر نشاط لك قبل التذكير'\)/);
  for (const [name, src] of [['IdlePunchOutModal', modal], ['RepApp', app]] as const) {
    assert.doesNotMatch(src, /بوقت آخر نشاط لك وان كنت|لم يرصد لك نشاط/, `${name}: النصّ القديم`);
  }
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
  // تلميح الوسم يصف القاعدة: آخر نشاطٍ قبل التذكير، ولم يلغه «ما زلت أعمل» ولا تنقّلٌ ولا مستند
  const tip = "title={tr('سجله النظام بوقت آخر نشاط للمندوب قبل تذكير خمول لم يلغه ما زلت أعمل ولا تنقل ولا مستند')}";
  const reports = read('src', 'pages', 'ReportsPage.tsx');
  for (const [name, src] of [['ReportsPage', reports], ['AttendanceEditModal', edit]] as const) {
    assert.ok(src.includes(tip), `${name}: التلميح`);
    assert.doesNotMatch(src, /بعد تذكير خمول بلا رد/, `${name}: التلميح القديم`);
  }
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
  // بيانات العدّ التنازليّ في التذكير المعلّق: ساعة الخادم لحظة الردّ
  assert.match(svc, /serverNow: now\.getTime\(\)/);
});

test('نصوص القاعدة: الإعداد في اللوحة والجوال والتوثيق يصف الخمول «بلا استخدام للتطبيق ولا موقع يصل من جواله» وما يلغي الانصراف بعد التذكير', () => {
  const hint = 'عند التفعيل اذا بقي المندوب حاضرا بلا استخدام للتطبيق ولا موقع يصل من جواله طوال دقائق الخمول';
  const modal = read('src', 'components', 'forms', 'SalesRepModal.tsx');
  const m = read('src', 'm', 'MSalesReps.tsx');
  for (const [name, src] of [['SalesRepModal', modal], ['MSalesReps', m]] as const) {
    assert.ok(src.includes(`tr('${hint}`), `${name}: التلميح الجديد`);
    assert.ok(src.includes('لا يلغي الانصراف التلقائي إلا ما زلت أعمل أو تنقل فعلي (اكثر من 150 م) أو إصدار مستند'), `${name}: ما يلغيه بعد التذكير`);
    assert.doesNotMatch(src, /بلا نشاط في التطبيق ولا تنقل/, `${name}: التلميح القديم`);
  }
  const docs = read('src', 'lib', 'apiDocsCatalog.ts');
  assert.ok(docs.includes('بلا استخدام للتطبيق ولا موقع يصل من جواله'));
  assert.ok(docs.includes('لا يلغي الانصراف التلقائي إلا «ما زلت أعمل» أو تنقّل فعلي'));
  assert.ok(!docs.includes('نقاط تتبّع الخلفية لا تُحسب نشاطاً إلا بانتقالٍ'), 'التوثيق القديم');
  // checkOutAuto في التوثيق: بوقت آخر نشاطٍ قبل التذكير، لا «بعد تذكير خمول بلا رد»
  const data = read('src', 'lib', 'apiDocsData.ts');
  for (const [name, src] of [['apiDocsCatalog', docs], ['apiDocsData', data]] as const) {
    assert.ok(src.includes('سجّله النظام بوقت آخر نشاط للمندوب قبل تذكير خمول لم يلغه «ما زلت أعمل» ولا تنقّل ولا مستند'), `${name}: checkOutAuto`);
    assert.ok(!src.includes('بعد تذكير خمول بلا رد'), `${name}: الوصف القديم`);
  }
});
