// «الفرق» في تطبيق المندوب (repTeam.ts) — مرآة backend/src/tests/teams.test.ts في الحالات نفسها
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTeamOf, productInTeam, repTeams, sellableNow } from './repTeam';

const A = { id: 'A', name: 'المكسرات' }, B = { id: 'B', name: 'المنظفات' };

test('فرق المندوب: حين فعّلت الشركة الميزة وحدها', () => {
  assert.deepEqual(repTeams({ id: 'r', teamsEnabled: true, teams: [A, B] }), [A, B]);
  assert.deepEqual(repTeams({ id: 'r', teamsEnabled: false, teams: [A] }), [], 'مطفأة');
  assert.deepEqual(repTeams({ id: 'r' }), [], 'نسخة خادمٍ أقدم بلا الحقلين');
  assert.deepEqual(repTeams(null), []);
});

test('الفريق الحالي: المحفوظ إن بقي من فرقه، وإلا أولها، وبلا فرق null', () => {
  const u = { id: 'r', teamsEnabled: true, teams: [A, B] };
  assert.equal(activeTeamOf(u, 'B'), 'B');
  assert.equal(activeTeamOf(u, 'X'), 'A', 'فريقٌ أُزيل منه المندوب');
  assert.equal(activeTeamOf(u, null), 'A');
  assert.equal(activeTeamOf({ id: 'r', teamsEnabled: false, teams: [A] }, 'A'), null);
});

test('أصناف الفريق: العامّ للجميع، والخاص لفرقه، وبلا فريقٍ حالي لا تقييد', () => {
  assert.equal(productInTeam({ teams: [] }, 'A'), true);
  assert.equal(productInTeam({}, 'A'), true);
  assert.equal(productInTeam({ teams: [{ teamId: 'A' }] }, 'A'), true);
  assert.equal(productInTeam({ teams: [{ teamId: 'A' }] }, 'B'), false);
  assert.equal(productInTeam({ teams: [{ teamId: 'A' }, { teamId: 'B' }] }, 'B'), true, 'مشترك');
  assert.equal(productInTeam({ teams: [{ teamId: 'A' }] }, null), true);
});

test('ما يبيعه المندوب الآن: مرآة الخادم — مطفأة الكل، فريقٌ حالي أصنافه والعامة، وبلا فرق العامة وحدها', () => {
  const nuts = { teams: [{ teamId: 'A' }] }, general = { teams: [] };
  assert.equal(sellableNow(nuts, { id: 'r', teamsEnabled: false }, null), true, 'مطفأة');
  assert.equal(sellableNow(nuts, { id: 'r', teamsEnabled: true, teams: [A] }, 'A'), true);
  assert.equal(sellableNow(nuts, { id: 'r', teamsEnabled: true, teams: [B] }, 'B'), false);
  assert.equal(sellableNow(nuts, { id: 'r', teamsEnabled: true, teams: [] }, null), false, 'مندوبٌ بلا فرق: الخاص ممنوع');
  assert.equal(sellableNow(general, { id: 'r', teamsEnabled: true, teams: [] }, null), true);
});
