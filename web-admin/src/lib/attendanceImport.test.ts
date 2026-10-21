import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { findColumns, cellDate, cellTime, parseAttendanceSheet, sheetFromFile, decodeText, dateOrderOf, TEMPLATE_HEADERS, type DateCode } from './attendanceImport';
import { getDeviceId, describeFromUA } from '../rep/deviceId';
import { urlB64ToBytes } from '../rep/pushKey';

// رفع بصمات الحضور من Excel، وجهاز البصمة، وتنبيهات الحضور (طلب المالك، ٢١ أكتوبر ٢٠٢٦)
const code = (n: number): DateCode => { const c = XLSX.SSF.parse_date_code(n); return c ? { y: c.y, m: c.m, d: c.d, H: c.H, M: c.M } : null; };
const REPS = [{ id: 'r1', name: 'أحمد سالم', username: 'ahmad' }, { id: 'r2', name: 'خالد', username: 'Khaled' }];
const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();

test('الأعمدة بالعربية أو الإنجليزية وبأيّ ترتيب، والناقص يُسمّى', () => {
  assert.deepEqual(findColumns([...TEMPLATE_HEADERS]), { cols: { username: 0, date: 1, in: 2, out: 3 } });
  assert.deepEqual(findColumns(['Check Out', 'Date', 'Username', 'Check In']), { cols: { username: 2, date: 1, in: 3, out: 0 } });
  assert.deepEqual(findColumns(['اسم المستخدم', 'التاريخ']), { missing: ['وقت الحضور', 'وقت الانصراف'] });
});

test('التاريخ والوقت بأيّ صيغة: رقم Excel، 2026-10-21، 21/10/2026، أرقام هندية، ص/م وAM/PM', () => {
  const serial = 46316; // 2026-10-21
  assert.deepEqual(cellDate(serial, code), { y: 2026, m: 10, d: 21 });
  assert.deepEqual(cellDate('2026-10-21', code), { y: 2026, m: 10, d: 21 });
  assert.deepEqual(cellDate('21/10/2026', code), { y: 2026, m: 10, d: 21 });
  assert.deepEqual(cellDate('٢١/١٠/٢٠٢٦', code), { y: 2026, m: 10, d: 21 });
  assert.equal(cellDate('أمس', code), null);
  assert.deepEqual(cellTime(0.3541666667, code), { h: 8, min: 30 });
  assert.deepEqual(cellTime('08:30', code), { h: 8, min: 30 });
  assert.deepEqual(cellTime('5:15 م', code), { h: 17, min: 15 });
  assert.deepEqual(cellTime('12:05 AM', code), { h: 0, min: 5 });
  assert.deepEqual(cellTime('١٢:٠٠ م', code), { h: 12, min: 0 });
  assert.equal(cellTime('25:00', code), null);
  assert.equal(cellTime('13:00 PM', code), null);
});

test('قراءة الورقة: المندوب باسم المستخدم (دون حساسية الحروف)، والدوام الليلي ينتهي غداً، والانصراف الفارغ مفتوح، والخطأ يبقى بسببه', () => {
  const out = parseAttendanceSheet([
    [...TEMPLATE_HEADERS],
    ['ahmad', '2026-10-21', '08:00', '17:00'],
    ['khaled', '2026-10-21', '22:00', '06:00'],
    ['ahmad', '2026-10-22', '08:00', ''],
    ['', '', '', ''],
    ['nobody', '2026-10-21', '08:00', '17:00'],
    ['ahmad', 'غداً', '08:00', '17:00'],
    ['ahmad', '2026-10-23', 'صباحاً', '17:00'],
  ], REPS, code, { now: new Date(2026, 9, 22, 12, 0).getTime() });
  assert.ok('rows' in out);
  const rows = (out as { rows: import('./attendanceImport').ParsedRow[] }).rows;
  assert.equal(rows.length, 6, 'السطر الفارغ يُترك');
  assert.deepEqual(rows[0], { line: 2, username: 'ahmad', repName: 'أحمد سالم', salesRepId: 'r1', checkInAt: local(2026, 10, 21, 8, 0), checkOutAt: local(2026, 10, 21, 17, 0) });
  assert.equal(rows[1].salesRepId, 'r2');
  assert.equal(rows[1].checkOutAt, local(2026, 10, 22, 6, 0), 'الانصراف قبل الحضور ⇒ اليوم التالي');
  assert.equal(rows[2].checkOutAt, null);
  assert.equal(rows[3].error, 'اسم المستخدم غير معروف');
  assert.equal(rows[3].line, 6);
  assert.equal(rows[4].error, 'تاريخ غير صالح');
  assert.equal(rows[5].error, 'وقت الحضور غير صالح');
});

test('ملف Excel حقيقيّ بخلايا تاريخٍ ووقتٍ رقمية يُقرأ كما يُقرأ النصّ', () => {
  const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS], ['ahmad', 46316, 8 / 24, 17.5 / 24]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'x');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'array' });
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(back.Sheets[back.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const out = parseAttendanceSheet(matrix, REPS, code) as { rows: import('./attendanceImport').ParsedRow[] };
  assert.equal(out.rows[0].checkInAt, local(2026, 10, 21, 8, 0));
  assert.equal(out.rows[0].checkOutAt, local(2026, 10, 21, 17, 30));
});

test('معرّف جهاز البصمة: يُولَّد مرّةً ويبقى، والتالف يُستبدل — ووصفٌ من User-Agent يميّز الكمبيوتر', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const a = getDeviceId(store);
  assert.match(a, /^[A-Za-z0-9-]{8,64}$/);
  assert.equal(getDeviceId(store), a, 'ثابت');
  mem.set('fs_device_id', 'bad value!');
  assert.notEqual(getDeviceId(store), 'bad value!');
  assert.equal(describeFromUA('Mozilla/5.0 (Linux; Android 14; K) Chrome/129 Mobile'), 'Android 14');
  assert.equal(describeFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)'), 'iPhone · iOS 17.4');
  assert.equal(describeFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129'), 'Windows · كمبيوتر');
  // سفاري iPadOS 13+ يقدّم نفسه ماك — اللمس المتعدّد يكشفه
  assert.equal(describeFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15', true), 'iPad · iPadOS');
  assert.equal(describeFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15'), 'macOS · كمبيوتر');
});

test('مفتاح الإشعارات العامّ (base64url) يتحوّل إلى ٦٥ بايتاً تبدأ بـ0x04', () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = urlB64ToBytes(key);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
});

test('حرّاس الربط: البصمة ترسل الجهاز، والإشعار يفتح شاشة البصمة، والخروج يلغي الاشتراك، والإدارة ترى أدواتها خلف تفعيل الميزة', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8');
  const app = read('src', 'rep', 'RepApp.tsx');
  const att = app.slice(app.indexOf('function RepAttendance('), app.indexOf('function RepWorkNumber()'));
  assert.match(att, /const body = \{ \.\.\.\(loc \?\? \{\}\), deviceId: getDeviceId\(\), deviceName: await describeDevice\(\) \};/);
  assert.match(att, /resp\.data\.reason !== 'DEVICE'\) setErr\(tr\(VISIT_NOFIX_MSG\)\)/, 'رفض الجهاز لا يُقال له «تعذّر تحديد موقعك»');
  assert.match(att, /pushSt === 'off' && \(/);
  assert.match(app, /await dropPush\(\); \/\/ الجهاز لا يتلقّى تنبيهات/);
  assert.match(app, /if \(sp\.get\('screen'\) === 'attendance'\)/);
  assert.match(app, /if \(companyReady && !attendanceOn && screen === 'attendance'\) setScreen\('home'\);/, 'الإشعار لا يُردّ إلى الرئيسية قبل وصول إعدادات الشركة');
  const sw = read('public', 'sw.js');
  assert.match(sw, /self\.addEventListener\('push'/);
  assert.match(sw, /self\.addEventListener\('notificationclick'/);
  assert.match(sw, /if \(u\.origin === self\.location\.origin && shellFor\(u\.pathname\) === '\/rep'\) url = u\.pathname \+ u\.search;/, 'الإشعار لا يفتح رابطاً خارج التطبيق (ولا «//مضيف»)');
  assert.match(sw, /wins\.find\(\(w\) => shellFor\(new URL\(w\.url\)\.pathname\) === '\/rep'\)/, 'تبويب ‎/rep-app‎ ليس نافذة التطبيق');
  assert.doesNotMatch(sw, /pathname\.startsWith\('\/rep'\)/);
  const rep = read('src', 'pages', 'ReportsPage.tsx');
  assert.match(rep, /const attendanceOn = companyQ\.data\?\.attendanceEnabled === true;/);
  assert.match(rep, /\{attendanceOn && \(\s*<button onClick=\{\(e\) => \{ e\.stopPropagation\(\); setEditDay\(/);
  assert.match(rep, /\{attendanceOn && \(\s*<button onClick=\{\(\) => setShowImport\(true\)\}/);
  const modal = read('src', 'components', 'forms', 'SalesRepModal.tsx');
  for (const f of ["register('requireBoundDevice')", "register('punchOutsideAction')", "register('shiftStart'", "register('shiftEnd'"]) assert.ok(modal.includes(f), f);
  assert.match(modal, /requireBoundDevice: false,/, 'افتراض المندوب الجديد مطفأ');
  const m = read('src', 'm', 'MSalesReps.tsx');
  const grants = m.slice(m.indexOf('const GRANTS = ['), m.indexOf('] as const;', m.indexOf('const GRANTS = [')));
  assert.doesNotMatch(grants, /requireBoundDevice/, 'قيدٌ يسلب لا يُقلب مع «تحديد الكل»');
});

// ═══ مراجعة ٢١ أكتوبر ٢٠٢٦ ═══
test('يومٌ غير موجود في شهره (31/02) يُرفض ولا ينزلق إلى مارس', () => {
  assert.equal(cellDate('31/02/2026', code), null);
  assert.equal(cellDate('2026-02-29', code), null, '٢٠٢٦ ليست كبيسة');
  assert.deepEqual(cellDate('29/02/2028', code), { y: 2028, m: 2, d: 29 });
});

test('اسم المستخدم: الحرفيّ أولاً، ودون حالة الحروف إن دلّ على مندوبٍ واحد، والملتبس خطأٌ لا نسبةٌ صامتة', () => {
  const reps = [{ id: 'r1', name: 'علي', username: 'Ali' }, { id: 'r2', name: 'علي الثاني', username: 'ali' }, { id: 'r3', name: 'سالم', username: 'Salem' }];
  const out = parseAttendanceSheet([
    [...TEMPLATE_HEADERS],
    ['Ali', '2026-10-20', '08:00', '17:00'],
    ['ali', '2026-10-20', '08:00', '17:00'],
    ['ALI', '2026-10-20', '08:00', '17:00'],
    ['salem', '2026-10-20', '08:00', '17:00'],
  ], reps, code) as { rows: import('./attendanceImport').ParsedRow[] };
  assert.equal(out.rows[0].salesRepId, 'r1');
  assert.equal(out.rows[1].salesRepId, 'r2');
  assert.equal(out.rows[2].error, 'اسم المستخدم يطابق أكثر من مندوب');
  assert.equal(out.rows[3].salesRepId, 'r3');
});

test('حضورٌ يساوي انصرافه خطأٌ لا نوبة ٢٤ ساعة، وانصرافٌ فارغٌ لتاريخٍ مضى يُطلب، وأسطرٌ بموضعها في الملف', () => {
  const now = new Date(2026, 9, 21, 12, 0).getTime();
  const out = parseAttendanceSheet([
    [...TEMPLATE_HEADERS],
    ['ahmad', '2026-10-20', '08:00', '08:00'],
    ['ahmad', '2026-10-02', '08:00', ''],
    ['ahmad', '2026-10-21', '08:00', ''],
  ], REPS, code, { now, lineOffset: 2 }) as { rows: import('./attendanceImport').ParsedRow[] };
  assert.equal(out.rows[0].error, 'وقت الانصراف يساوي وقت الحضور');
  assert.equal(out.rows[1].error, 'أدخل وقت الانصراف');
  assert.equal(out.rows[2].checkOutAt, null, 'نوبة اليوم الجارية تبقى مفتوحة');
  assert.deepEqual(out.rows.map((r) => r.line), [4, 5, 6], 'العناوين في الصفّ الثالث');
});

test('CSV يُقرأ نصّاً UTF-8 بلا BOM أو به، وتواريخ dd/mm بشهرها: «05/10/2026» هو ٥ أكتوبر لا ١٠ مايو', () => {
  const body = [TEMPLATE_HEADERS.join(','), 'ahmad,05/10/2026,08:00,17:00', 'ahmad,21/10/2026,08:00,17:00'].join(String.fromCharCode(10));
  for (const text of [body, String.fromCharCode(0xfeff) + body]) {
    const { matrix } = sheetFromFile(XLSX, new TextEncoder().encode(text).buffer as ArrayBuffer, 'October.CSV');
    const out = parseAttendanceSheet(matrix, REPS, code) as { rows: import('./attendanceImport').ParsedRow[] };
    assert.ok('rows' in out, 'العناوين العربية تُقرأ');
    assert.equal(out.rows[0].checkInAt, local(2026, 10, 5, 8, 0));
    assert.equal(out.rows[1].checkInAt, local(2026, 10, 21, 8, 0));
  }
  // xlsx يبدأ من الصفّ الثالث: الأسطر بأسطر الملف
  const ws = XLSX.utils.aoa_to_sheet([[], [], [...TEMPLATE_HEADERS], ['ghost', 46316, 8 / 24, 17 / 24]]);
  ws['!ref'] = 'A3:D4'; // النطاق المستخدم كما يكتبه Excel حين يكون الصفّان الأوّلان فارغين
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'x');
  const sheet = sheetFromFile(XLSX, XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, 'a.xlsx');
  assert.equal(sheet.lineOffset, 2);
  const out = parseAttendanceSheet(sheet.matrix, REPS, code, { lineOffset: sheet.lineOffset }) as { rows: import('./attendanceImport').ParsedRow[] };
  assert.equal(out.rows[0].line, 4);
  const modal = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'attendance', 'AttendanceImportModal.tsx'), 'utf8');
  assert.match(modal, /const \{ matrix, lineOffset \} = sheetFromFile\(XLSX, await file\.arrayBuffer\(\), file\.name\);/);
  assert.match(modal, /parseAttendanceSheet\(matrix, reps\.data \?\? \[\], code, \{ lineOffset \}\)/);
  assert.match(modal, /queryFn: async \(\) => \(await attendanceAdminApi\.reps\(\)\)\.data\.data/, 'مناديب الرفع بصلاحية التتبّع لا «إدارة المناديب»');
  assert.match(modal, /disabled=\{reps\.isLoading \|\| reps\.isError\}/);
});

test('حرّاس المراجعة: الحقل غير المعدّل يُرسل كما هو، وفكّ الربط يُبطل الكاش، والخروج والدخول لا يتركان تنبيهات حسابٍ آخر، وآيفون يُشرح له', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8');
  const edit = read('src', 'components', 'attendance', 'AttendanceEditModal.tsx');
  assert.match(edit, /checkInAt: touchedIn\(r\) \? fromLocalInput\(edits\[r\.id\]!\.in!\) \?\? '' : r\.checkInAt,/);
  assert.match(edit, /checkOutAt: touchedOut\(r\) \? fromLocalInput\(edits\[r\.id\]!\.out!\) : r\.checkOutAt \?\? null,/);
  assert.match(edit, /attendanceAdminApi\.update\(r\.id, \{ \.\.\.keptOrEdited\(r\), reason: reason\.trim\(\) \}\)/);
  assert.match(edit, /\[r\.id\]: \{ \.\.\.m\[r\.id\], out: e\.target\.value \}/, 'الحقل الملموس وحده يُحفظ في التعديلات');
  const modal = read('src', 'components', 'attendance', 'AttendanceImportModal.tsx');
  assert.match(modal, /const tooMany = good\.length > IMPORT_MAX_ROWS;/);
  assert.match(modal, /good\.length === 0 \|\| tooMany \|\| result != null/);
  const web = read('src', 'components', 'forms', 'SalesRepModal.tsx');
  assert.match(web, /void qc\.invalidateQueries\(\{ queryKey: \['sales-reps'\] \}\);/);
  assert.match(web, /data\?\.data\?\.unbound === false/);
  const m = read('src', 'm', 'MSalesReps.tsx');
  assert.match(m, /qc\.invalidateQueries\(\{ queryKey: \['m-rep', rep\.id\] \}\);\s*if \(data\?\.data\?\.unbound === false\)/);
  const push = read('src', 'rep', 'pushAlerts.ts');
  assert.doesNotMatch(push, /await navigator\.serviceWorker\.ready;/, 'ready بلا مهلة يعلّق الخروج');
  assert.match(push, /if \(fresh\) await sub\.unsubscribe\(\)\.catch\(\(\) => false\);\s*throw e;/, 'اشتراكٌ لم يحفظه الخادم لا يبقى «مفعّلاً»');
  assert.match(push, /navigator\.platform === 'MacIntel' && navigator\.maxTouchPoints > 1/, 'iPadOS آيفونٌ في عزل التخزين');
  const drop = push.slice(push.indexOf('export async function dropPush('));
  assert.ok(drop.indexOf('sub.unsubscribe()') < drop.indexOf("repApi.post('/tracking/push/unsubscribe'"), 'محلياً أولاً');
  assert.match(drop, /\{ background: true, timeout: 3000 \}/);
  const api = read('src', 'rep', 'repApi.ts');
  assert.match(api, /await unsubscribeLocalPush\(1500\);\s*if \(window\.location\.pathname\.startsWith\('\/rep'\)\) window\.location\.href = '\/rep';/);
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /await forgetForeignPush\(u\.id\);/);
  assert.match(app, /\{boundDevice && isIos\(\) && \(!standalone\(\) \|\| deviceRefused\) && \(/);
  assert.match(app, /boundDevice=\{user\.requireBoundDevice === true\}/);
});

test('ترتيب التاريخ يُحسم للملف كله: CSV أمريكي (شهر/يوم) يُقرأ بشهره، والملتبس يوم/شهر مع تنبيه', () => {
  assert.deepEqual(dateOrderOf(['10/21/2026', '10/5/2026']), { order: 'MDY', ambiguous: false });
  assert.deepEqual(dateOrderOf(['21/10/2026', '5/10/2026']), { order: 'DMY', ambiguous: false });
  assert.deepEqual(dateOrderOf(['5/10/2026', '6/10/2026']), { order: 'DMY', ambiguous: true });
  assert.deepEqual(dateOrderOf(['2026-10-05', 46316]), { order: 'DMY', ambiguous: false }, 'لا شرطة مائلة ⇒ لا لبس');
  const us = parseAttendanceSheet([
    ['username', 'date', 'check in', 'check out'],
    ['ahmad', '10/5/2026', '8:00 AM', '5:00 PM'],
    ['ahmad', '10/21/2026', '8:00 AM', '5:00 PM'],
  ], REPS, code) as { rows: import('./attendanceImport').ParsedRow[]; ambiguousDates: boolean };
  assert.equal(us.rows[0].checkInAt, local(2026, 10, 5, 8, 0), '٥ أكتوبر لا ١٠ مايو');
  assert.equal(us.rows[1].checkInAt, local(2026, 10, 21, 8, 0));
  assert.equal(us.ambiguousDates, false);
  const amb = parseAttendanceSheet([[...TEMPLATE_HEADERS], ['ahmad', '5/10/2026', '08:00', '17:00']], REPS, code) as { ambiguousDates: boolean };
  assert.equal(amb.ambiguousDates, true);
});

test('ترميز الملف النصّي: UTF-16 بعلامته، وWindows-1256 من Excel العربي القديم — وخلية وقتٍ بتاريخها، وأرقام Excel نصّاً', () => {
  const body = [TEMPLATE_HEADERS.join('\t'), 'ahmad\t2026-10-21\t08:00\t17:00'].join('\r\n');
  const le = new Uint8Array(2 + body.length * 2);
  le[0] = 0xff; le[1] = 0xfe;
  for (let i = 0; i < body.length; i++) { const c = body.charCodeAt(i); le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8; }
  assert.equal(decodeText(le.buffer), body);
  const sheet = sheetFromFile(XLSX, le.buffer, 'export.txt');
  assert.ok('rows' in parseAttendanceSheet(sheet.matrix, REPS, code), 'العناوين العربية تُقرأ');
  // «اسم» بترميز Windows-1256: ا=0xC7 س=0xD3 م=0xE3
  assert.equal(decodeText(new Uint8Array([0xc7, 0xd3, 0xe3]).buffer), 'اسم');
  assert.deepEqual(cellTime('2026-10-21 08:30', code), { h: 8, min: 30 });
  assert.deepEqual(cellTime('21/10/2026 5:15 م', code), { h: 17, min: 15 });
  assert.deepEqual(cellDate('46316', code), { y: 2026, m: 10, d: 21 });
  assert.deepEqual(cellTime('0.3541666667', code), { h: 8, min: 30 });
});
