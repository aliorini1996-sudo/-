import type { GlMoveLine, MoveLineInput, TaxRole } from '../../api/ledgerMoves';

/**
 * تحويل سطور القيد بين الخادم وشبكة النموذج (§6.1، §8.3) — صرفة ومختبَرة (moveLines.test.ts).
 *
 * عقد الخادم (routes/ledger/moves.ts وservices/gl/draft.ts):
 * - GET /moves/:id يعلّم السطر المولَّد آلياً بـ`generated` (generatedLineFlags)، لا taxRole: سطر ضريبة يدوي
 *   على حساب VAT_OUT/VAT_IN يحمل taxRole=TAX أيضاً وليس مولَّداً.
 * - السطر المولَّد يُحذف من جسم POST/PUT (الخادم يعيد توليده من سطر الوعاء الذي بقي taxId عليه). إرساله بلا
 *   generated=true يجعله سطر ضريبة يدوياً ⇒ ضريبة مكررة؛ لذا لا يُرسل أبداً.
 * - سطر الضريبة اليدوي يُرسَل بحسابه وtaxId فيبقى يدوياً (الخادم يعرفه بحساب VAT مع taxId). لا يُرسل taxRole=TAX:
 *   لو غيّر المستخدم الحساب إلى غير VAT لأسقطه الخادم صامتاً. MARKER وحده يُرسَل ما دام الحساب كما حُمِّل،
 *   ووعاؤه (taxBaseMilli، بوحدة العملة) يُحفظ.
 * - سطر الوعاء بضريبة شاملة (priceInclude) مخزَّن **صافياً** والخادم يقرأ مبلغه **شاملاً**: GET يرد `gross`، ويُرسَل
 *   بدل المبلغ الصافي ما دام المبلغ والجانب والضريبة كما حُمِّلت (وإلا انكمش الوعاء في كل حفظ أو تكرار). المبلغ
 *   الذي يعدّله المستخدم يُرسَل كما كتبه (شاملاً كأي إدخال جديد).
 */

export interface GridLine {
  /** مفتاح React ثابت (معرّف السطر أو مؤقت) */
  key: string;
  accountId: string;
  label: string;
  /** نص كما كتبه المستخدم */
  debit: string;
  credit: string;
  taxId: string | null;
  vatBox: string | null;
  analyticAccountId: string | null;
  partnerName?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  salesRepId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  dueDate?: string | null;
  /** سطر مولَّد آلياً (علم الخادم) — للقراءة ولا يُرسل */
  generated?: boolean;
  /** دور الضريبة كما حُمِّل لسطر ضريبة يدوي (TAX/MARKER) */
  taxRole?: TaxRole | null;
  /** حساب السطر عند التحميل: MARKER لا يُرسل إن تغيّر */
  loadedAccountId?: string | null;
  /** وعاء سطر الضريبة اليدوي كما حُمِّل (نص عشري) */
  taxBase?: string;
  /** المبلغ الشامل من الخادم لسطر وعاء بضريبة شاملة (نص عشري)، مع المبلغين والضريبة كما حُمِّلت للمقارنة */
  gross?: string;
  loadedDebit?: string;
  loadedCredit?: string;
  loadedTaxId?: string | null;
}

let seq = 0;
export const newGridLine = (over: Partial<GridLine> = {}): GridLine => ({
  key: `n${Date.now().toString(36)}${(seq++).toString(36)}`,
  accountId: '', label: '', debit: '', credit: '', taxId: null, vatBox: null, analyticAccountId: null, ...over,
});

const amountText = (n: number | null | undefined) => (n ? String(n) : '');

/** سطور تفصيل القيد ⇒ سطور الشبكة؛ علم التوليد من الخادم وحده. */
export function gridLinesFromMove(lines: readonly GlMoveLine[]): GridLine[] {
  return lines.map(l => {
    const generated = l.generated === true;
    const manualTax = !generated && (l.taxRole === 'TAX' || l.taxRole === 'MARKER');
    return newGridLine({
      key: l.id,
      accountId: l.accountId,
      label: l.label ?? '',
      debit: amountText(l.debit),
      credit: amountText(l.credit),
      taxId: l.taxId,
      vatBox: l.vatBox,
      analyticAccountId: l.analyticAccountId,
      partnerName: l.partnerName,
      customerId: l.customerId,
      vendorId: l.vendorId,
      salesRepId: l.salesRepId,
      productId: l.productId,
      quantity: l.quantity,
      dueDate: l.dueDate,
      generated,
      taxRole: manualTax ? l.taxRole : null,
      loadedAccountId: manualTax ? l.accountId : null,
      taxBase: manualTax && l.taxBase !== null && l.taxBase !== undefined ? String(l.taxBase) : '',
      ...(!generated && l.gross !== null && l.gross !== undefined
        ? { gross: String(l.gross), loadedDebit: amountText(l.debit), loadedCredit: amountText(l.credit), loadedTaxId: l.taxId }
        : {}),
    });
  });
}

/** السطور المرسلة: المولَّدة تُحذف (الخادم يعيد توليدها)، والفارغة كلياً تُهمل؛ `sent[i]` يقابل lineIndex في أخطاء الخادم. */
export function moveInputLines(lines: readonly GridLine[]): { sent: GridLine[]; input: MoveLineInput[] } {
  const sent = lines.filter(l => !l.generated && (l.accountId || l.debit.trim() || l.credit.trim() || l.label.trim()));
  return {
    sent,
    input: sent.map(l => {
      // الوعاء الشامل غير المعدَّل ⇒ المبلغ الشامل في جانبه (لا الصافي المخزَّن)
      const asLoaded = !!l.gross && l.debit === l.loadedDebit && l.credit === l.loadedCredit && l.taxId === l.loadedTaxId;
      const line: MoveLineInput = {
        accountId: l.accountId,
        label: l.label.trim() || null,
        debit: (asLoaded && l.debit.trim() ? l.gross : l.debit.trim()) || undefined,
        credit: (asLoaded && l.credit.trim() ? l.gross : l.credit.trim()) || undefined,
        taxId: l.taxId,
        vatBox: l.vatBox,
        analyticAccountId: l.analyticAccountId,
        partnerName: l.partnerName ?? null,
        customerId: l.customerId ?? null,
        vendorId: l.vendorId ?? null,
      };
      if (l.salesRepId) line.salesRepId = l.salesRepId;
      if (l.productId) line.productId = l.productId;
      if (l.quantity !== null && l.quantity !== undefined) line.quantity = l.quantity;
      if (l.dueDate) line.dueDate = l.dueDate;
      const sameAccount = !!l.loadedAccountId && l.loadedAccountId === l.accountId;
      if (l.taxRole === 'MARKER' && sameAccount && l.taxId) line.taxRole = 'MARKER';
      if ((l.taxRole === 'TAX' || l.taxRole === 'MARKER') && sameAccount && l.taxId && l.taxBase?.trim()) line.taxBaseMilli = l.taxBase.trim();
      return line;
    }),
  };
}
