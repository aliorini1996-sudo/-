/**
 * البند 6 (مراجعة 2026-09-17): الحفظ الذري لمعرّفات دفعات الاستيراد. منطق صرف بلا قاعدة بيانات.
 *
 * كل شريحة تُكتب في معاملة واحدة، ومعرّفاتها تُسجَّل في recordIds داخل المعاملة نفسها في آخرها (دون شرط «حان الحفظ»)،
 * فما التُزم من السجلات مسجَّل في دفعته تماماً: انقطاع الخادم لا يترك سجلاً خارج الدفعة يتضاعف عند إعادة الرفع.
 * فشل الشريحة ⇒ إعادة كل عنصر منها في معاملة وحده (مع التسجيل)، فيُنسب الخطأ إلى عنصره وحده.
 */

/** هدف حجم الشريحة: max(50, ceil(الإجمالي/100)) قيداً أو سجلاً */
export function importChunkTarget(total: number): number {
  return Math.max(50, Math.ceil(Math.max(0, total) / 100));
}

/** تجميع جشع بالترتيب؛ العنصر الذي يبلغ الهدف وحده شريحة مستقلة */
export function planImportChunks<T>(items: readonly T[], sizeOf: (item: T) => number, target: number): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  const cap = Math.max(1, target);
  for (const item of items) {
    const s = Math.max(1, sizeOf(item));
    if (s >= cap) {
      if (cur.length) { chunks.push(cur); cur = []; size = 0; }
      chunks.push([item]);
      continue;
    }
    if (cur.length && size + s > cap) { chunks.push(cur); cur = []; size = 0; }
    cur.push(item);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export interface ImportChunkWritten<T, R> { item: T; result: R }

export interface RunImportChunksOptions<T, R, Tx> {
  chunks: readonly (readonly T[])[];
  /** معاملة واحدة: تلتزم إن نجحت الدالة، وتُلغى كلها إن رمت */
  runTx: <X>(fn: (tx: Tx) => Promise<X>) => Promise<X>;
  writeItem: (tx: Tx, item: T) => Promise<R>;
  /** تسجيل المعرّفات في آخر المعاملة نفسها (الملتزم سابقاً + نتائج هذه المعاملة) */
  flush: (tx: Tx, written: readonly ImportChunkWritten<T, R>[]) => Promise<void>;
  /** بعد التزام المعاملة وحده */
  onCommitted: (written: readonly ImportChunkWritten<T, R>[]) => void;
  onItemError: (item: T, err: unknown) => void;
  /** خطأ لا يُعاد عنصراً عنصراً (مثل انقطاع أو خطأ HTTP برمز) ⇒ يُرمى */
  isFatal?: (err: unknown) => boolean;
  /** بعد كل شريحة (نبض خارج المعاملات) */
  afterChunk?: () => Promise<void>;
}

export async function runImportChunks<T, R, Tx>(o: RunImportChunksOptions<T, R, Tx>): Promise<void> {
  const one = async (tx: Tx, items: readonly T[]) => {
    const written: ImportChunkWritten<T, R>[] = [];
    for (const item of items) written.push({ item, result: await o.writeItem(tx, item) });
    await o.flush(tx, written);
    return written;
  };
  for (const chunk of o.chunks) {
    if (!chunk.length) continue;
    try {
      o.onCommitted(await o.runTx((tx) => one(tx, chunk)));
    } catch (e) {
      if (o.isFatal?.(e)) throw e;
      if (chunk.length === 1) {
        o.onItemError(chunk[0], e);
      } else {
        for (const item of chunk) {
          try {
            o.onCommitted(await o.runTx((tx) => one(tx, [item])));
          } catch (err) {
            if (o.isFatal?.(err)) throw err;
            o.onItemError(item, err);
          }
        }
      }
    }
    if (o.afterChunk) await o.afterChunk();
  }
}

// ═══ تقدّم الدفعة (المعرّفات والفئات والأسعار السابقة) ═══

export interface ImportProgressState {
  records: string[];
  categories: string[];
  previous: Record<string, number | null>;
  /** البند 7: آخر سعر كتبته الدفعة لكل CustomerPrice (التراجع لا يمس سعراً تغيّر بعده) */
  imported: Record<string, number>;
}

export interface ImportProgressDelta {
  records?: readonly string[];
  categories?: readonly string[];
  /** السعر السابق: أول قيمة لكل معرّف وحدها تُحفظ */
  previous?: readonly (readonly [string, number | null])[];
  /** السعر المكتوب: آخر قيمة لكل معرّف تفوز */
  imported?: readonly (readonly [string, number])[];
}

/** دمج صرف: المعرّفات بلا تكرار بترتيبها، وprevious أول قيمة فقط، وimported آخر قيمة */
export function mergeImportProgress(base: Readonly<ImportProgressState>, delta: ImportProgressDelta): ImportProgressState {
  const records = [...base.records];
  const seen = new Set(records);
  for (const id of delta.records ?? []) if (!seen.has(id)) { seen.add(id); records.push(id); }
  const categories = [...base.categories];
  const seenCat = new Set(categories);
  for (const id of delta.categories ?? []) if (!seenCat.has(id)) { seenCat.add(id); categories.push(id); }
  const previous: Record<string, number | null> = { ...base.previous };
  for (const [id, p] of delta.previous ?? []) if (!Object.prototype.hasOwnProperty.call(previous, id)) previous[id] = p;
  const imported: Record<string, number> = { ...(base.imported ?? {}) };
  for (const [id, p] of delta.imported ?? []) imported[id] = p;
  return { records, categories, previous, imported };
}

/** دمج عدة دلتا بالترتيب */
export function mergeImportDeltas(base: Readonly<ImportProgressState>, deltas: readonly ImportProgressDelta[]): ImportProgressState {
  return deltas.reduce<ImportProgressState>((acc, d) => mergeImportProgress(acc, d), { ...base, records: [...base.records], categories: [...base.categories], previous: { ...base.previous }, imported: { ...(base.imported ?? {}) } });
}
