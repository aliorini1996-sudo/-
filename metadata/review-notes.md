# ملاحظات المراجعة — تطبيق الإدارة

> تُلصق في **App Store Connect → App Review Information → Notes** مع حساب تجريبي.
> الهدف: تجاوز **البند 4.2 (الحد الأدنى من الوظائف)** وشبهة **الميزات المالية** — نفس ما عالجناه لتطبيق المندوب.

---

## ✅ حساب مراجعة عامل — مُتحقَّق منه

```
Username: AA@AAA.com
Password: 12345678
```
> يُدخلان في **App Store Connect → App Review Information → Sign-In Information** (يكتبهما المالك بنفسه).

**تحقّق فعلي (5 أغسطس 2026):** الدخول يرجع **HTTP 200** · الدور **MANAGER** بكل الصلاحيات · الشركة «الشركة التجريبية» **اشتراكها فعّال**. وكل تبويب يعرض بيانات حقيقية:

| التبويب | البيانات المتاحة |
|---|---|
| الرئيسية | لوحة كاملة (اليوم/الشهر/أفضل المناديب والعملاء) |
| الفواتير | **23** فاتورة |
| التحصيل | **5** سندات |
| العملاء | **50+** عميلاً |
| التتبّع | **مُفعّل** ومندوب بموقع حيّ + 5 مناديب |

⚠️ **لا تحذف هذا الحساب ولا تغيّر كلمته ولا تدع اشتراك شركته ينتهي** — يُستخدم في كل مراجعة مستقبلية. (فشل دخول المراجِع = رفض فوري.)
> الحساب القديم `admin@dsd.com/admin123` **لا يعمل** (401) — لا تستخدمه.

**لإعادة التحقّق مستقبلاً:**
```bash
curl -s -X POST https://api.fieldsa.net/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"AA@AAA.com","password":"12345678","role":"admin"}'
```

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
