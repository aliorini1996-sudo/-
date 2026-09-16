import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectPages } from './pages';

test('collectPages: يجلب كل الصفحات حتى الناقصة أو الإجمالي', async () => {
  const all = Array.from({ length: 2345 }, (_, i) => i);
  const offsets: number[] = [];
  const got = await collectPages(async (offset, limit) => { offsets.push(offset); return { rows: all.slice(offset, offset + limit), total: all.length }; });
  assert.equal(got.length, 2345);
  assert.deepEqual(offsets, [0, 1000, 2000]);
  const exact = await collectPages(async (offset, limit) => ({ rows: all.slice(0, 2000).slice(offset, offset + limit), total: 2000 }));
  assert.equal(exact.length, 2000);
});

test('مفتاح «كل الحسابات» له جالب واحد بترقيم الصفحات (لا قائمة مقطوعة من جالب آخر تحت المفتاح نفسه)', () => {
  const src = path.join(process.cwd(), 'src');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [p] : [];
  });
  const users: string[] = [];
  for (const f of walk(src)) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /ledgerKeys\.accounts\(\s*\{\s*all\s*:/, `مفتاح accounts({all}) قديم في ${f}`);
    for (const m of s.matchAll(/queryKey:\s*ledgerKeys\.allAccounts\b/g)) {
      const around = s.slice(m.index!, m.index! + 200);
      assert.match(around, /queryFn:\s*fetchAllLedgerAccounts\b/, `ledgerKeys.allAccounts بجالب آخر في ${f}`);
      users.push(path.basename(f));
    }
  }
  assert.ok(users.includes('MoveForm.tsx') && users.includes('configUi.tsx'), users.join(','));
});
