import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * البند 26 (مراجعة الاستيراد 2026-09-17): ربط فئة مستوردة بحساب إيراد في مسودة المعالج ثم التراجع عن دفعة المنتجات
 * يحذف الفئة، فكان applyStep3 يرمي GlNotFoundError ⇒ 404 دائم لزر «تفعيل الدفاتر». الآن يُتخطى الرابط ويُبلَّغ عنه.
 *
 * setup.ts يستورد config/database (Prisma) عند التحميل، فالدالة الصرفة تُقرأ من الملف وتُقيَّم معزولة.
 */

// الملف على ويندوز بنهايات CRLF؛ التطبيع يجعل الحرّاس النصية مستقلة عن نهاية السطر
const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'setup.ts'), 'utf8').split('\r\n').join('\n');

function applyStep3Body(): string {
  const a = SRC.indexOf('async function applyStep3(');
  assert.ok(a >= 0);
  const b = SRC.indexOf('\n}\n', a);
  return SRC.slice(a, b);
}

test('الحارس: applyStep3 لا يرمي GlNotFoundError للفئة ويعيد skippedCategoryLinks', () => {
  const body = applyStep3Body();
  assert.doesNotMatch(body, /GlNotFoundError\('ProductCategory'/);
  assert.match(body, /partitionCategoryLinks\(allLinks, cats\)/);
  assert.match(body, /return \{ renamed, categoryAccounts: links\.length, skippedCategoryLinks \}/);
  // المطبَّق فقط يُكتب في glProductCategoryAccount
  assert.match(body, /for \(const l of links\)/);
});

test('الحارس: رد /setup/commit يحمل step3 (ومعه skippedCategoryLinks)', () => {
  const a = SRC.indexOf("router.post('/setup/commit'");
  const c = SRC.slice(a, SRC.indexOf('// ═══ POST /setup/backfill ═══'));
  assert.match(c, /const step3Report = await applyStep3\(tx, tenantId, draft\)/);
  assert.match(c, /step3: step3Report,\n\s+\.\.\.\(rebasedImportEntries/);
});

// تقييم الدالة الصرفة كما هي في الملف (بلا تحميل Prisma)
function loadPartition(): (links: { categoryId: string; accountCode: string }[], ids: Set<string>) => {
  apply: { categoryId: string; accountCode: string }[]; skipped: { categoryId: string; accountCode: string }[];
} {
  const a = SRC.indexOf('export function partitionCategoryLinks');
  assert.ok(a >= 0, 'partitionCategoryLinks مُصدَّرة');
  const b = SRC.indexOf('\n}\n', a);
  const ts = SRC.slice(a, b + 2)
    .replace('export function partitionCategoryLinks<T extends CategoryLink>(links: readonly T[], existingIds: ReadonlySet<string>): { apply: T[]; skipped: CategoryLink[] } {',
      'function partitionCategoryLinks(links, existingIds) {')
    .replace('const apply: T[] = [];', 'const apply = [];')
    .replace('const skipped: CategoryLink[] = [];', 'const skipped = [];');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${ts}; return partitionCategoryLinks;`)();
}

test('partitionCategoryLinks: رابط فئة محذوفة يُتخطى والبقية تُطبَّق', () => {
  const partition = loadPartition();
  const links = [
    { categoryId: 'cat-live', accountCode: '411001' },
    { categoryId: 'cat-deleted', accountCode: '411002' },
  ];
  const r = partition(links, new Set(['cat-live']));
  assert.deepEqual(r.apply, [links[0]]);
  assert.deepEqual(r.skipped, [{ categoryId: 'cat-deleted', accountCode: '411002' }]);
  assert.deepEqual(partition([], new Set()), { apply: [], skipped: [] });
});
