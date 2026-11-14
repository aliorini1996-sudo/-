// «ربط الدفاتر» L2+L3 — تكامل الدفعة: المهمة الحقيقية (jobs.ts) تشغّل runPreview الحقيقي بكل وحداته (محرّك التكلفة C1–C2،
// والظلّ والتجميع P1، والافتتاح P2، والفحوص P3، والمطابقة P4) على قاعدتين مزيّفتين جاسوستين كما في الإنتاج: الرئيسية (صفّ
// المعاينة gl_link_previews وقراءة الإعدادات) وعميل المعاينة (لقطة READ ONLY على البيانات التشغيلية).
// يثبت: لا كتابة في أي جدول غير gl_link_previews، ولا قراءة gl* من القاعدة إلا حارس التفعيل؛ والشركة اليدوية المفعّلة لا
// يُنشأ لها صفّ ولا تُشغَّل لها معاينة؛ والشيفرة الإنتاجية القائمة لا تستورد الوحدات الجديدة (مظلمة) إلا مسارها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getPreview, previewWorkerIdle, startPreview, type PreviewJobDeps } from '../services/gl/linking/jobs';
import { runPreview } from '../services/gl/linking/preview';
import { FIX_DB_NOW, buildLinkingScenario } from './linking-fake-db';
import { createFakeLinkingDb, fakeClock, type FakeLinkingDb, type Row } from './p5-linking-jobs-fake';

const TID = 't1';
const SRC = path.join(__dirname, '..');

function seedMain(f: FakeLinkingDb, tenantId: string, settings: Row | null): void {
  if (settings) f.settings.set(tenantId, { tenantId, ...settings });
  f.tenants.set(tenantId, { id: tenantId, accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: true });
  f.companies.set(tenantId, { tenantId, countryCode: 'SA', currency: 'SAR', currencyOverride: null });
}

function harness() {
  const s = buildLinkingScenario();
  const f = createFakeLinkingDb();
  const clock = fakeClock(FIX_DB_NOW.toISOString());
  const runs: string[] = [];
  const deps: PreviewJobDeps = {
    db: f.db as unknown as PreviewJobDeps['db'],
    // عميل المعاينة المخصّص = القاعدة التشغيلية المزيّفة نفسها (تحصي كل قراءة وترفض كل كتابة)
    previewDb: () => s.db.client as unknown as ReturnType<PreviewJobDeps['previewDb']>,
    runPreview: ((db, tenantId, opts, hooks) => {
      runs.push(tenantId);
      return runPreview(db, tenantId, opts, hooks);
    }) as PreviewJobDeps['runPreview'],
    now: clock.now,
    parseDraft: () => null,
    env: {},
    timing: { progressMinMs: 0, heartbeatMs: 60_000, queueRetryMs: 20 },
    log: () => undefined,
  };
  return { s, f, deps, runs };
}

test('تكامل: المهمة ⇒ runPreview الحقيقي ⇒ DONE بالمطابقة، ولا كتابة إلا gl_link_previews، ولا قراءة gl* من القاعدة إلا حارس التفعيل', async () => {
  const { s, f, deps, runs } = harness();
  seedMain(f, TID, null);
  const started = await startPreview(deps, { tenantId: TID, basis: 'FY_RESTATED', requestedBy: 'owner-1' });
  assert.ok('id' in started && started.status === 'QUEUED' && started.existing === false);
  await previewWorkerIdle();
  const view = await getPreview(deps, TID, started.id);
  assert.ok(view);
  assert.equal(view.status, 'DONE', `${view.errorCode}: ${view.error}`);
  assert.deepEqual(runs, [TID]);
  assert.match(view.dataHash ?? '', /^[0-9a-f]{64}$/);
  assert.match(view.resultHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(view.linkedFrom, '2027-01-01');
  const r = view.result!;
  assert.equal(r.preflight.mode, 'FULL');
  for (const code of ['R1', 'R2', 'R3', 'R5'] as const) assert.equal(r.parity.find((p) => p.code === code)?.status, 'OK', code);
  // JSON بلا BigInt: كل *Milli نصّ
  assert.equal(typeof r.opening.totals.debitMilli, 'string');

  // الرئيسية: الكتابة الوحيدة صفّ المعاينة، وما سواه قراءة إعدادات
  assert.ok(f.writes.length > 0);
  assert.deepEqual(f.writes.filter((w) => !w.startsWith('glLinkPreview.')), [], 'لا كتابة إلا gl_link_previews');
  assert.deepEqual([...new Set(f.calls.filter((c) => !c.startsWith('glLinkPreview.')))].sort(),
    ['companySettings.findUnique', 'glSettings.findUnique', 'tenant.findUnique']);
  // عميل المعاينة: صفر كتابات (والقاعدة ترفضها أصلاً)، وقراءة gl* الوحيدة حارس التفعيل داخل اللقطة
  assert.equal(s.db.writeCount(), 0);
  assert.deepEqual([...s.db.stats.reads.keys()].filter((k) => /^gl[A-Z]/.test(k)), ['glSettings.findUnique']);
  assert.match(s.db.stats.raw[0], /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/);
});

test('تكامل: الشركة اليدوية المفعّلة (CLEAN) ⇒ alreadyActivated بلا صفّ ولا معاينة ولا قراءة تشغيلية', async () => {
  const { s, f, deps, runs } = harness();
  seedMain(f, TID, { activatedAt: new Date('2026-03-01T09:00:00Z'), setupMethod: 'CLEAN', templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
  const out = await startPreview(deps, { tenantId: TID, basis: 'FY_RESTATED', requestedBy: 'owner-1' });
  assert.deepEqual(out, { alreadyActivated: true });
  await previewWorkerIdle();
  assert.deepEqual(runs, []);
  assert.equal(f.previews.length, 0);
  // تعليم المنقطعات (updateMany بلا صفوف) وحده — لا صفّ يُنشأ ولا يُمسّ
  assert.deepEqual(f.writes.filter((w) => w !== 'glLinkPreview.updateMany'), []);
  assert.ok(f.updateLog.every((u) => u.count === 0));
  assert.equal(s.db.readCount(), 0, 'لا قراءة من البيانات التشغيلية');
});

test('مظلمة: الشيفرة الإنتاجية القائمة لا تستورد محرّك التكلفة ولا وحدات الربط — مسار الربط وحده (والمُركِّب بسطرين)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests') walk(p); } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(SRC);
  const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, '/');
  const inside = (r: string) => r.startsWith('services/costing/') || r.startsWith('services/gl/linking/');
  const importers = new Map<string, string[]>();
  for (const file of files) {
    const r = rel(file);
    if (inside(r)) continue;
    const src = fs.readFileSync(file, 'utf8');
    // الاستيراد القيمي وحده (import type يُمحى عند الترجمة — opening.ts يستورد نوع سطور الافتتاح المشتقّة)
    for (const m of src.matchAll(/^\s*(?:import|export)(\s+type)?\s[^;']*?from '([^']+)'/gm)) {
      if (m[1] || !m[2].startsWith('.')) continue;
      const target = rel(path.resolve(path.dirname(file), m[2]));
      if (inside(`${target}/`) || inside(target) || target === 'services/receiptMethodUsage' || target === 'routes/ledger/linking') {
        importers.set(r, [...(importers.get(r) ?? []), target]);
      }
    }
  }
  assert.deepEqual([...importers.keys()].sort(), ['routes/ledger/index.ts', 'routes/ledger/linking.ts', 'services/gl/opening.ts']);
  assert.deepEqual(importers.get('routes/ledger/index.ts'), ['routes/ledger/linking']);
  // opening.ts (المسار اليدوي يمرّ به): ثوابت المواقع الصرفة من costing/types وحدها — لا محرّك ولا قاعدة
  assert.deepEqual(importers.get('services/gl/opening.ts'), ['services/costing/types']);
  // وحدة أسماء طرق الدفع الجديدة لا يستوردها إلا فحص P8
  const usage = files.filter((p) => /receiptMethodUsage'/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert.deepEqual(usage, ['services/gl/linking/preflight.ts']);
});
