// طباعة حرارية 58 مم — تعمل مع الطابعة المدمجة أو طابعة بلوتوث عبر نظام الطباعة في الجهاز
import QRCode from 'qrcode';
import { buildZatcaQr, zatcaTimestamp } from './zatca';
import { paymentMethodLabels } from '../utils/format';
import type { InvoiceDoc, ReceiptDoc } from './RepDocuments';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
function money(n: number): string { return (Number(n) || 0).toFixed(2); }
function dt(d: string): string {
  const t = new Date(d);
  if (isNaN(t.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

// يطبع محتوى HTML في إطار مخفي بمقاس 58 مم
function printHTML(body: string): void {
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style>
    @page { size: 58mm auto; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { width: 58mm; margin: 0; padding: 0; }
    body { padding: 2mm 2.5mm 4mm; font-family: 'Tahoma','Arial',sans-serif; font-size: 11px; color: #000; line-height: 1.5; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: 14px; }
    .xl { font-size: 17px; }
    .sep { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .muted { font-size: 10px; }
    .item { margin: 3px 0; }
    .iname { font-weight: 600; }
    .qr { text-align: center; margin: 8px 0 4px; }
    img { display: inline-block; }
  </style></head><body>${body}</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:-9999px;bottom:0;width:80mm;height:0;border:0;';
  document.body.appendChild(iframe);
  const idoc = iframe.contentWindow?.document;
  if (!idoc) { iframe.remove(); return; }
  idoc.open(); idoc.write(html); idoc.close();

  const fire = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { /* */ }
    setTimeout(() => iframe.remove(), 2000);
  };
  // ننتظر تحميل صورة QR قبل إطلاق الطباعة
  setTimeout(fire, 400);
}

async function qrBlock(company: InvoiceDoc['company'], date: string, total: number, vat: number): Promise<string> {
  if (!company?.taxNumber) return '';
  try {
    const payload = buildZatcaQr({
      sellerName: company.name || '', vatNumber: company.taxNumber,
      timestamp: zatcaTimestamp(date), total, vatTotal: vat,
    });
    const url = await QRCode.toDataURL(payload, { width: 160, margin: 0 });
    return `<div class="qr"><img src="${url}" width="124" height="124"/></div>`;
  } catch { return ''; }
}

function head(company: InvoiceDoc['company']): string {
  return `
    <div class="c b lg">${esc(company?.name || 'الشركة')}</div>
    ${company?.taxNumber ? `<div class="c muted">الرقم الضريبي: ${esc(company.taxNumber)}</div>` : ''}
    ${company?.address ? `<div class="c muted">${esc(company.address)}</div>` : ''}
    ${company?.phone ? `<div class="c muted">هاتف: ${esc(company.phone)}</div>` : ''}`;
}

export async function printThermalInvoice(doc: InvoiceDoc): Promise<void> {
  const isSimplified = !doc.customer.taxNumber;
  const title = doc.isReturn ? 'إشعار دائن (مرتجع)' : (isSimplified ? 'فاتورة ضريبية مبسطة' : 'فاتورة ضريبية');
  const qr = await qrBlock(doc.company, doc.date, doc.total, doc.tax);
  const items = doc.items.map(it => `
    <div class="item">
      <div class="iname">${esc(it.name)}${it.unit ? ` <span class="muted">(${esc(it.unit)})</span>` : ''}</div>
      <div class="row"><span>${it.qty} × ${money(it.unitPrice)}${it.discountPct > 0 ? ` -${it.discountPct}%` : ''}</span><span class="b">${money(it.lineTotal)}</span></div>
    </div>`).join('');

  printHTML(`
    ${head(doc.company)}
    <div class="sep"></div>
    <div class="c b">${title}</div>
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>التاريخ</span><span>${dt(doc.date)}</span></div>
    <div class="row"><span>المندوب</span><span>${esc(doc.repName)}</span></div>
    <div class="row"><span>العميل</span><span>${esc(doc.customer.name)}</span></div>
    ${doc.customer.taxNumber ? `<div class="row"><span>ر.ضريبي</span><span>${esc(doc.customer.taxNumber)}</span></div>` : ''}
    <div class="sep"></div>
    ${items}
    <div class="sep"></div>
    <div class="row"><span>المجموع قبل الضريبة</span><span>${money(doc.subtotal - doc.discount)}</span></div>
    ${doc.discount > 0 ? `<div class="row"><span>الخصم</span><span>${money(doc.discount)}</span></div>` : ''}
    <div class="row"><span>ض.ق.م 15%</span><span>${money(doc.tax)}</span></div>
    <div class="row b lg"><span>${doc.isReturn ? 'إجمالي المرتجع' : 'الإجمالي'}</span><span>${money(doc.total)}</span></div>
    ${!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined ? `
      <div class="row muted"><span>المدفوع</span><span>${money(doc.paidAmt ?? 0)}</span></div>
      <div class="row muted"><span>المتبقي</span><span>${money(doc.remainingAmt)}</span></div>` : ''}
    <div class="sep"></div>
    ${qr}
    <div class="c muted">${esc(doc.company?.name || '')}</div>
    <div class="c muted">شكراً لتعاملكم معنا</div>
  `);
}

export async function printThermalReceipt(doc: ReceiptDoc): Promise<void> {
  printHTML(`
    ${head(doc.company)}
    <div class="sep"></div>
    <div class="c b">سند قبض</div>
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>التاريخ</span><span>${dt(doc.date)}</span></div>
    <div class="row"><span>المندوب</span><span>${esc(doc.repName)}</span></div>
    <div class="sep"></div>
    <div class="row"><span>استلمنا من</span><span>${esc(doc.customer.name)}</span></div>
    <div class="row"><span>طريقة الدفع</span><span>${esc(paymentMethodLabels[doc.paymentMethod] || doc.paymentMethod)}</span></div>
    ${doc.notes ? `<div class="row"><span>ملاحظات</span><span>${esc(doc.notes)}</span></div>` : ''}
    <div class="sep"></div>
    <div class="c muted">المبلغ المستلم</div>
    <div class="c b xl">${money(doc.amount)} ر.س</div>
    <div class="sep"></div>
    <div class="c muted">${esc(doc.company?.name || '')}</div>
    <div class="c muted">شكراً لتعاملكم معنا</div>
  `);
}
