# ملاحظات المراجعة (App Review Information)

> تُلصق في **App Store Connect → App Review Information → Notes**، مع حساب تجريبي.
> هدفها تجاوز **البند 4.2 (الحد الأدنى من الوظائف)** وشبهة **الميزات المالية** (نفس ما رُفضنا عليه في Google Play).

---

## حساب تجريبي للمراجِع (Sign-In Required)
```
التطبيق يفتح على شاشة دخول المندوب مباشرة.
Demo rep account:
  Username: rep1
  Password: rep123
```
> ⚠️ **على المالك:** تأكّد أن `rep1/rep123` يعمل على `fieldsa.net/rep` قبل الإرسال، ويفضّل إنشاء حساب مراجعة مخصّص ثابت (مثل `applereview`) لا يتغيّر. آبل ترفض فوراً إن فشل الدخول.

---

## Notes (انسخها كما هي — بالإنجليزية للمراجِع)

```
FieldSales — Sales Rep is an internal business tool for employees of wholesale
distribution companies (a B2B field-sales / van-sales solution). It is NOT a
consumer app and NOT a financial service: it does not process payments, move money,
hold funds, or offer any consumer financial product. "Invoices" and "receipts" are
business documents (like a CRM/ERP), generated for the company's own records and
ZATCA (Saudi tax authority) e-invoicing compliance.

The app requires an account issued by the rep's employer. Use the demo account above.

Core native/substantive functionality (beyond a website):
• Create ZATCA-compliant tax invoices with QR codes; export/share as PDF.
• Payment receipts and running collection balances (company bookkeeping).
• Per-customer account statements with running balance and credit limits.
• Sales-return invoices.
• Van inventory management (stock decrements per sale).
• Field-visit logging with camera photos and GPS location.
• Live GPS route tracking (enabled by the company admin, with rep consent).
• Offline mode: invoices/receipts are created offline and sync automatically.

Permissions:
• Location — to log visit locations and track the rep's field route.
• Camera / Photos — to attach visit photos and (optionally) scan product barcodes.
These are requested only in context, with clear purpose strings.

The app has no user-generated public content, no social features, and no in-app
purchases. It is distributed to a company's own field staff.

Contact for questions: help@fieldsa.net
```

---

## لماذا نتجاوز البند 4.2 (للمرجع الداخلي)
التطبيق ليس «غلافاً لموقع» — بل أداة أعمال بوظائف حقيقية: فوترة ZATCA، محاسبة تحصيل، مخزون سيارة، زيارات بكاميرا وGPS، **وعمل دون اتصال** (يميّزه عن صفحة ويب). هذه الوظائف مذكورة صراحةً للمراجِع أعلاه.

## لماذا لسنا «خدمة مالية»
- لا معالجة مدفوعات، لا تحويل أموال، لا حفظ أرصدة مستخدمين، لا منتج مالي للمستهلك.
- «الفواتير/السندات» = مستندات أعمال داخلية (مثل ERP/CRM) لموظفي شركة التوزيع.
- طابِق هذا مع: وصف المتجر + استبيان الخصوصية (لا Financial Info) + الفئة = **Business**.

## تذكيرات قبل الإرسال
- [ ] حساب المراجعة يعمل (اختبره بنفسك على fieldsa.net/rep).
- [ ] Support URL = https://fieldsa.net/contact · Privacy = https://fieldsa.net/privacy (كلاهما حيّ).
- [ ] لقطات الشاشة مرفوعة (راجع assets/screenshots/).
- [ ] استبيان App Privacy مملوء ([app-privacy.md](app-privacy.md)).
