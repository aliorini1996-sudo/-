// قراءة ملفات الاستيراد من البايتات (البنود 12 و14 و27 و28 و29) بمكتبة xlsx الحقيقية وبتوقيت الرياض
process.env.TZ = 'Asia/Riyadh';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  IMPORT_TYPES, parseImportBuffer, parseImportFile, parseExcelFile, ImportFileError,
  IMPORT_ENCODING_ERROR, IMPORT_WIN1256_NOTICE, IMPORT_DUP_HEADERS_NOTICE, AMBIGUOUS_COLUMN_BLOCKER,
} from './importData';

const xlsxBuf = (aoa: unknown[][], fmt?: (ws: XLSX.WorkSheet) => void): ArrayBuffer => {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  fmt?.(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
};
const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

// جدول Windows-1256 للأحرف المستعملة فقط
const CP1256: Record<string, number> = {
  'ا': 0xc7, 'ل': 0xe1, 'ع': 0xda, 'م': 0xe3, 'ي': 0xed, 'ر': 0xd1, 'ص': 0xd5, 'د': 0xcf, 'ت': 0xca, 'خ': 0xce, 'أ': 0xc3, 'ح': 0xcd,
};
const cp1256 = (s: string): ArrayBuffer => new Uint8Array([...s].map((ch) => {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c;
  const b = CP1256[ch];
  if (b === undefined) throw new Error(`حرف خارج الجدول: ${ch}`);
  return b;
})).buffer as ArrayBuffer;

test('البند 14: خلية ضريبة منسّقة 0% قيمتها 0.15 في xlsx حقيقي ⇒ taxPct=15', async () => {
  const buf = xlsxBuf([['اسم الصنف', 'سعر البيع', 'الضريبة'], ['ماء', 10, 0.15]], (ws) => { ws.C2.z = '0%'; });
  const f = await parseImportBuffer(buf, 'products.xlsx');
  assert.equal(f.format, 'xlsx');
  assert.equal(f.encoding, 'binary');
  const r = IMPORT_TYPES.products.transform(f.rows);
  assert.equal(r.valid[0].taxPct, 15);
});

test('البند 29: خلية 2025-12-31 23:59:59 في xlsx حقيقي ⇒ 2025-12-31', async () => {
  const buf = xlsxBuf([['الاسم', 'الرصيد', 'التاريخ'], ['أ', 50, new Date(2025, 11, 31, 23, 59, 59)], ['ب', 50, new Date(2025, 11, 31, 23, 59, 30)]]);
  const r = IMPORT_TYPES.balances.transform((await parseImportBuffer(buf, 'b.xlsx')).rows);
  assert.deepEqual(r.valid.map((v) => v.date), ['2025-12-31', '2025-12-31']);
});

test('البند 27: CSV بترميز Windows-1256 ⇒ «العميل» صحيحة بتنبيه', async () => {
  const buf = cp1256('العميل,الرصيد,التاريخ\r\nأحمد,100,05/01/2025\r\n');
  const f = await parseImportBuffer(buf, 'balances.csv');
  assert.equal(f.encoding, 'windows-1256');
  assert.equal(f.format, 'text');
  assert.deepEqual(f.headers, ['العميل', 'الرصيد', 'التاريخ']);
  assert.deepEqual(f.notices, [{ key: IMPORT_WIN1256_NOTICE }]);
  const r = IMPORT_TYPES.balances.transform(f.rows);
  assert.deepEqual(r.valid.map((v) => [v.customerName, v.balance, v.date]), [['أحمد', 100, '2025-01-05']]);
});

test('البند 28: ملف .xls هو TSV ⇒ 05/01/2025 = 2025-01-05', async () => {
  const f = await parseImportBuffer(bytes('الاسم\tالرصيد\tالتاريخ\nأ\t10\t05/01/2025\n'), 'export.xls');
  assert.equal(f.format, 'text');
  const r = IMPORT_TYPES.balances.transform(f.rows);
  assert.deepEqual(r.valid.map((v) => [v.balance, v.date]), [[10, '2025-01-05']]);
});

test('البند 28: ملف .xls هو HTML ⇒ 05/01/2025 = 2025-01-05', async () => {
  const html = '<html><head><meta charset="utf-8"></head><body><table><tr><td>الاسم</td><td>الرصيد</td><td>التاريخ</td></tr>'
    + '<tr><td>أ</td><td>10</td><td>05/01/2025</td></tr></table></body></html>';
  const f = await parseImportBuffer(bytes(html), 'export.xls');
  assert.equal(f.format, 'html');
  const r = IMPORT_TYPES.balances.transform(f.rows);
  assert.deepEqual(r.valid.map((v) => [v.customerName, v.balance, v.date]), [['أ', 10, '2025-01-05']]);
});

test('البند 28: UTF-8 بلا BOM باسم .xls ⇒ رؤوس عربية سليمة', async () => {
  const f = await parseImportBuffer(bytes('الاسم,مدين,التاريخ\nأ,5,01/02/2026\n'), 'ledger.xls');
  assert.equal(f.encoding, 'utf-8');
  assert.deepEqual(f.headers, ['الاسم', 'مدين', 'التاريخ']);
  const l = IMPORT_TYPES.ledger.transform(f.rows);
  assert.deepEqual(l.valid.map((v) => [v.customerName, v.debit, v.date]), [['أ', 5, '2026-02-01']]);
});

test('البندان 27/28: رؤوس مشوّهة (Latin-1) ⇒ ImportFileError برسالة الترميز', async () => {
  await assert.rejects(
    parseImportBuffer(bytes('ÇáÚãíá,ÇáÑÕíÏ\nÃÍãÏ,100\n'), 'x.csv'),
    (e: unknown) => e instanceof ImportFileError && e.key === IMPORT_ENCODING_ERROR,
  );
});

test('البند 12: رأسان «الحركة | الرصيد» وتحت كل منهما مدين/دائن في xlsx حقيقي ⇒ الحركة لا الرصيد', async () => {
  const buf = xlsxBuf([
    ['', '', 'الحركة', '', 'الرصيد', ''],
    ['العميل', 'التاريخ', 'مدين', 'دائن', 'مدين', 'دائن'],
    ['أ', '2026-01-05', 100, 200, 5000, 0],
  ]);
  const f = await parseImportBuffer(buf, 'statement.xlsx');
  assert.deepEqual(f.headers, ['العميل', 'التاريخ', 'الحركة مدين', 'الحركة دائن', 'الرصيد مدين', 'الرصيد دائن']);
  const l = IMPORT_TYPES.ledger.transform(f.rows);
  assert.deepEqual(l.blockers, []);
  assert.deepEqual(l.valid.map((v) => [v.debit, v.credit]), [[100, 200]]);
});

test('البند 12: رأس مكرر بلا صف أعلى ⇒ «(2)» بتنبيه، والتكرار بلا تمييز يمنع الاستيراد', async () => {
  const f = await parseImportBuffer(bytes('العميل,مدين,مدين\nأ,100,5000\n'), 'l.csv');
  assert.deepEqual(f.headers, ['العميل', 'مدين', 'مدين (2)']);
  assert.deepEqual(f.notices, [{ key: IMPORT_DUP_HEADERS_NOTICE, count: 1 }]);
  assert.equal(f.rows[0]['مدين (2)'], '5000');
  // «مدين» تطابق تام، و«مدين (2)» احتواء ⇒ التام وحده (لا خلط صامت)
  assert.deepEqual(IMPORT_TYPES.ledger.transform(f.rows).valid.map((v) => v.debit), [100]);
  // التكرار بلا تمييز يمنع زر الاستيراد (مراجعة ثانية للبند 12)
  assert.ok(IMPORT_TYPES.ledger.transform(f.rows).blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER));
});

test('parseImportFile وparseExcelFile يعملان على File', async () => {
  const file = new File([bytes('الاسم,الرصيد\nأ,1\n')], 'a.csv');
  const f = await parseImportFile(file);
  assert.equal(f.rows.length, 1);
  assert.deepEqual(await parseExcelFile(file), f.rows);
});

test('البند 29 (ثانية): خلية xlsx 2025-12-31 23:59:59.6 (رقم تسلسلي بكسر ثانية) ⇒ 2025-12-31 لا 2026-01-01', async () => {
  // 23:59:59.999 لا يُختبر: SheetJS يعيده −1ms من منتصف الليل تماماً كما يعيد منتصف الليل الحقيقي، فلا يتميّزان على مستوى Date
  const serials = [46022 + 86399.6 / 86400, 46022 + 86399.5 / 86400, 46022 + 86399 / 86400];
  const buf = xlsxBuf([['الاسم', 'الرصيد', 'التاريخ'], ...serials.map((s, i) => [`ع${i}`, 50, s])], (ws) => {
    for (const r of [2, 3, 4]) ws[`C${r}`].z = 'yyyy-mm-dd hh:mm:ss.000';
  });
  const f = await parseImportBuffer(buf, 'b.xlsx');
  assert.ok(f.rows[0]['التاريخ'] instanceof Date);
  const r = IMPORT_TYPES.balances.transform(f.rows);
  assert.deepEqual(r.valid.map((v) => v.date), ['2025-12-31', '2025-12-31', '2025-12-31']);
});

test('البند 14 (ثانية): CSV بترميز UTF-8 ورؤوس فرنسية مشكّلة يُقرأ بلا خطأ ترميز', async () => {
  const f = await parseImportBuffer(bytes('Name,Phone,Société,Crédit,Adresse complète\nAli,0551234567,X,10,Rue\n'), 'fr.csv');
  assert.equal(f.encoding, 'utf-8');
  assert.equal(f.headers.length, 5);
  assert.equal(f.rows.length, 1);
  // التشويه الحقيقي ما زال مرفوضاً: UTF-8 مقروء Latin-1 ثم محفوظ UTF-8
  await assert.rejects(
    parseImportBuffer(bytes('Ø§Ù„Ø§Ø³Ù…,Ø§Ù„Ø±ØµÙŠØ¯\nx,1\n'), 'x.csv'),
    (e: unknown) => e instanceof ImportFileError && e.key === IMPORT_ENCODING_ERROR,
  );
});

test('البند 12 (ثانية): «مدين/دائن» مكرران في صف عناوين واحد بلا صف أعلى ⇒ مانع (عربي وإنجليزي)', async () => {
  for (const heads of [['العميل', 'مدين', 'دائن', 'مدين', 'دائن'], ['Customer', 'Debit', 'Credit', 'Debit', 'Credit']]) {
    const f = await parseImportBuffer(xlsxBuf([heads, ['أ', 5000, '', 100, '']]), 'l.xlsx');
    const l = IMPORT_TYPES.ledger.transform(f.rows);
    assert.ok(l.blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER), heads.join(','));
  }
  // رأس حقيقي «مدين (2)» بلا «مدين» لا يُمنع
  const g = await parseImportBuffer(bytes('العميل,مدين (2)\nأ,5\n'), 'g.csv');
  assert.deepEqual(IMPORT_TYPES.ledger.transform(g.rows).blockers?.includes(AMBIGUOUS_COLUMN_BLOCKER), false);
});

test('الانحدار 7 (ثالثة): UTF-8 صالح برؤوس برتغالية كبيرة (ÇÃO) أو إسكندنافية (Ø) يُقرأ، والتشويه الحقيقي مرفوض', async () => {
  for (const head of ['DESCRIÇÃO,SITUAÇÃO,EMISSÃO,CLIENTE', 'Øre,Ø,Name,Ùx', 'ØSTERGAARD,BELØB,KUNDE', 'Société,Crédit,Échéance,Désignation']) {
    const f = await parseImportBuffer(bytes(`${head}\nx,1,2,3\n`), 'pt.csv');
    assert.equal(f.encoding, 'utf-8', head);
    assert.equal(f.headers.length, head.split(',').length, head);
  }
  // التشويه الحقيقي: UTF-8 عربي مقروء Windows-1252 ثم محفوظ UTF-8، وكذلك لاتيني مشكّل (Ã©)
  for (const head of ['Ø§Ù„Ø§Ø³Ù…,Ø§Ù„Ø±ØµÙŠØ¯', 'SociÃ©tÃ©,CrÃ©dit,Ã‰chÃ©ance']) {
    await assert.rejects(
      parseImportBuffer(bytes(`${head}\nx,1\n`), 'x.csv'),
      (e: unknown) => e instanceof ImportFileError && e.key === IMPORT_ENCODING_ERROR,
      head,
    );
  }
});
