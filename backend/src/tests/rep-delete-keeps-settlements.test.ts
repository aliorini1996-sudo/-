// حذف المندوب يُبقي «استلامات التحصيل» منه (مراجعة ٣٠ أكتوبر ٢٠٢٦، بند audit-schema).
//
// الاستلام هو «المستلَم» في عهدة مستخدم الشركة الذي استلم (services/userCustody.ts: المستلَم − الموَرَّد). وكان حذف
// المندوب يمحوه (deleteMany وCascade): فتصفر عهدةُ مالٍ ما زال في يد المستلِم، أو تصير سالبةً بعد توريده — متجاوزاً حارسَي
// حذف الاستلام الواحد. الآن يُفرَّغ مرجع المندوب ويُحفظ معرّفه كتحميلات السيارة، والدفاتر تراه غائباً كما كانت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userCustody } from '../services/userCustody';
import { SETTLEMENT_HAS_REP, settlementHasRep } from '../services/gl/settlementRep';

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('المخطط: مرجع المندوب يقبل الفراغ بـSetNull، ومعرّفه بعد الحذف في deletedSalesRepId', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = schema.slice(schema.indexOf('model RepSettlement {'), schema.indexOf('\n}', schema.indexOf('model RepSettlement {')));
  assert.match(model, /salesRepId String\?\n/);
  assert.match(model, /salesRep\s+SalesRep\? @relation\(fields: \[salesRepId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(model, /deletedSalesRepId String\?/);
  assert.doesNotMatch(model, /salesRep\s+SalesRep @relation\([^)]*onDelete: Cascade/, 'Cascade يمحو الاستلامات مع المندوب');
});

test('مسار الحذف: يفرّغ الاستلامات بمعرّف المندوب ولا يمحوها', () => {
  const src = read('routes/salesReps.ts');
  const body = src.slice(src.indexOf("router.delete('/:id',"), src.indexOf('// ===== إسناد العملاء للمندوب'));
  assert.match(body, /tx\.repSettlement\.updateMany\(\{ where: \{ tenantId: tid, salesRepId: req\.params\.id \}, data: \{ salesRepId: null, deletedSalesRepId: req\.params\.id \} \}\)/);
  assert.doesNotMatch(body, /repSettlement\.delete(?:Many)?\(/);
});

test('العهدة: استلامٌ بلا مندوب (محذوف) يبقى في «المستلَم» — لا تصفر عهدةٌ ولا تصير سالبة', async () => {
  // سعد استلم ١٠٬٠٠٠ من أحمد (حُذف أحمد فصار salesRepId=null) وورّد ٤٬٠٠٠
  const rows = [{ tenantId: 't1', receivedByUserId: 'saad', salesRepId: null, deletedSalesRepId: 'ahmad', amount: 10_000 }];
  const sum = (xs: { amount: number }[]) => ({ _sum: { amount: xs.reduce((s, x) => s + x.amount, 0) } });
  const db = {
    repSettlement: { aggregate: async (a: { where: Record<string, unknown> }) => sum(rows.filter((r) => r.tenantId === a.where.tenantId && r.receivedByUserId === a.where.receivedByUserId)) },
    userSettlement: { aggregate: async () => ({ _sum: { amount: 4_000 } }) },
  };
  const c = await userCustody(db as never, 't1', 'saad');
  assert.deepEqual(c, { received: 10_000, delivered: 4_000, outstanding: 6_000 });
});

test('الدفاتر: استلام المندوب المحذوف غائب عنها كما كان — المرشّح والحارس', () => {
  assert.deepEqual(SETTLEMENT_HAS_REP, { salesRepId: { not: null } });
  const rows = [{ id: 'a', salesRepId: 'r1' }, { id: 'b', salesRepId: null }];
  assert.deepEqual(rows.filter(settlementHasRep).map((r) => r.id), ['a']);
});

test('حارس نصّي: كل قراءةٍ لاستلامات التحصيل في الدفاتر مرشَّحةٌ بمندوبٍ قائم', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(path.join(SRC, 'services', 'gl'));
  let reads = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/repSettlement\.(findMany|findFirst|groupBy)\(/g)) {
      reads++;
      const call = s.slice(m.index!, m.index! + 400);
      assert.match(call, /SETTLEMENT_HAS_REP|salesRepId[,:]/, `${path.relative(SRC, f)}: قراءة استلامات بلا مرشّح المندوب القائم`);
    }
  }
  assert.ok(reads >= 8, `عدد القراءات ${reads} — الماسح لم يجد ما يكفي`);
});
