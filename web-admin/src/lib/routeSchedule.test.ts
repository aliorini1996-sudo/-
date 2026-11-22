import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_DAYS, DEFAULT_OFF_DAYS, DIST_MODES, WEEKDAYS_AR, byIds, daysText, editorTakenDays, groupByRep, mergeOrder, modeOf, moveItem,
  planOrderSave, routesWithoutDays, sameList, sameMembers, takenDays, toggleDay, weekdaysGate,
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
  // أيام الدائم تُرسَل أيّاً كانت الطريقة (مراجعة ٢٢ نوفمبر) — وخطٌّ تعذّر تحميله لا يمحو أيامه
  assert.match(ui, /\.\.\.\(isPermanent && !loadFailed && \{ weekdays \}\)/);
  assert.doesNotMatch(ui, /repMode === 'weekdays' && \{ weekdays \}/);
  assert.match(ui, /repRouteApi\.setSchedule\(salesRepId,/);
  // الترتيب مبنيٌّ على خطوط الخادم الحاليّة لا على قائمة النافذة (مراجعة ٢٢ نوفمبر: ORDER_MISMATCH)
  assert.match(ui, /repRouteApi\.setOrder\(salesRepId, plan\.ids\)/);
  assert.doesNotMatch(ui, /setOrder\(salesRepId, order\.map/, 'قائمة النافذة القديمة تُرسَل');
  // كل جلبٍ جديد يُعاد ملؤه ما لم يغيّر المالك شيئاً — لا مرّةً واحدة (مراجعة ٢٢ نوفمبر)
  assert.match(ui, /useEffect\(\(\) => \{ if \(q\.data && !dirty\) apply\(q\.data\); \}, \[q\.dataUpdatedAt\]\);/);
  assert.doesNotMatch(ui, /!view\) apply\(q\.data\)/);
  assert.match(ui, /type="date" className="input w-40" value=\{start\}/, 'بداية التناوب تاريخٌ ميلاديّ');
  const api = read('src', 'api', 'client.ts');
  assert.match(api, /api\.get\(`\/rep-routes\/schedule\/\$\{salesRepId\}`/);
  assert.match(api, /api\.put\(`\/rep-routes\/schedule\/\$\{salesRepId\}`, body/);
  assert.match(api, /api\.put\(`\/rep-routes\/order\/\$\{salesRepId\}`, \{ ids \}/);
});

// ═══════════ مراجعة ٢٢ نوفمبر ٢٠٢٦ ═══════════

test('ترتيب التناوب عند الحفظ: لا كتابة ما لم يحرّك المالك شيئاً، والمُرسَل مبنيٌّ على خطوط الخادم الحاليّة، وتغيّرها يُعرض للمراجعة', () => {
  // دمج ترتيب المالك بخطوط الخادم: المحذوف يسقط، والجديد آخراً بترتيب الخادم
  assert.deepEqual(mergeOrder(['B', 'A', 'C'], ['A', 'B', 'D', 'E']), ['B', 'A', 'D', 'E']);
  assert.deepEqual(mergeOrder([], ['A', 'B']), ['A', 'B']);
  assert.deepEqual(mergeOrder(['A'], []), []);
  assert.equal(sameMembers(['A', 'B'], ['B', 'A']), true);
  assert.equal(sameMembers(['A', 'B'], ['A', 'C']), false);
  assert.equal(sameMembers(['A'], ['A', 'B']), false);
  assert.equal(sameMembers(['A', 'A'], ['A', 'B']), false);
  // لم يحرّك شيئاً ⇒ لا كتابة — ولو تغيّرت خطوط الخادم أو رتّبها غيره (لا تُدهَس بقائمةٍ قديمة)
  assert.deepEqual(planOrderSave(['A', 'B'], ['A', 'B'], ['A', 'B', 'C']), { kind: 'none' });
  assert.deepEqual(planOrderSave(['A', 'B'], ['A', 'B'], ['B', 'A']), { kind: 'none' });
  assert.deepEqual(planOrderSave(['A', 'B'], ['A', 'B'], ['A']), { kind: 'none' });
  // حرّك والخطوط نفسها ⇒ يُرسَل ترتيبه
  assert.deepEqual(planOrderSave(['A', 'B', 'C'], ['C', 'A', 'B'], ['A', 'B', 'C']), { kind: 'send', ids: ['C', 'A', 'B'] });
  // …ولا شيء إن كان ترتيب الخادم هو ما أراده أصلاً
  assert.deepEqual(planOrderSave(['A', 'B'], ['B', 'A'], ['B', 'A']), { kind: 'none' });
  // حرّك وحُذف خطٌّ أو أُضيف ⇒ لا إرسال، ومراجعةٌ بترتيبه على الخطوط الحاليّة
  assert.deepEqual(planOrderSave(['A', 'B', 'C'], ['C', 'B', 'A'], ['A', 'C']), { kind: 'review', ids: ['C', 'A'] });
  assert.deepEqual(planOrderSave(['A', 'B'], ['B', 'A'], ['A', 'B', 'D']), { kind: 'review', ids: ['B', 'A', 'D'] });
  // ثم الحفظ الثاني بعد المراجعة: الأساس صار خطوط الخادم ⇒ يُرسَل المدموج
  assert.deepEqual(planOrderSave(['A', 'B', 'D'], ['B', 'A', 'D'], ['A', 'B', 'D']), { kind: 'send', ids: ['B', 'A', 'D'] });
  // لا قائمةٌ قديمة أبداً: كل «إرسال» يطابق خطوط الخادم الحاليّة عضواً بعضو (ما يقبله PUT /order)
  const ids = ['A', 'B', 'C', 'D'];
  const perms = (l: string[]): string[][] => (l.length <= 1 ? [l] : l.flatMap((x, i) => perms([...l.slice(0, i), ...l.slice(i + 1)]).map(p => [x, ...p])));
  let sent = 0;
  for (const start of perms(ids.slice(0, 3))) {
    for (const current of perms(ids.slice(0, 3))) {
      for (const fresh of [['A', 'B', 'C'], ['C', 'B', 'A'], ['A', 'B'], ['A', 'B', 'C', 'D'], ['D']]) {
        const p = planOrderSave(start, current, fresh);
        if (p.kind === 'send') { sent += 1; assert.ok(sameMembers(p.ids, fresh), `${start}|${current}|${fresh}`); }
        if (sameList(current, start)) assert.equal(p.kind, 'none');
      }
    }
  }
  assert.ok(sent > 10, `إرسالٌ قليل: ${sent}`);
  assert.deepEqual(byIds([{ id: 'A', n: 1 }, { id: 'B', n: 2 }], ['B', 'X', 'A']).map(x => x.n), [2, 1]);
});

test('«حسب أيام الأسبوع» وخطوطٌ بلا أيام: كلّها ⇒ منع، وبعضها ⇒ سؤالٌ بأسمائها، وبلا دوائم ⇒ لا شيء', () => {
  const r = (name: string, weekdays: number[] | null) => ({ id: name, name, weekdays });
  assert.deepEqual(routesWithoutDays([r('أ', [1]), r('ب', []), r('ج', null)]).map(x => x.name), ['ب', 'ج']);
  assert.deepEqual(weekdaysGate([r('أ', []), r('ب', null)]), { block: true, missing: ['أ', 'ب'] });
  assert.deepEqual(weekdaysGate([r('أ', [0]), r('ب', [])]), { block: false, missing: ['ب'] });
  assert.deepEqual(weekdaysGate([r('أ', [0])]), { block: false, missing: [] });
  assert.deepEqual(weekdaysGate([]), { block: false, missing: [] });
});

test('أيام الخطّ في المحرّر أيّاً كانت الطريقة: أيام الخطوط الباقية محجوزة، و«خط واحد يومياً» يستبدل دائمه فلا يحجز', () => {
  const routes = [{ id: 'A', name: 'الشمال', weekdays: [0, 1] }, { id: 'B', name: 'الجنوب', weekdays: [2] }];
  assert.deepEqual([...editorTakenDays('rotation', routes, 'A').entries()], [[2, 'الجنوب']]);
  assert.deepEqual([...editorTakenDays('weekdays', routes).keys()].sort(), [0, 1, 2]);
  assert.equal(editorTakenDays('single', routes).size, 0);
});

test('الواجهة (مراجعة ٢٢ نوفمبر): الأسهم والطريقة والبداية والراحة تُعلِّم التغيير، وORDER_MISMATCH يُراجَع، و«حسب الأيام» يمنع أو يسأل، والأيام في المحرّر لكل دائم', () => {
  const ui = read('src', 'pages', 'RepRoutesPage.tsx');
  const panel = ui.slice(ui.indexOf('function RepSchedulePanel('), ui.indexOf('function RouteEditor('));
  assert.ok(panel.length > 1000);
  // كل تغييرٍ من المالك يُعلِّم dirty — الطريقة والبداية وأيام الراحة والسهمان
  assert.match(panel, /const touch = \(\) => \{ setDirty\(true\); setMsg\(null\); \};/);
  assert.match(panel, /setMode\(m\.mode\); touch\(\);/);
  assert.match(panel, /setStart\(e\.target\.value\); touch\(\);/);
  assert.match(panel, /setOffDays\(v => toggleDay\(v, d\)\); touch\(\);/);
  assert.equal((panel.match(/setOrder\(v => moveItem\(v, i, -?1\)\); touch\(\);/g) || []).length, 2, 'السهمان');
  // الحفظ: الخطّة من الأساس الذي بدأ منه المالك وردّ الخادم الطازج، وسباق ORDER_MISMATCH يُجلب ويُراجَع
  assert.match(panel, /planOrderSave\(startIds, order\.map\(r => r\.id\), v\.routes\.map\(r => r\.id\)\)/);
  assert.match(panel, /if \(errCode\(e\) !== 'ORDER_MISMATCH'\) throw e;/);
  assert.match(panel, /setMsg\(\{ tone: 'err', text: tr\('تغيرت خطوط المندوب أثناء التعديل/);
  assert.match(panel, /apply\(v\);\s*\n\s*setDirty\(false\);/, 'الحفظ الناجح يعيد التتبّع للخادم');
  // «حسب أيام الأسبوع»: المنع حين لا أيام لأي خط، والسؤال بالأسماء حين لبعضها
  assert.match(panel, /const gate = weekdaysGate\(order\);/);
  assert.match(panel, /mode === 'weekdays' \? !gate\.block/);
  assert.match(panel, /window\.confirm\(`\$\{tr\('هذه الخطوط بلا أيام ولن تظهر للمندوب'\)\}: \$\{gate\.missing\.join\('، '\)\}/);
  assert.match(panel, /onClick=\{submit\}/);
  // المحرّر: الأيام لكل دائمٍ أيّاً كانت الطريقة، والمحجوز من الخطوط الباقية
  const editor = ui.slice(ui.indexOf('function RouteEditor('));
  assert.match(editor, /\{isPermanent && salesRepId && \(\s*\n\s*<div className="mt-3">\s*\n\s*<p className="label text-xs">\{tr\('أيام الخط'\)\}/);
  assert.doesNotMatch(editor, /isPermanent && salesRepId && repMode === 'weekdays' &&/);
  assert.match(editor, /editorTakenDays\(repMode, schedQ\.data\?\.routes \?\? \[\], id\)/);
});
