/**
 * جلب كل صفحات قائمة بحد الخادم (صرف ومختبَر في pages.test.ts). يتوقف عند صفحة ناقصة أو بلوغ الإجمالي
 * أو السقف. المستعمل الوحيد لقائمة «كل الحسابات» (fetchAllLedgerAccounts) كي لا يتشارك جالبان مختلفان مفتاح ذاكرة واحداً.
 */
export async function collectPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ rows: T[]; total?: number | null }>,
  opts: { pageSize?: number; max?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const max = opts.max ?? 20_000;
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += pageSize) {
    const { rows, total } = await fetchPage(offset, pageSize);
    out.push(...rows);
    if (rows.length < pageSize || (typeof total === 'number' && out.length >= total)) break;
  }
  return out;
}
