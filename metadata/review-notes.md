# ملاحظات المراجعة (App Review Information)

> تُلصق في **App Store Connect → App Review Information → Notes**، مع حساب تجريبي.
> هدفها تجاوز **البند 4.2 (الحد الأدنى من الوظائف)** وشبهة **الميزات المالية** (نفس ما رُفضنا عليه في Google Play).

---

## 🔴 حساب تجريبي للمراجِع (Sign-In Required) — مطلوب من المالك

**تحقّقتُ فعلياً (5 أغسطس 2026): الحسابات التجريبية القديمة لم تعد تعمل.**
```
POST https://api.fieldsa.net/api/auth/login  {"username":"rep1","password":"rep123","role":"sales_rep"}
→ 401 {"success":false,"message":"بيانات الدخول غير صحيحة"}
(وكذلك admin@dsd.com/admin123 → 401)
```
السبب: كلمات مرور حسابات الـseed دُوِّرت سابقاً (راجع [[execution-gap-ops]]).

⚠️ **فشل دخول المراجِع = رفض فوري من آبل.** لذا **لا تضع `rep1/rep123`**.

**المطلوب:** أنشئ من لوحة الأدمن (fieldsa.net → المناديب → إضافة مندوب) حساب مندوب مخصّصاً للمراجعة — مثلاً اسم المستخدم `applereview` — بكلمة مرور ثابتة، وتأكّد أن:
- الشركة التابع لها **اشتراكها فعّال** (اشتراك منتهٍ يمنع الدخول ⇒ رفض).
- فيه **بيانات تجريبية كافية** (عملاء + أصناف) ليجرّب المراجِع إصدار فاتورة فعلاً.
- **لا تحذفه ولا تغيّر كلمته** طوال حياة التطبيق على المتجر (كل تحديث يُراجَع به).

ثم أدخل اسم المستخدم وكلمة المرور في App Store Connect ← Distribution ← App Review Information ← Sign-In Information.

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
• Bluetooth — only to connect to the rep's own portable receipt/label printer (version 1.1).
These are requested only in context, with clear purpose strings.

Version 1.1 — Bluetooth printing:
Sales reps can print invoices, receipts and shelf labels directly to their own portable Bluetooth Low Energy
receipt/label printer (ESC/POS and TSPL thermal printers). In the document screen: "Change" → "Direct Bluetooth" →
"Connect printer" opens a list of nearby printers; the rep picks theirs and prints. Bluetooth is used only for
this, only in the foreground, and only after the rep chooses a printer (purpose string shown at first use).
No data is collected over Bluetooth, and the printer identifier never leaves the phone. Without a printer
nearby the list simply shows a hint, and the rest of the app works exactly as before.
A short video of the feature on a real printer: <owner's unlisted link>.
The app still does not process payments.

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

## الإصدار 1.1.0 — الطباعة بالبلوتوث (للمرجع الداخلي)
- الفقرة الإنجليزية «Version 1.1 — Bluetooth printing» أعلاه تُلصق مع الملاحظات، مع رابط فيديو قصير (٢٠–٤٠ ثانية) للطباعة من الآيفون على طابعة حقيقية، لأن المراجع لا يملك طابعتنا (البند 2.1).
- نص الإذن (`NSBluetoothAlwaysUsageDescription`) محدّد بالعربية ويذكر الاستعمال نفسه (البند 5.1.1).
- لا وضع خلفية للبلوتوث (`bluetooth-central`) ولا Entitlements جديدة: حارس في codemagic.yaml (البند 2.5.4 ودرس انهيار البناء 4).
- «ما الجديد» بلا ذكر أي مزوّد. ما زال التطبيق لا يعالج مدفوعات، فجملة "does not process payments" صحيحة.
- App Privacy بلا تغيير: معرّف الطابعة يبقى على الجوال ولا يُجمع.

## التتبّع في الخلفية طوال يوم العمل (للمرجع الداخلي)
- قرار المالك (٥ نوفمبر ٢٠٢٦): **لا ملاحظة للمراجِع عن الموقع في الخلفية ولا عن «تسجيل الحضور»**، و«ما الجديد» عامٌّ: «تحديثات في المميزات وصيانة عامة». لا تُضِف فقرةً عن التتبّع إلى ملاحظات المراجعة.
- وضع الخلفية `location` في `UIBackgroundModes` مع إذن «أثناء استخدام التطبيق» وحده — لا طلب «دائماً» — والمؤشّر الأزرق ظاهر ما دام يعمل.
- شاشة إفصاح داخل التطبيق مرة واحدة قبل أول تشغيل، ويتوقف عند تسجيل الخروج أو نهاية اليوم أو إيقاف الشركة للتتبّع.
- App Privacy بلا تغيير: «الموقع الدقيق» مصرَّح به أصلاً لوظائف التطبيق ومرتبط بالمندوب، ولا تتبّع عبر التطبيقات.

## تذكيرات قبل الإرسال
- [ ] التتبّع مفعّل لشركة حساب المراجعة وللمندوب نفسه، وإلا لن يرى المراجِع شاشة الإفصاح ولا المؤشّر الأزرق.
- [ ] «بصمة الحضور» مطفأة لشركة حساب المراجعة، فيبدأ التتبّع بفتح التطبيق ويرى المراجِع شاشة الإفصاح دون أي خطوة.
- [ ] حساب المراجعة يعمل (اختبره بنفسك على fieldsa.net/rep).
- [ ] Support URL = https://fieldsa.net/contact · Privacy = https://fieldsa.net/privacy (كلاهما حيّ).
- [ ] لقطات الشاشة مرفوعة (راجع assets/screenshots/).
- [ ] استبيان App Privacy مملوء ([app-privacy.md](app-privacy.md)).
