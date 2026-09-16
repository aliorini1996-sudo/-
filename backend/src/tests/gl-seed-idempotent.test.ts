// M2 — زرع القالب متساوي الأثر (DESIGN.md §4.5، §6.1، §10.1 صف M2: gl-seed-idempotent.test.ts).
// seedTemplate خلف مخزن مزيّف في الذاكرة يفرض القيود الفريدة ويرمي خطأً بشكل Prisma P2002، ويرفض أي تعديل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { seedTemplate, resolveTemplate, type SeedDb } from '../services/gl/seed';
import { SA_6D_ACCOUNTS, SA_6D_JOURNALS, VAT_ACCOUNT_CODES } from '../services/gl/coa/sa';
import { SA_TAXES } from '../services/gl/taxes/sa';
import { MAPPING_KEYS, isLedgerError } from '../services/gl/types';

type Row = Record<string, unknown>;

class P2002 extends Error {
  code = 'P2002';
  meta: { target: string[] };
  constructor(target: string[]) {
    super(`Unique constraint failed on the fields: (${target.join(', ')})`);
    this.meta = { target };
  }
}

/** جدول في الذاكرة بشكل مندوب Prisma: findMany/findUnique/createMany/create، والتعديل ممنوع. */
class FakeTable {
  rows: Row[] = [];
  /** تكرارات تخطّاها skipDuplicates — يجب أن تبقى 0: الزرع يبحث قبل أن ينشئ */
  skippedDuplicates = 0;
  forbidden: string[] = [];
  constructor(readonly name: string, readonly uniques: string[][], readonly defaults: Row = {}) {}

  private matches(r: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, v]) => r[k] === v);
  }
  private project(r: Row, select?: Record<string, boolean>): Row {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, on] of Object.entries(select)) if (on) out[k] = r[k] ?? null;
    return out;
  }
  private dupOf(row: Row): string[] | null {
    for (const u of this.uniques) {
      if (u.some((f) => row[f] === null || row[f] === undefined)) continue; // NULL لا يتصادم (Postgres)
      if (this.rows.some((r) => u.every((f) => r[f] === row[f]))) return u;
    }
    return null;
  }
  private insert(data: Row): Row {
    const row: Row = { id: crypto.randomUUID(), ...this.defaults, ...data };
    this.rows.push(row);
    return row;
  }

  async findMany(args: { where?: Row; select?: Record<string, boolean> } = {}) {
    return this.rows.filter((r) => this.matches(r, args.where)).map((r) => this.project(r, args.select));
  }
  async findUnique(args: { where: Row; select?: Record<string, boolean> }) {
    const r = this.rows.find((x) => this.matches(x, args.where));
    return r ? this.project(r, args.select) : null;
  }
  async create(args: { data: Row }) {
    const dup = this.dupOf(args.data);
    if (dup) throw new P2002(dup);
    return this.insert(args.data);
  }
  async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
    let count = 0;
    for (const d of args.data) {
      const dup = this.dupOf(d);
      if (dup) {
        if (!args.skipDuplicates) throw new P2002(dup);
        this.skippedDuplicates++;
        continue;
      }
      this.insert(d);
      count++;
    }
    return { count };
  }
  private deny(op: string) {
    return async () => {
      this.forbidden.push(op);
      throw new Error(`${this.name}.${op} ممنوع في الزرع`);
    };
  }
  update = this.deny('update');
  updateMany = this.deny('updateMany');
  upsert = this.deny('upsert');
  delete = this.deny('delete');
  deleteMany = this.deny('deleteMany');
}

function fakeDb() {
  const t = {
    glAccount: new FakeTable('glAccount', [['tenantId', 'code']], { isActive: true, isSystem: false, reconcile: false, templateRef: null }),
    glAccountTag: new FakeTable('glAccountTag', [['tenantId', 'name']]),
    glAccountTagLink: new FakeTable('glAccountTagLink', [['accountId', 'tagId']]),
    glAccountMapping: new FakeTable('glAccountMapping', [['tenantId', 'key']]),
    glJournal: new FakeTable('glJournal', [['tenantId', 'code']], { systemKey: null }),
    glTax: new FakeTable('glTax', [['tenantId', 'key']], { key: null }),
    glSettings: new FakeTable('glSettings', [['tenantId']], { timezone: 'Asia/Riyadh' }),
  };
  return { tables: t, db: t as unknown as SeedDb };
}

function totals(tables: ReturnType<typeof fakeDb>['tables'], tenantId: string) {
  const c = (x: FakeTable) => x.rows.filter((r) => r.tenantId === tenantId).length;
  return {
    accounts: c(tables.glAccount), tags: c(tables.glAccountTag), tagLinks: c(tables.glAccountTagLink),
    mappings: c(tables.glAccountMapping), journals: c(tables.glJournal), taxes: c(tables.glTax), settings: c(tables.glSettings),
  };
}

function assertNoDuplicatesOrWrites(tables: ReturnType<typeof fakeDb>['tables']) {
  for (const x of Object.values(tables)) {
    assert.equal(x.skippedDuplicates, 0, `${x.name}: الزرع اعتمد على skipDuplicates بدل البحث`);
    assert.deepEqual(x.forbidden, [], `${x.name}: تعديل ممنوع`);
  }
}

test('المخزن المزيّف يرمي P2002 بشكل Prisma على القيد الفريد', async () => {
  const { tables } = fakeDb();
  await tables.glAccount.create({ data: { tenantId: 't', code: '111001' } });
  await assert.rejects(tables.glAccount.create({ data: { tenantId: 't', code: '111001' } }), (e: unknown) => {
    const err = e as { code?: string; meta?: { target?: string[] } };
    return err.code === 'P2002' && err.meta?.target?.join() === 'tenantId,code';
  });
  await assert.rejects(tables.glAccount.createMany({ data: [{ tenantId: 't', code: '111001' }] }), { code: 'P2002' });
});

test('زرع SA_6D مرتين: لا خطأ، والعدد نفسه، والمرة الثانية لا تنشئ شيئاً', async () => {
  const { tables, db } = fakeDb();
  const first = await seedTemplate(db, 't1', 'SA_6D');
  const expected = {
    accounts: SA_6D_ACCOUNTS.length, tags: 1, tagLinks: 1, mappings: MAPPING_KEYS.length,
    journals: SA_6D_JOURNALS.length, taxes: SA_TAXES.length, settings: 1,
  };
  assert.deepEqual(first.created, expected);
  assert.deepEqual(first.unresolvedMappings, []);
  const after1 = totals(tables, 't1');
  assert.deepEqual(after1, expected);

  const second = await seedTemplate(db, 't1', 'SA_6D');
  assert.deepEqual(second.created, { accounts: 0, tags: 0, tagLinks: 0, journals: 0, taxes: 0, mappings: 0, settings: 0 });
  assert.equal(second.skipped.accounts, SA_6D_ACCOUNTS.length);
  assert.equal(second.skipped.journals, SA_6D_JOURNALS.length);
  assert.equal(second.skipped.taxes, SA_TAXES.length);
  assert.equal(second.skipped.mappings, MAPPING_KEYS.length);
  assert.equal(second.skipped.settings, 1);
  assert.deepEqual(totals(tables, 't1'), after1);
  assertNoDuplicatesOrWrites(tables);
});

test('المراجع تُحلّ إلى معرّفات حسابات الشركة: الضريبة والدفتر والربط والإعدادات', async () => {
  const { tables, db } = fakeDb();
  await seedTemplate(db, 't1', 'SA_6D');
  const acc = (code: string) => tables.glAccount.rows.find((r) => r.tenantId === 't1' && r.code === code)!;
  const s15 = tables.glTax.rows.find((r) => r.key === 'S15_SALE')!;
  assert.equal(s15.accountId, acc('212001').id);
  assert.equal(tables.glTax.rows.find((r) => r.key === 'RC15')!.rcOutputAccountId, acc('212003').id);
  assert.equal(tables.glTax.rows.find((r) => r.key === 'O_SALE')!.accountId, null);
  assert.equal(tables.glJournal.rows.find((r) => r.code === 'INV')!.defaultAccountId, acc('411001').id);
  assert.equal(tables.glJournal.rows.find((r) => r.code === 'MISC')!.defaultAccountId, null);
  assert.equal(tables.glAccountMapping.rows.find((r) => r.key === 'AR_CONTROL')!.accountId, acc('113001').id);
  assert.equal(tables.glAccountMapping.rows.find((r) => r.key === 'PAYLINK_PAYOUT_ACCOUNT')!.accountId, acc('112001').id);
  const settings = tables.glSettings.rows[0];
  assert.equal(settings.templateKey, 'SA_6D');
  assert.equal(settings.currency, 'SAR');
  assert.equal(settings.currencyDecimals, 2);
  assert.equal(settings.zeroRatedSalesTaxKey, 'Z_SALE');
  assert.equal(settings.defaultPurchaseTaxId, tables.glTax.rows.find((r) => r.key === 'S15_PURCH')!.id);
  // الاسم العربي وnameI18n بخمس لغات، والوسم DRAWINGS على 315001
  assert.equal(acc('111001').name, 'الصندوق الرئيسي');
  assert.deepEqual(Object.keys(acc('111001').nameI18n as object).sort(), ['ar', 'en', 'fr', 'tr', 'zh']);
  const drawings = tables.glAccountTag.rows.find((r) => r.name === 'DRAWINGS')!;
  assert.ok(tables.glAccountTagLink.rows.some((r) => r.accountId === acc('315001').id && r.tagId === drawings.id));
  // الشركتان معزولتان
  await seedTemplate(db, 't2', 'SA_6D');
  assert.equal(totals(tables, 't2').accounts, SA_6D_ACCOUNTS.length);
  assert.ok(tables.glTax.rows.filter((r) => r.tenantId === 't2').every((t) => {
    const a = tables.glAccount.rows.find((x) => x.id === t.accountId);
    return !a || a.tenantId === 't2';
  }));
  assertNoDuplicatesOrWrites(tables);
});

test('زرع المعالج فوق صفوف M2 معدّلة أو يدوية برموز القالب: لا P2002، والموجود لا يُعدَّل، والناقص وحده يُنشأ', async () => {
  const { tables, db } = fakeDb();
  const T = 'm2';
  const renamed = await tables.glAccount.create({ data: { tenantId: T, code: '411001', templateRef: '411001', name: 'مبيعات معدّلة الاسم', type: 'income' } });
  const manualSameCode = await tables.glAccount.create({ data: { tenantId: T, code: '611003', templateRef: null, name: 'وقود يدوي', type: 'expense' } });
  const recoded = await tables.glAccount.create({ data: { tenantId: T, code: '621099', templateRef: '621004', name: 'إيجار بعد تغيير الرمز', type: 'expense' } });
  const customAcc = await tables.glAccount.create({ data: { tenantId: T, code: '411900', templateRef: null, name: 'إيراد خاص', type: 'income' } });
  const tax = await tables.glTax.create({ data: { tenantId: T, key: 'S15_SALE', name: 'ضريبتي', rate: 15, use: 'SALE' } });
  const customTax = await tables.glTax.create({ data: { tenantId: T, key: null, name: 'ضريبة مخصّصة', rate: 5, use: 'SALE' } });
  const mapping = await tables.glAccountMapping.create({ data: { tenantId: T, key: 'SALES_REVENUE', accountId: customAcc.id } });
  const misc = await tables.glJournal.create({ data: { tenantId: T, code: 'MISC', systemKey: 'MISC', name: 'يومية عامة' } });
  const cash = await tables.glJournal.create({ data: { tenantId: T, code: 'GEN', systemKey: 'CASH_MAIN', name: 'صندوقي' } });
  const settings = await tables.glSettings.create({ data: { tenantId: T, templateKey: 'SA_6D', currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Dubai' } });
  const snapshot = JSON.stringify([renamed, manualSameCode, recoded, customAcc, tax, customTax, mapping, misc, cash, settings]);

  const report = await seedTemplate(db, T, 'SA_6D');

  // الموجود كما هو حرفياً
  assert.equal(JSON.stringify([renamed, manualSameCode, recoded, customAcc, tax, customTax, mapping, misc, cash, settings]), snapshot);
  assert.equal(tables.glAccount.rows.find((r) => r.id === renamed.id)!.name, 'مبيعات معدّلة الاسم');
  assert.equal(tables.glAccountMapping.rows.find((r) => r.key === 'SALES_REVENUE')!.accountId, customAcc.id);
  assert.equal(tables.glSettings.rows.find((r) => r.tenantId === T)!.timezone, 'Asia/Dubai');

  // الناقص وحده
  assert.equal(report.created.accounts, SA_6D_ACCOUNTS.length - 3);
  assert.equal(report.skipped.accounts, 3);
  assert.equal(totals(tables, T).accounts, SA_6D_ACCOUNTS.length + 1);
  assert.ok(!tables.glAccount.rows.some((r) => r.tenantId === T && r.code === '621004'), 'الحساب ذو templateRef لا يُكرَّر برمزه القديم');
  assert.equal(report.created.journals, SA_6D_JOURNALS.length - 2);
  assert.ok(!tables.glJournal.rows.some((r) => r.tenantId === T && r.code === 'CSH1'), 'الدفتر ذو systemKey لا يُكرَّر برمز القالب');
  assert.equal(report.created.taxes, SA_TAXES.length - 1);
  assert.equal(report.created.mappings, MAPPING_KEYS.length - 1);
  assert.equal(report.created.settings, 0);
  // الربط يُحلّ إلى الحساب القائم (templateRef ثم الرمز)
  assert.equal(tables.glAccountMapping.rows.find((r) => r.tenantId === T && r.key === 'FUEL')!.accountId, manualSameCode.id);
  assert.equal(tables.glJournal.rows.find((r) => r.tenantId === T && r.code === 'INV')!.defaultAccountId, renamed.id);
  assertNoDuplicatesOrWrites(tables);

  // وزرع ثالث لا يغيّر شيئاً
  const before = totals(tables, T);
  const again = await seedTemplate(db, T, 'SA_6D');
  assert.deepEqual(totals(tables, T), before);
  assert.equal(Object.values(again.created).reduce((a, b) => a + b, 0), 0);
});

test('حساب يدوي برمز القالب بنوع أو controlKind مخالف: لا ربط ولا مرجع ضريبة عليه، والتعارض في التقرير', async () => {
  const { tables, db } = fakeDb();
  const T = 'cf';
  const ar = await tables.glAccount.create({ data: { tenantId: T, code: '113001', templateRef: null, name: 'ذمم يدوية', type: 'asset_current', controlKind: null } });
  const vatIn = await tables.glAccount.create({ data: { tenantId: T, code: '116001', templateRef: null, name: 'ضريبة يدوية', type: 'asset_current', controlKind: null } });
  const report = await seedTemplate(db, T, 'SA_6D');
  assert.ok(!tables.glAccountMapping.rows.some((r) => r.tenantId === T && r.key === 'AR_CONTROL'), 'لا ربط AR_CONTROL على حساب بلا controlKind');
  assert.ok(!tables.glAccountMapping.rows.some((r) => r.tenantId === T && r.key === 'INPUT_VAT'));
  const arConflict = report.conflictingMappings.find((c) => c.key === 'AR_CONTROL');
  assert.ok(arConflict, JSON.stringify(report.conflictingMappings));
  assert.equal(arConflict.accountId, ar.id);
  assert.equal(arConflict.code, '113001');
  assert.equal(arConflict.type, 'asset_current');
  assert.equal(arConflict.controlKind, null);
  assert.equal(arConflict.reason, 'MAPPING_TYPE_MISMATCH');
  assert.equal(report.conflictingMappings.find((c) => c.key === 'INPUT_VAT')?.reason, 'MAPPING_CONTROL_KIND');
  // الضريبة لا تُربط بالحساب المخالف
  const s15 = tables.glTax.rows.find((r) => r.tenantId === T && r.key === 'S15_PURCH')!;
  assert.equal(s15.accountId, null);
  assert.ok(report.conflictingAccountRefs.some((c) => c.entity === 'TAX' && c.ref === 'S15_PURCH' && c.field === 'accountId' && c.accountId === vatIn.id && c.expectedControlKind === 'VAT_IN'));
  // الموجود لا يُعدَّل، ولا تكرار
  assert.equal(tables.glAccount.rows.find((r) => r.id === ar.id)!.controlKind, null);
  assertNoDuplicatesOrWrites(tables);
  // الزرع السليم بلا تعارضات
  const clean = await seedTemplate(db, 'ok', 'SA_6D');
  assert.deepEqual(clean.conflictingMappings, []);
  assert.deepEqual(clean.conflictingAccountRefs, []);
});

test('رمز دفتر يتصادم مع بادئة مرتجع قائمة ⇒ LEDGER_JOURNAL_CODE_CONFLICT (409)', async () => {
  const { tables, db } = fakeDb();
  await tables.glJournal.create({ data: { tenantId: 'c', code: 'RINV', name: 'دفتر يدوي' } });
  await assert.rejects(seedTemplate(db, 'c', 'SA_6D'), (e: unknown) => {
    assert.ok(isLedgerError(e, 'LEDGER_JOURNAL_CODE_CONFLICT'));
    assert.equal(e.httpStatus, 409);
    assert.equal(e.details.code, 'INV');
    assert.equal(e.details.conflictsWith, 'RINV');
    return true;
  });
});

test('القالب العام لدولة 0٪ (الكويت): الضرائب غير نشطة، وحسابات الضريبة مؤرشفة، وبلا علامة صفرية', async () => {
  const { tables, db } = fakeDb();
  await seedTemplate(db, 'kw', 'GENERIC_6D', { countryCode: 'KW', settings: { timezone: 'Asia/Kuwait' } });
  const s = tables.glSettings.rows[0];
  assert.equal(s.templateKey, 'GENERIC_6D');
  assert.equal(s.countryCode, 'KW');
  assert.equal(s.currency, 'KWD');
  assert.equal(s.currencyDecimals, 3);
  assert.equal(s.zeroRatedSalesTaxKey, null);
  assert.equal(s.defaultPurchaseTaxId, null);
  assert.equal(s.taxDeadlineRule, 'DAYS_AFTER');
  assert.equal(s.timezone, 'Asia/Kuwait');
  assert.ok(tables.glTax.rows.length > 0 && tables.glTax.rows.every((t) => t.isActive === false));
  for (const code of VAT_ACCOUNT_CODES) assert.equal(tables.glAccount.rows.find((r) => r.code === code)!.isActive, false, code);
  assert.throws(() => resolveTemplate('GENERIC_6D'), RangeError);
  assert.throws(() => resolveTemplate('XX' as never), RangeError);
});

test('seed.ts لا يعدّل موجوداً: لا update ولا upsert ولا delete، ويستدعي journalCodeConflict', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/gl/seed.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.(update|updateMany|upsert|delete|deleteMany)\s*\(/);
  assert.match(code, /journalCodeConflict\(/);
  assert.match(code, /LEDGER_JOURNAL_CODE_CONFLICT/);
  assert.match(code, /skipDuplicates:\s*true/);
});
