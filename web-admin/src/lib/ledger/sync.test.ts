import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EVENT_ACTION_ALLOWED, checkTitles, eventActionsFor, eventNoteText, milliAmount, postingStateLabels, postingTone,
  sourceDocumentHref, eventStatusLabels,
} from './sync';

const id = (s: string) => s;
const backend = path.resolve(process.cwd(), '..', 'backend', 'src');

test('الإجراءات المسموحة لكل حالة حدث تطابق eventActions.ts في الخادم', () => {
  assert.deepEqual(eventActionsFor('ERROR'), ['retry', 'skip']);
  assert.deepEqual(eventActionsFor('BLOCKED'), ['retry', 'skip']);
  assert.deepEqual(eventActionsFor('HELD'), ['release', 'skip']);
  assert.deepEqual(eventActionsFor('PENDING'), ['skip']);
  assert.deepEqual(eventActionsFor('DONE'), []);
  assert.deepEqual(eventActionsFor('SKIPPED'), []);
  const f = path.join(backend, 'services', 'gl', 'checks', 'eventActions.ts');
  if (!fs.existsSync(f)) return;
  const s = fs.readFileSync(f, 'utf8');
  for (const [action, statuses] of Object.entries(EVENT_ACTION_ALLOWED)) {
    const m = new RegExp(`${action}:\\s*\\[([^\\]]*)\\]`).exec(s);
    assert.ok(m, `EVENT_ACTION_ALLOWED.${action} غير موجود في الخادم`);
    assert.deepEqual([...m[1].matchAll(/'([A-Z]+)'/g)].map(x => x[1]).sort(), [...statuses].sort(), action);
  }
});

test('عناوين الفحوص تغطي CHECK_KEYS في الخادم، وتسميات الحالات كاملة', () => {
  const f = path.join(backend, 'services', 'gl', 'checks', 'types.ts');
  if (fs.existsSync(f)) {
    const m = /CHECK_KEYS\s*=\s*\[([^\]]*)\]/.exec(fs.readFileSync(f, 'utf8'));
    assert.ok(m);
    const keys = [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]);
    assert.deepEqual(Object.keys(checkTitles(id)).sort(), keys.sort());
  }
  assert.equal(Object.keys(eventStatusLabels(id)).length, 6);
  assert.equal(Object.keys(postingStateLabels(id)).length, 10);
});

test('حالة الترحيل ولونها، وسبب الحدث المفكوك، والمبلغ بالملّي، ورابط المستند', () => {
  assert.equal(postingTone('POSTED'), 'green');
  assert.equal(postingTone('HELD'), 'red');
  assert.equal(postingTone('REVERSE_PENDING'), 'amber');
  assert.equal(postingTone('IN_OPENING'), 'gray');
  assert.equal(eventNoteText(id, { kind: 'HELD', reason: 'MISSING_MAPPING', detail: 'SALES_REVENUE' }), 'حساب مربوط غير موجود أو مؤرشف (SALES_REVENUE)');
  assert.equal(eventNoteText(id, { kind: 'BLOCKED', reason: 'SIBLING_NOT_FINAL', step: 2 }), 'بانتظار ترحيل الحدث الأصلي');
  assert.equal(eventNoteText(id, { kind: 'ERROR', message: 'boom' }), 'boom');
  assert.equal(eventNoteText(id, null), null);
  assert.equal(milliAmount('-3210340'), '-3210.340');
  assert.equal(milliAmount(null), '0');
  assert.equal(sourceDocumentHref('INVOICE', { customerId: 'c 1' }), '/app/customers?open=c%201');
  assert.equal(sourceDocumentHref('INVOICE'), '/app/invoices');
  assert.equal(sourceDocumentHref('SETTLEMENT'), '/app/sales-reps');
  assert.equal(sourceDocumentHref('PAYOUT'), '/app/paylink');
  assert.equal(sourceDocumentHref(null), null);
});
