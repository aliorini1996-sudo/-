import QRCode from 'qrcode';

/**
 * طباعة الفاتورة الضريبية التي تُصدرها المنصّة لمشتركها.
 *
 * تُبنى صفحة مكتملة في نافذة جديدة ثم تُستدعى طباعة المتصفّح — نفس أسلوب
 * طباعة مولّد الفواتير. رمز ZATCA يُصيَّر هنا من حمولة TLV المخزَّنة
 * (base64 نصّي لا صورة)، فالمخزَّن هو **المحتوى** والرسم شأن العارض.
 */

export interface PrintableInvoice {
  number: string;
  buyerName: string;
  buyerVatNo: string | null;
  description: string;
  totalSar: number;
  vatSar: number;
  netSar: number;
  qrBase64: string;
  issuedAt: string;
}

export interface SellerInfo {
  name: string;
  vatNumber: string;
  crNumber: string;
  address: string;
}

const sar = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function printPlatformInvoice(inv: PrintableInvoice, seller: SellerInfo): Promise<void> {
  // رمز ZATCA: المحتوى هو سلسلة TLV بترميز base64 كما تنصّ المواصفة
  const qrDataUrl = await QRCode.toDataURL(inv.qrBase64, { width: 180, margin: 1 }).catch(() => '');

  const issued = new Date(inv.issuedAt);
  const dateStr = issued.toLocaleDateString('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', year: 'numeric', month: 'long', day: 'numeric' });

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>فاتورة ضريبية ${inv.number}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #1F1A13; background: #fff; padding: 32px; }
  .sheet { max-width: 720px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1F1A13; padding-bottom: 16px; }
  .brand { font-size: 22px; font-weight: 800; }
  .brand small { display: block; font-size: 12px; font-weight: 400; color: #6E6557; margin-top: 4px; }
  .title { text-align: left; }
  .title h1 { font-size: 18px; }
  .title .num { font-size: 14px; color: #6E6557; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 13px; }
  th, td { padding: 8px 10px; text-align: right; border: 1px solid #E7DECD; }
  th { background: #FBF6EC; font-weight: 700; white-space: nowrap; }
  .totals td { font-variant-numeric: tabular-nums; }
  .totals .grand { font-weight: 800; font-size: 15px; background: #FBF6EC; }
  .qr { display: flex; align-items: center; gap: 16px; margin-top: 22px; }
  .qr img { width: 140px; height: 140px; }
  .qr p { font-size: 11px; color: #6E6557; max-width: 300px; line-height: 1.7; }
  .foot { margin-top: 26px; font-size: 11px; color: #6E6557; border-top: 1px solid #E7DECD; padding-top: 10px; }
  @media print { body { padding: 0; } }
</style></head><body><div class="sheet">
  <div class="head">
    <div class="brand">${seller.name}
      <small>س.ت ${seller.crNumber} · الرقم الضريبي ${seller.vatNumber}</small>
      <small>${seller.address}</small>
    </div>
    <div class="title">
      <h1>فاتورة ضريبية</h1>
      <div class="num">${inv.number}</div>
      <div class="num">${dateStr}</div>
    </div>
  </div>

  <table>
    <tr><th style="width:120px">المشتري</th><td>${inv.buyerName}${inv.buyerVatNo ? ` — الرقم الضريبي ${inv.buyerVatNo}` : ''}</td></tr>
    <tr><th>البيان</th><td>${inv.description}</td></tr>
  </table>

  <table class="totals">
    <tr><th style="width:220px">الإجمالي قبل الضريبة</th><td>${sar(inv.netSar)} ر.س</td></tr>
    <tr><th>ضريبة القيمة المضافة (15٪)</th><td>${sar(inv.vatSar)} ر.س</td></tr>
    <tr class="grand"><th>الإجمالي شامل الضريبة</th><td>${sar(inv.totalSar)} ر.س</td></tr>
  </table>

  <div class="qr">
    ${qrDataUrl ? `<img src="${qrDataUrl}" alt="ZATCA QR">` : ''}
    <p>رمز الاستجابة السريعة وفق متطلّبات هيئة الزكاة والضريبة والجمارك — المرحلة الأولى من الفوترة الإلكترونية (ترميز TLV).</p>
  </div>

  <div class="foot">أُصدرت هذه الفاتورة آلياً عند تأكيد الدفع عبر بوابة الدفع الإلكتروني · fieldsa.net</div>
</div>
<script>window.onload = () => { window.print(); };</script>
</body></html>`;

  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}
