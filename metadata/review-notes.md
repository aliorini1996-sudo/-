# ملاحظات المراجعة — تطبيق الإدارة

> تُلصق في **App Store Connect → App Review Information → Notes** مع حساب تجريبي.
> الهدف: تجاوز **البند 4.2 (الحد الأدنى من الوظائف)** وشبهة **الميزات المالية** — نفس ما عالجناه لتطبيق المندوب.

---

## 🔴 حساب مراجعة عامل — مطلوب من المالك

**تحقّقتُ فعلياً: حسابات الـseed القديمة لا تعمل** (`admin@dsd.com/admin123` ⇒ 401). كلمات المرور دُوِّرت سابقاً.
⚠️ **فشل دخول المراجِع = رفض فوري.**

**المطلوب:** حساب **مدير شركة** يعمل على `fieldsa.net/m`، بشرط:
- الشركة **اشتراكها فعّال** (اشتراك منتهٍ يمنع الدخول ⇒ رفض).
- فيه **بيانات كافية**: عملاء وفواتير وسندات ليرى المراجِع شاشات غير فارغة.
- ويفضّل أن تكون **بيانات تتبّع** موجودة (مسار مندوب واحد على الأقل) ليعمل تبويب التتبّع.
- **لا يُحذف ولا تتغيّر كلمته** طوال حياة التطبيق على المتجر.

**اختبر قبل الإرسال:**
```bash
curl -s -X POST https://api.fieldsa.net/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<البريد>","password":"<الكلمة>","role":"admin"}'
```
النتيجة المطلوبة: `HTTP 200` مع `"success": true`.

---

## Notes (انسخها كما هي)

```
FieldSales — Company Admin is an internal business tool for managers at wholesale
distribution companies (a B2B field-sales / van-sales platform). It is NOT a consumer
app and NOT a financial service: it does not process payments, move money, hold funds,
or offer any consumer financial product. "Invoices" and "receipts" are business
documents (like a CRM/ERP), kept for the company's own records and ZATCA (Saudi tax
authority) e-invoicing compliance.

The app requires a manager account issued by the company. Please use the demo account
provided in the fields above.

This is the management counterpart to our sales-rep app (bundle net.fieldsa.rep): reps
issue documents in the field, managers oversee them here.

Core functionality (beyond a website):
• Live dashboard of the company's daily sales, collections and document counts.
• Invoices: view, export PDF, create, and cancel.
• Payment receipts: view, issue, and cancel.
• Customers: search, details, account statements, create/edit, and capture the
  customer's location on a map.
• Rep tracking: live team locations, each rep's daily route, and their field visits.

Permissions:
• Location — used only when a manager taps "capture location" while adding or editing
  a customer. There is no background tracking of the manager's own device.

The app has no user-generated public content, no social features, and no in-app
purchases. It is distributed to a company's own management staff.

Contact for questions: help@fieldsa.net
```

---

## لماذا نتجاوز البند 4.2
ليس غلافاً لموقع: لوحة معلومات لحظية، إنشاء/إلغاء مستندات فعلية، كشوف حسابات، خرائط تتبّع مباشرة، والتقاط موقع بالـGPS — وظائف أعمال حقيقية مذكورة صراحةً للمراجِع.

## لماذا لسنا «خدمة مالية»
لا معالجة مدفوعات ولا تحويل أموال ولا حفظ أرصدة مستخدمين ولا منتج مالي للمستهلك. طابِق هذا مع: وصف المتجر + استبيان الخصوصية (**بلا Financial Info**) + الفئة **Business**.

## تذكيرات قبل الإرسال
- [ ] حساب المراجعة مُختبَر (الأمر أعلاه يرجع 200).
- [ ] Support = https://fieldsa.net/contact · Privacy = https://fieldsa.net/privacy.
- [ ] لقطات iPhone 6.9" (1290×2796) — **من صندوق 6.9" في Media Manager لا صندوق 6.5"**.
- [ ] استبيان App Privacy منشور ([app-privacy.md](app-privacy.md)).
