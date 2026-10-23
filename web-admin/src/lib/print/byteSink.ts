/**
 * مجمّع بايتات أمر الطابعة — «إعدادات الطباعة» M3. مشتركٌ بين escpos.ts (الحرارية) وescp24.ts (النقطية MIP480).
 *
 * لماذا «علامات» مع البايتات: الإلغاء أثناء الإرسال لا يقطع أمراً في منتصفه. صورة GS v 0 أو ESC * تعلن طول بياناتها
 * مقدّماً، فلو قُطعت ثم أُرسل ESC @ لابتلعته الطابعة بيانات صورة وطبعت رذاذاً. فكل أمرٍ مكتمل يضع علامة، والنقل
 * (transport/btSerial.ts) يكمل إلى أقرب علامة ثم يرسل أمر الإلغاء.
 */

/** بايتات المهمة، ومواضع نهاية كل أمر مكتمل (نقاط إلغاء آمنة) تصاعدياً */
export interface EncodedJob {
  bytes: Uint8Array;
  marks: number[];
}

export class ByteSink {
  private parts: Uint8Array[] = [];
  private length = 0;
  private readonly cuts: number[] = [];

  push(...bytes: number[]): this {
    return this.append(Uint8Array.from(bytes));
  }

  append(bytes: Uint8Array | readonly number[]): this {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (b.length) { this.parts.push(b); this.length += b.length; }
    return this;
  }

  /** نهاية أمرٍ مكتمل — نقطة إلغاء آمنة */
  mark(): this {
    if (this.cuts[this.cuts.length - 1] !== this.length) this.cuts.push(this.length);
    return this;
  }

  get size(): number { return this.length; }

  done(): EncodedJob {
    const bytes = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { bytes.set(p, at); at += p.length; }
    this.mark();
    return { bytes, marks: [...this.cuts] };
  }
}

/** ESC J n على دفعات n ≤ 255 — تغذية بالنقاط (تُدمج الصفوف البيضاء المتتالية في أمرٍ واحد) */
export function feedCommands(dots: number): number[] {
  const out: number[] = [];
  let left = Math.max(0, Math.round(dots));
  while (left > 0) {
    const n = Math.min(255, left);
    out.push(0x1b, 0x4a, n);
    left -= n;
  }
  return out;
}
