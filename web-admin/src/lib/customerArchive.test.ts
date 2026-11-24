import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEntries, filterEntries, handoversOf, lastOf, repsOf, sortEntries, type ArchiveItem, type ArchiveVisit } from './customerArchive';

// «أرشيف العميل» (طلب المالك ٢١ نوفمبر ٢٠٢٦): سجلٌّ زمني يعرف منه من تسلّم العميل أين توقّف سابقه

const visit = (id: string, at: string, repId: string, rep: string, note: string | null = null, photoIds: string[] = []): ArchiveVisit =>
  ({ id, at, repId, rep, note, durationSec: null, startedAt: null, endedAt: null, lat: null, lng: null, photoIds });

const VISITS = [
  visit('v1', '2026-10-01T08:00:00Z', 'a', 'أحمد', 'أول زيارة — طلب عرض سعر'),
  visit('v2', '2026-10-05T08:00:00Z', 'a', 'أحمد', null, ['p1', 'p2']),
  visit('v3', '2026-11-02T08:00:00Z', 'b', 'صالح', 'وعد بالسداد نهاية الشهر'),
  visit('v4', '2026-11-20T08:00:00Z', 'b', 'صالح'),
];

test('كل زيارة في السجلّ — بلا صور وبلا ملاحظة أيضاً — وصورها معها', () => {
  const items: ArchiveItem[] = [
    { source: 'doc', id: 'd1', at: '2026-10-02T09:00:00Z', by: 'المدير', kind: 'CR' },
    { source: 'receipt', id: 'rp1', at: '2026-11-03T09:00:00Z', by: 'صالح', receiptId: 'r1', number: 'RC-1' },
    { source: 'receipt', id: 'rp2', at: '2026-11-03T09:00:00Z', by: 'صالح', receiptId: 'r1', number: 'RC-1' },
    { source: 'visit', id: 'p1', at: '2026-10-05T08:00:00Z', by: 'أحمد', visitId: 'v2' },
  ];
  const e = buildEntries({ items, visits: VISITS });
  assert.equal(e.filter((x) => x.type === 'visit').length, 4, 'زيارة بلا صور تُفقد');
  const v2 = e.find((x) => x.type === 'visit' && x.v.id === 'v2');
  assert.deepEqual(v2 && v2.type === 'visit' ? v2.photos.map((p) => p.id) : [], ['p1', 'p2']);
  assert.equal(e.filter((x) => x.type === 'doc').length, 1);
  const r = e.filter((x) => x.type === 'receipt');
  assert.equal(r.length, 1, 'مرفقات السند الواحد بندٌ واحد');
  assert.equal(r[0].type === 'receipt' ? r[0].photos.length : 0, 2);
  assert.equal(e.length, 6, 'صورة الزيارة في الشبكة لا تتكرّر بنداً في السجلّ');
});

test('الفرز بالمندوب بمعرّفه لا باسمه: سنداته، ووثائقٌ رفعها هو — لا مديرٌ يحمل اسمه ولا زميلٌ بالاسم نفسه', () => {
  const items: ArchiveItem[] = [
    { source: 'doc', id: 'd1', at: '2026-10-02T09:00:00Z', by: 'أحمد', byKind: 'REP', byId: 'a', kind: 'CR' },
    { source: 'doc', id: 'd2', at: '2026-10-03T09:00:00Z', by: 'أحمد', byKind: 'ADMIN', byId: 'a', kind: 'ID' },
    { source: 'receipt', id: 'rp1', at: '2026-11-03T09:00:00Z', by: 'أحمد', repId: 'z', receiptId: 'r1', number: 'RC-1' },
    { source: 'receipt', id: 'rp2', at: '2026-11-04T09:00:00Z', by: 'أحمد', repId: 'a', receiptId: 'r2', number: 'RC-2' },
  ];
  const e = buildEntries({ items, visits: VISITS });
  assert.deepEqual(filterEntries(e, { repId: 'a' }).map((x) => x.key).sort(), ['d-d1', 'r-r2', 'v-v1', 'v-v2']);
  assert.deepEqual(filterEntries(e, { q: 'السداد' }).map((x) => x.key), ['v-v3']);
  assert.deepEqual(filterEntries(e, { q: 'RC-1' }).map((x) => x.key), ['r-r1']);
  assert.deepEqual(filterEntries(e, { q: 'سجل', labelOf: (x) => (x.type === 'doc' && x.item.kind === 'CR' ? 'السجل التجاري' : '') }).map((x) => x.key), ['d-d1']);
});

test('الترتيب: الأحدث أولاً والأقدم أولاً', () => {
  const e = buildEntries({ items: [], visits: VISITS });
  assert.deepEqual(sortEntries(e, 'desc').map((x) => x.key), ['v-v4', 'v-v3', 'v-v2', 'v-v1']);
  assert.deepEqual(sortEntries(e, 'asc').map((x) => x.key), ['v-v1', 'v-v2', 'v-v3', 'v-v4']);
});

test('تسلّم المندوب يُعلَّم عند أول زيارةٍ للجديد — ومن قبله', () => {
  const h = handoversOf([...VISITS].reverse());
  assert.deepEqual([...h.entries()], [['v3', 'أحمد']]);
  // عودة المندوب الأول بعد الثاني تسلّمٌ ثانٍ
  const back = handoversOf([...VISITS, visit('v5', '2026-11-21T08:00:00Z', 'a', 'أحمد')]);
  assert.deepEqual([...back.entries()], [['v3', 'أحمد'], ['v5', 'صالح']]);
  assert.equal(handoversOf([VISITS[0]]).size, 0);
});

test('أين توقّفنا: آخر زيارة، وآخر ملاحظةٍ مكتوبة وإن كانت أقدم، ومن خدم العميل بالأحدث', () => {
  const { last, lastNoted } = lastOf(VISITS);
  assert.equal(last?.id, 'v4');
  assert.equal(lastNoted?.note, 'وعد بالسداد نهاية الشهر');
  assert.deepEqual(repsOf(VISITS).map((r) => [r.rep, r.count]), [['صالح', 2], ['أحمد', 2]]);
  assert.deepEqual(lastOf([]), { last: null, lastNoted: null });
});

test('الواجهة: «أرشيف العميل» بالسجلّ الزمني افتراضياً، وصور الزيارات تمرّ بفحص safeImage، ورابط الموقع آمن', () => {
  const s = readFileSync(new URL('../components/CustomerStudioModal.tsx', import.meta.url), 'utf8');
  assert.match(s, /useState<'timeline' \| 'gallery'>\('timeline'\)/);
  assert.match(s, /tr\('أرشيف العميل'\)/);
  assert.match(s, /const data = safeImage\(/);
  assert.match(s, /target="_blank" rel="noopener noreferrer"/);
  const page = readFileSync(new URL('../pages/CustomersPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /title=\{tr\('أرشيف العميل'\)\}/);
  assert.doesNotMatch(page, /tr\('استديو العميل'\)/);
});
