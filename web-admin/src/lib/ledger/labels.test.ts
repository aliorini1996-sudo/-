import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chunkIds, EXPORT_IDS_MAX, joinList } from './labels';
import { imageNeedsReencode, ATTACHMENT_IMAGE_MAX } from './attachments';

/** مساعدات عرض القوائم والتصدير والمرفقات في الدفاتر (§8.3، §8.7، §3.9). */

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, '../..', rel), 'utf8');

test('joinList: الفاصلة العربية للعربية وحدها', () => {
  assert.equal(joinList('ar', ['أ', 'ب']), 'أ، ب');
  for (const l of ['en', 'fr', 'tr', 'zh']) assert.equal(joinList(l, ['A', 'B']), 'A, B');
  assert.equal(joinList('en', []), '');
});

test('chunkIds: الفارغة بلا دفعات، والكبيرة دفعات ≤ السقف بلا فقد', () => {
  assert.deepEqual(chunkIds([]), []);
  const ids = Array.from({ length: 2501 }, (_, i) => `id${i}`);
  const chunks = chunkIds(ids);
  assert.equal(EXPORT_IDS_MAX, 1000);
  assert.deepEqual(chunks.map(c => c.length), [1000, 1000, 501]);
  assert.deepEqual(chunks.flat(), ids);
});

test('صفحات التهيئة لا تثبّت «، » في نصوص معروضة', () => {
  for (const f of ['pages/ledger/config/AccountList.tsx', 'pages/ledger/config/AccountForm.tsx', 'pages/ledger/config/MappingsPage.tsx']) {
    assert.ok(!src(f).includes(".join('، ')"), f);
  }
});

test('تصدير الحسابات: قائمة معرّفات فارغة لا تُرسل، والإرسال مقسّم بالسقف', () => {
  const s = src('pages/ledger/config/AccountList.tsx');
  assert.match(s, /exportIds && exportIds\.length === 0\) \{ toast\(/);
  assert.match(s, /chunkIds\(exportIds\)/);
  assert.ok(!s.includes('{ ids: exportIds }'));
});

test('imageNeedsReencode: JPEG/PNG الصغيرة كما هي، وغيرها أو الكبيرة تُعاد ترميزاً', () => {
  assert.equal(imageNeedsReencode('image/jpeg', 200 * 1024), false);
  assert.equal(imageNeedsReencode('image/png', ATTACHMENT_IMAGE_MAX), false);
  assert.equal(imageNeedsReencode('image/jpeg', ATTACHMENT_IMAGE_MAX + 1), true);
  for (const t of ['image/webp', 'image/gif', 'image/heic', 'image/bmp', '']) assert.equal(imageNeedsReencode(t, 200 * 1024), true, t);
});
