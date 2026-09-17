import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lockCustomerRow, currentBalance,
  postInvoiceEntries, postCashInvoiceEntries, reverseInvoiceEntries, reverseCashInvoiceEntries,
  postReceiptEntries, reverseReceiptEntries, postReturnEntries, reverseReturnEntries,
} from '../services/accounting';

/**
 * البند 19 (مراجعة الاستيراد 2026-09-17): مسارات الفاتورة والسند والمرتجع تكتب customer.balance قيمةً مطلقة
 * من مجموع القيود. بلا قفل صف العميل، استيراد كشف طويل يقرأ 5000 ثم تلتزم فاتورة 1000 ثم يكتب الكشف 5200،
 * فيضيع أثر الفاتورة (Σ = 6200). القفل FOR UPDATE يسلسل المعاملتين.
 */

// ═══ محاكاة قاعدة بعزل «قراءة الملتزم» وقفل صف ═══

interface Entry { customerId: string; debit: number; credit: number }

class SimDb {
  entries: Entry[] = [];
  balance = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();

  async lock(customerId: string): Promise<() => void> {
    while (this.locks.has(customerId)) await this.locks.get(customerId);
    let release!: () => void;
    this.locks.set(customerId, new Promise<void>((r) => { release = r; }));
    return () => { this.locks.delete(customerId); release(); };
  }
}

function simTx(db: SimDb, opts: { withRaw: boolean; calls?: string[] }) {
  const pending: Entry[] = [];
  const pendingBalance = new Map<string, number>();
  const releases: (() => void)[] = [];
  const calls = opts.calls ?? [];
  const tx: Record<string, unknown> = {
    accountEntry: {
      aggregate: async ({ where }: { where: { customerId: string } }) => {
        calls.push('aggregate');
        const rows = [...db.entries, ...pending].filter((e) => e.customerId === where.customerId);
        return { _sum: { debit: rows.reduce((s, e) => s + e.debit, 0), credit: rows.reduce((s, e) => s + e.credit, 0) } };
      },
      create: async ({ data }: { data: Entry }) => {
        calls.push('create');
        pending.push({ customerId: data.customerId, debit: Number(data.debit), credit: Number(data.credit) });
        return data;
      },
    },
    customer: {
      update: async ({ where, data }: { where: { id: string }; data: { balance?: number } }) => {
        calls.push('update');
        if (typeof data.balance === 'number') pendingBalance.set(where.id, data.balance);
        return {};
      },
    },
  };
  if (opts.withRaw) {
    tx.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      calls.push(`raw:${sql}`);
      if (/FOR UPDATE/.test(sql)) releases.push(await db.lock(String(values[0])));
      return [];
    };
  }
  const commit = () => {
    db.entries.push(...pending);
    for (const [k, v] of pendingBalance) db.balance.set(k, v);
    releases.splice(0).forEach((r) => r());
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tx: tx as any, commit };
}

const sigma = (db: SimDb, id: string) =>
  db.entries.filter((e) => e.customerId === id).reduce((s, e) => s + e.debit - e.credit, 0);

// ═══ ترتيب القفل ═══

const FNS: [string, (tx: never) => Promise<void>][] = [
  ['postInvoiceEntries', (tx) => postInvoiceEntries(tx, 't', 'i', 'c1', 100)],
  ['postCashInvoiceEntries', (tx) => postCashInvoiceEntries(tx, 't', 'i', 'c1', 100)],
  ['reverseInvoiceEntries', (tx) => reverseInvoiceEntries(tx, 't', 'i', 'c1', 100)],
  ['reverseCashInvoiceEntries', (tx) => reverseCashInvoiceEntries(tx, 't', 'i', 'c1', 100)],
  ['postReceiptEntries', (tx) => postReceiptEntries(tx, 't', 'r', 'c1', 100)],
  ['reverseReceiptEntries', (tx) => reverseReceiptEntries(tx, 't', 'r', 'c1', 100)],
  ['postReturnEntries', (tx) => postReturnEntries(tx, 't', 'i', 'c1', 100)],
  ['reverseReturnEntries', (tx) => reverseReturnEntries(tx, 't', 'i', 'c1', 100)],
];

for (const [name, fn] of FNS) {
  test(`${name}: قفل صف العميل FOR UPDATE يسبق قراءة الرصيد`, async () => {
    const db = new SimDb();
    const calls: string[] = [];
    const { tx, commit } = simTx(db, { withRaw: true, calls });
    await fn(tx as never);
    commit();
    const lockAt = calls.findIndex((c) => /SELECT id FROM customers WHERE id = \? FOR UPDATE/.test(c));
    assert.ok(lockAt >= 0, 'القفل مستدعى');
    assert.equal(lockAt, 0, 'القفل أول نداء');
    assert.ok(calls.indexOf('aggregate') > lockAt, 'aggregate بعد القفل');
  });
}

test('المعاملة المزيّفة بلا $queryRaw: القفل يُتخطى بلا رمي', async () => {
  const db = new SimDb();
  const { tx } = simTx(db, { withRaw: false });
  await assert.doesNotReject(() => lockCustomerRow(tx, 'c1'));
  await assert.doesNotReject(() => postInvoiceEntries(tx, 't', 'i', 'c1', 10));
});

// ═══ سيناريو البند: فاتورة 1000 أثناء استيراد كشف صافيه 200 على رصيد 5000 ═══

async function raceScenario(invoiceLocks: boolean) {
  const db = new SimDb();
  db.entries.push({ customerId: 'c1', debit: 5000, credit: 0 });
  db.balance.set('c1', 5000);

  let openGate!: () => void;
  const gate = new Promise<void>((r) => { openGate = r; });
  let importRead!: () => void;
  const importHasRead = new Promise<void>((r) => { importRead = r; });

  // استيراد الكشف: قفل الصف أولاً ثم الرصيد تحت القفل ثم الكتابة (المدة الطويلة = gate)
  const imp = simTx(db, { withRaw: true });
  const importTx = (async () => {
    await lockCustomerRow(imp.tx, 'c1');
    const base = await currentBalance(imp.tx, 'c1');
    importRead();
    await gate;
    await imp.tx.accountEntry.create({ data: { customerId: 'c1', debit: 300, credit: 100 } });
    await imp.tx.customer.update({ where: { id: 'c1' }, data: { balance: base + 200 } });
    imp.commit();
  })();

  await importHasRead;
  const inv = simTx(db, { withRaw: invoiceLocks });
  const invoiceTx = (async () => {
    await postInvoiceEntries(inv.tx, 't', 'inv', 'c1', 1000);
    inv.commit();
  })();
  // امنح الفاتورة فرصة التقدّم قبل انتهاء الاستيراد
  await new Promise((r) => setTimeout(r, 5));
  openGate();
  await Promise.all([importTx, invoiceTx]);
  return { balance: db.balance.get('c1'), sigma: sigma(db, 'c1') };
}

test('سباق الفاتورة والكشف: مع قفل الصف الرصيد = Σ = 6200', async () => {
  const r = await raceScenario(true);
  assert.equal(r.sigma, 6200);
  assert.equal(r.balance, 6200);
});

test('إعادة إنتاج الخلل: بلا قفل في مسار الفاتورة يضيع أثرها (5200 مقابل Σ 6200)', async () => {
  const r = await raceScenario(false);
  assert.equal(r.sigma, 6200);
  assert.equal(r.balance, 5200);
});
