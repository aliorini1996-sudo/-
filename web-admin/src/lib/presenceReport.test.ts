import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { presenceByRepDay, presenceSummary, presenceStatusText, localDate, type PresenceRow } from './presenceReport';
import { presencePhase, mmss } from '../rep/presencePhase';

// «التحقق العشوائي من التواجد» (طلب المالك، ٢٢ أكتوبر ٢٠٢٦): «أثبت تواجدك» مرّتين إلى ثلاث يومياً، والردّ خلال دقيقتين بموقعٍ
// طازج — ويظهر للإدارة في تقرير ساعات العمل.

const row = (o: Partial<PresenceRow>): PresenceRow => ({
  id: 'x', salesRepId: 'r1', status: 'PASSED', dueAt: '2026-10-22T07:10:00.000Z', sentAt: '2026-10-22T07:10:00.000Z',
  respondedAt: null, delaySec: 40, lat: 24.7, lng: 46.6, accuracy: 10, distanceM: 20, device: null, otherDevice: null, pushSent: 1, ...o,
});
const tr = (s: string) => s;

test('التحققات لكل مندوب ويوم بلحظة الإرسال (أو الموعد لما سقط قبل إرساله)', () => {
  const m = presenceByRepDay([row({ id: 'a' }), row({ id: 'b', salesRepId: 'r2' }), row({ id: 'c', status: 'SKIPPED', sentAt: null })]);
  const d = localDate('2026-10-22T07:10:00.000Z');
  assert.deepEqual(m.get(`r1|${d}`)!.map((r) => r.id), ['a', 'c']);
  assert.deepEqual(m.get(`r2|${d}`)!.map((r) => r.id), ['b']);
});

test('بيوم المندوب (يوم حضور نوبته) لا بيوم الإرسال: نوبةٌ مسائية تعبر منتصف الليل تُنسب ليومها كتقرير ساعات العمل', () => {
  const m = presenceByRepDay([row({ id: 'night', day: '2026-10-21', sentAt: '2026-10-21T21:30:00.000Z' })]);
  assert.deepEqual(m.get('r1|2026-10-21')!.map((r) => r.id), ['night']);
});

test('الملخّص: ما أُرسل لا ما سقط، وبلا ردّ أحمر، ومتأخر أو بلا موقع أو من جهازٍ آخر كهرماني', () => {
  assert.deepEqual(presenceSummary([row({}), row({}), row({ status: 'SKIPPED' })]),
    { asked: 2, onTime: 2, late: 0, missed: 0, pending: 0, noFix: 0, otherDevice: 0, noPush: 0, tone: 'good' });
  const s = presenceSummary([row({ lat: null, lng: null }), row({ otherDevice: true }), row({ status: 'MISSED', pushSent: 0 })]);
  assert.deepEqual([s.noFix, s.otherDevice, s.noPush], [1, 1, 1]);
  assert.equal(presenceSummary([row({}), row({ status: 'MISSED' })]).tone, 'bad');
  assert.equal(presenceSummary([row({}), row({ status: 'LATE' })]).tone, 'warn');
  assert.equal(presenceSummary([row({ lat: null, lng: null })]).tone, 'warn', 'ردٌّ بلا موقع');
  assert.equal(presenceSummary([row({ otherDevice: true })]).tone, 'warn', 'من غير الجهاز المربوط');
  assert.equal(presenceStatusText({ status: 'MISSED' }, tr), 'بلا رد');
  assert.equal(presenceStatusText({ status: 'SKIPPED' }, tr), 'سقط خارج نوبته');
});

test('مرحلة الطلب في التطبيق بساعة الخادم: دقيقتان، ثم متأخر حتى ربع ساعة، ثم انتهى', () => {
  const p = { deadline: '2026-10-22T07:12:00.000Z', until: '2026-10-22T07:25:00.000Z' };
  assert.deepEqual(presencePhase(p, Date.parse('2026-10-22T07:10:15.000Z')), { phase: 'onTime', leftMs: 105_000 });
  assert.equal(presencePhase(p, Date.parse('2026-10-22T07:13:00.000Z')).phase, 'late');
  assert.equal(presencePhase(p, Date.parse('2026-10-22T07:25:00.000Z')).phase, 'expired');
  assert.equal(mmss(105_000), '1:45');
  assert.equal(mmss(-5), '0:00');
});

test('حارس ثابت: الإشعار يفتح الطلب فوراً، والنبضة تحمله، والنافذة فوق كل شيء بضغطةٍ لا ردٍّ تلقائي، والإدارة تراه وتفعّله', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8');
  const sw = read('public', 'sw.js');
  assert.match(sw, /data\.tag === 'presence'/);
  assert.match(sw, /w\.postMessage\(\{ type: 'OPEN_SCREEN', screen: 'presence' \}\)/);
  assert.match(sw, /renotify: data\.tag === 'presence',/, 'الثاني ينبّه ولو حلّ محلّ الأول بالوسم نفسه');
  const hb = read('src', 'rep', 'useHeartbeat.ts');
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /useHeartbeat\(!!token && !!user, showPresence\);/);
  assert.match(app, /else if \(e\.data\.screen === 'presence'\) fetchPresence\(\);/);
  assert.match(app, /<PresenceCheckModal key=\{presence\.id\} pending=\{presence\}/);
  assert.match(app, /presenceOn=\{user\.requirePresenceCheck === true\}/);
  const modal = read('src', 'rep', 'PresenceCheck.tsx');
  assert.match(modal, /<button onClick=\{confirm\}/, 'الردّ بضغطة');
  assert.match(modal, /precisePunchFix\(\)/, 'قراءةٌ طازجة');
  assert.doesNotMatch(modal, /useEffect\([^)]*confirm\(\)/, 'لا ردّ تلقائي');
  assert.match(modal, /z-\[1400\]/, 'فوق حاجز الموقع (z-[1300]) وعارض الصور');
  // لحظة الضغط على الخادم قبل قراءة الموقع، ويُنتظر وصولها قبل الردّ؛ ومهلةٌ للردّ؛ وإغلاقٌ مؤقت بعد الفشل وحده
  assert.match(modal, /const tap = repApi\.post\(`\/tracking\/presence\/\$\{pending\.id\}\/tap`/);
  assert.ok(modal.indexOf('const tap = ') < modal.indexOf('await precisePunchFix()') && modal.indexOf('await tap;') < modal.indexOf('/respond`'));
  assert.match(modal, /\{ timeout: 25_000 \}/);
  assert.match(modal, /<button onClick=\{onDismiss\}/);
  assert.match(modal, /getNotifications\(\{ tag: 'presence' \}\)/, 'الإشعار العالق يُغلق');
  // يُغلق حين يرى المندوب النافذة فعلاً — لا والتطبيق في الخلفية فيُمسح قبل أن يراه
  assert.match(modal, /if \(typeof document === 'undefined' \|\| document\.visibilityState !== 'visible'\) return;/);
  assert.match(modal, /if \(!id \|\| id === checkId\) n\.close\(\);/, 'إشعار هذا الطلب وحده — لا طلبٌ أحدث');
  assert.ok(modal.indexOf('onAttempt();') < modal.indexOf("setStage('locating')"), 'بدء الردّ يُبلَّغ قبل القراءة');
  assert.match(sw, /data: \{ url, checkId: typeof data\.checkId === 'string' \? data\.checkId : null \},/);
  // طلبٌ أُجيب من نافذةٍ أخرى أو فات: النبضة (presence: null) تغلق نافذةً تنتظر الضغط؛ والخروج يمسح الطلب
  assert.match(app, /if \(beatAt != null && beatAt < presenceShownAt\.current\) return;/, 'ردّ نبضةٍ أسبق من ظهور الطلب لا يغلقه');
  assert.match(app, /cur && !answeredPresence\.current\.has\(cur\.id\) && !attemptedPresence\.current\.has\(cur\.id\) \? null : cur/);
  assert.match(app, /setPresence\(null\); answeredPresence\.current\.clear\(\);/);
  assert.match(hb, /if \(d && 'presence' in d\) presenceCb\.current\?\.\(d\.presence \?\? null, beatAt\);/);
  assert.match(read('src', 'pages', 'ReportsPage.tsx'), /setPresenceDay\(\{ repName: r\.name, date: d\.date, rows: pr \}\)/);
  const mr = read('src', 'm', 'MReports.tsx');
  assert.match(mr, /presenceNote\(d\.date\),/);
  assert.match(mr, /s\.noFix \? tr\('رد بلا موقع'\) : ''/, 'الجوال يفرّق المريب عن المكتمل');
  assert.match(read('src', 'components', 'forms', 'SalesRepModal.tsx'), /register\('requirePresenceCheck'\)/);
  assert.match(read('src', 'm', 'MSalesReps.tsx'), /onChange=\{v => set\('requirePresenceCheck', v\)\}/);
});
