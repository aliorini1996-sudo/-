import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_DAYS, DEFAULT_OFF_DAYS, DIST_MODES, WEEKDAYS_AR, daysText, groupByRep, modeOf, moveItem, sameList, takenDays, toggleDay,
} from './routeSchedule';
import { PHRASES } from '../i18n/strings';

/**
 * «طريقة توزيع الخطوط» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): أدوات النافذة النقيّة، وترجمات كل نصٍّ جديد، وأنّ الواجهة
 * تقرأ «خطّ اليوم» من الخادم ولا تحسبه بنفسها (الحساب في backend/src/services/routeSchedule.ts ومُختبَرٌ هناك).
 */

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

test('الأيام بعرف الخادم 0=الأحد..6=السبت، والجمعة راحةٌ افتراضاً، و«خط واحد» حين لا جدول', () => {
  assert.deepEqual([...ALL_DAYS], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(WEEKDAYS_AR[0], 'الأحد');
  assert.equal(WEEKDAYS_AR[5], 'الجمعة');
  assert.deepEqual(DEFAULT_OFF_DAYS, [5]);
  assert.deepEqual(DIST_MODES.map(m => m.mode), ['single', 'weekdays', 'rotation']);
  assert.equal(modeOf(null), 'single');
  assert.equal(modeOf({ mode: 'weekdays' }), 'weekdays');
  assert.equal(modeOf({ mode: 'rotation' }), 'rotation');
  assert.equal(modeOf({ mode: 'monthly' }), 'single', 'نمطٌ مجهول لا يكسر الواجهة');
});

test('تبديل يوم: مرتّبةٌ بلا تكرار، والخارج عن 0..6 يسقط', () => {
  assert.deepEqual(toggleDay([], 5), [5]);
  assert.deepEqual(toggleDay([5], 5), []);
  assert.deepEqual(toggleDay([6, 1], 3), [1, 3, 6]);
  assert.deepEqual(toggleDay([1, 1, 9], 2), [1, 2]);
  assert.deepEqual(toggleDay([1], 7), [1]);
});

test('الأيام المحجوزة: أيام خطوط المندوب الأخرى باسم صاحبها — والخطّ المُحرَّر لا يحجز على نفسه', () => {
  const routes = [{ id: 'A', name: 'الشمال', weekdays: [0, 1] }, { id: 'B', name: 'الجنوب', weekdays: [2] }, { id: 'C', name: 'بلا', weekdays: null }];
  const all = takenDays(routes);
  assert.deepEqual([...all.entries()].sort(), [[0, 'الشمال'], [1, 'الشمال'], [2, 'الجنوب']]);
  const editingA = takenDays(routes, 'A');
  assert.deepEqual([...editingA.keys()], [2]);
});

test('تحريك خطٍّ في الترتيب: خطوةٌ واحدة، والطرفان ثابتان، والأصل لا يتغيّر', () => {
  const l = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(l, 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(l, 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(l, 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(l, 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(l, ['a', 'b', 'c']);
  assert.equal(sameList(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameList(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameList(['a'], ['a', 'b']), false);
});

test('تجميع القائمة لكل مندوب: الدوائم بترتيب الدورة ثم المؤقّتة، وخطّ اليوم من علامة الخادم، والمناديب بأسمائهم', () => {
  const row = (id: string, rep: string, o: Record<string, unknown> = {}) => ({
    id, name: id, isPermanent: true, routeDate: null, salesRepId: rep, salesRepName: rep === 'r1' ? 'يوسف' : 'أحمد',
    weekdays: [], rotationOrder: 0, scheduleMode: null, isToday: false, ...o,
  });
  const groups = groupByRep([
    row('D', 'r1', { isPermanent: false, routeDate: '2026-11-25', scheduleMode: 'rotation' }),
    row('B', 'r1', { rotationOrder: 1, scheduleMode: 'rotation', isToday: true }),
    row('A', 'r1', { rotationOrder: 0, scheduleMode: 'rotation' }),
    row('X', 'r2'),
  ]);
  assert.deepEqual(groups.map(g => g.salesRepName), ['أحمد', 'يوسف']);
  const g = groups[1];
  assert.equal(g.mode, 'rotation');
  assert.deepEqual(g.permanents.map(r => r.id), ['A', 'B']);
  assert.deepEqual(g.dated.map(r => r.id), ['D']);
  assert.equal(g.today?.id, 'B');
  assert.equal(groups[0].mode, 'single');
  assert.equal(groups[0].today, null);
  assert.equal(daysText([3, 0]), 'الأحد · الأربعاء');
  assert.equal(daysText([5], s => (s === 'الجمعة' ? 'Fri' : s)), 'Fri');
});

test('الترجمات: كل tr(\'…\') في نافذة خطوط السير وأسماء الطرق في القاموس بأربع لغات بلا عربية متسرّبة', () => {
  const ui = read('src', 'pages', 'RepRoutesPage.tsx');
  const used = new Set<string>(DIST_MODES.map(m => m.label));
  for (const m of ui.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) used.add(m[1]);
  for (const d of WEEKDAYS_AR) used.add(d);
  const missing = [...used].filter(k => !PHRASES[k]);
  assert.deepEqual(missing, [], `بلا ترجمة: ${missing.join(' | ')}`);
  for (const k of used) {
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(PHRASES[k][l].trim(), `${k}.${l} فارغ`);
      assert.doesNotMatch(PHRASES[k][l], /[؀-ۿ]/, `${k}.${l} فيه عربية`);
    }
  }
});

test('الواجهة: خطّ اليوم من الخادم لا من حسابٍ محلّي، والأيام تُرسَل في «حسب أيام الأسبوع» وحده، والطريقة والترتيب بمساريهما', () => {
  const ui = read('src', 'pages', 'RepRoutesPage.tsx');
  assert.match(ui, /r\.isToday &&/, 'علامة «خط اليوم» على الصفّ');
  assert.doesNotMatch(ui, /pickRouteForDay|getDay\(\)/, 'حسابٌ محلّي لخطّ اليوم يخالف الخادم');
  assert.match(ui, /\.\.\.\(isPermanent && repMode === 'weekdays' && \{ weekdays \}\)/);
  assert.match(ui, /repRouteApi\.setSchedule\(salesRepId,/);
  assert.match(ui, /repRouteApi\.setOrder\(salesRepId, order\.map\(r => r\.id\)\)/);
  // الحقول تُملأ مرّةً لا عند كل إعادة جلب (عيب المحرّر نفسه — repRoutesFixes.test.ts)
  assert.match(ui, /useEffect\(\(\) => \{ if \(q\.data && !view\) apply\(q\.data\); \}, \[q\.data, view\]\);/);
  assert.match(ui, /type="date" className="input w-40" value=\{start\}/, 'بداية التناوب تاريخٌ ميلاديّ');
  const api = read('src', 'api', 'client.ts');
  assert.match(api, /api\.get\(`\/rep-routes\/schedule\/\$\{salesRepId\}`/);
  assert.match(api, /api\.put\(`\/rep-routes\/schedule\/\$\{salesRepId\}`, body/);
  assert.match(api, /api\.put\(`\/rep-routes\/order\/\$\{salesRepId\}`, \{ ids \}/);
});
