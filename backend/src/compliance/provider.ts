// ============================================================================
// واجهة محوّل الامتثال الضريبي/الفوترة الإلكترونية (Compliance Provider)
// ----------------------------------------------------------------------------
// عقد موحّد لكل الدول: ZATCA (SA) مُنفَّذ، وETA/Peppol/TTN نقاط امتداد واضحة.
// اختيار المحوّل يتمّ حسب دولة الشركة (CompanySettings.einvoiceProvider لاحقًا).
// ============================================================================
import { zatcaProvider } from './zatca';

export type ProviderId = 'zatca' | 'eta' | 'peppol' | 'ttn' | 'none';

export interface ComplianceSeller {
  name: string;
  taxNumber: string;
}

export interface ComplianceInvoice {
  seller: ComplianceSeller;
  issuedAt: Date;
  total: number;      // الإجمالي شامل الضريبة
  vatTotal: number;   // إجمالي الضريبة
  currency: string;
  buyerTaxNumber?: string;
  invoiceNumber?: string;
}

export type ComplianceStatus =
  | 'generated'        // بُنيت الحمولة (مثل QR للمرحلة الأولى)
  | 'submitted'        // أُرسلت للمنظومة الحكومية
  | 'cleared'          // اعتُمدت (الأنظمة الفورية)
  | 'pending'          // بانتظار الاعتماد
  | 'not_implemented'  // نقطة امتداد لم تُنفَّذ بعد
  | 'error';

export interface ComplianceResult {
  ok: boolean;
  provider: ProviderId;
  status: ComplianceStatus;
  qr?: string;         // حمولة QR (ZATCA)
  documentId?: string; // UUID/معرّف اعتماد (ETA/Peppol)
  message?: string;
}

export interface ComplianceProvider {
  id: ProviderId;
  countryLabel: string;
  // يبني حمولة الامتثال (QR/مستند)
  build(inv: ComplianceInvoice): Promise<ComplianceResult>;
  // للأنظمة ذات الربط الحكومي الفوري: إرسال المستند واستقبال الاعتماد
  submit?(inv: ComplianceInvoice): Promise<ComplianceResult>;
}

// نقطة امتداد صريحة: تُعيد "غير مُنفَّذ" بوضوح بدل تظاهر زائف
function notImplemented(id: ProviderId, label: string): ComplianceProvider {
  return {
    id, countryLabel: label,
    async build(): Promise<ComplianceResult> {
      return { ok: false, provider: id, status: 'not_implemented',
        message: `محوّل ${label} نقطة امتداد لم تُنفَّذ بعد — يتطلّب تكاملًا حكوميًا معتمدًا.` };
    },
  };
}

// محوّل "بلا فوترة إلكترونية" (دول الخليج التي لا تُلزم بعد) — فاتورة عادية بلا حمولة حكومية
const noneProvider: ComplianceProvider = {
  id: 'none', countryLabel: 'بلا فوترة إلكترونية إلزامية',
  async build(): Promise<ComplianceResult> {
    return { ok: true, provider: 'none', status: 'generated' };
  },
};

// السجلّ: يربط معرّف المزوّد بتطبيقه
const REGISTRY: Record<ProviderId, ComplianceProvider> = {
  zatca: zatcaProvider,
  eta: notImplemented('eta', 'ETA — مصر (فاتورة/إيصال إلكتروني)'),
  peppol: notImplemented('peppol', 'Peppol — الإمارات (5-corner)'),
  ttn: notImplemented('ttn', 'TTN el-Fatoura — تونس'),
  none: noneProvider,
};

// يعيد محوّل الامتثال حسب المعرّف (يرجع "none" لأي معرّف غير معروف)
export function getComplianceProvider(id?: string | null): ComplianceProvider {
  if (id && (id as ProviderId) in REGISTRY) return REGISTRY[id as ProviderId];
  return REGISTRY.none;
}
