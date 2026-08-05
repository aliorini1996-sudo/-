# إعداد ورفع تطبيق الإدارة

> ⚡ أسرع بكثير من تطبيق المندوب: **الحساب مفعّل، ومفتاح API موجود، وCodemagic مربوط** — يتبقّى تسجيل معرّف جديد وتطبيق جديد.

---

## ما هو جاهز بالفعل (لا تكرّره)
- ✅ حساب Apple Developer مفعّل (Team `QKD58WVK2R`).
- ✅ مفتاح App Store Connect API باسم **`FieldSales ASC Key`** — نفس المفتاح يخدم كل تطبيقات الحساب.
- ✅ حساب Codemagic مربوط بمستودع `aliorini1996-sudo/-`.

---

## 1) سجّل معرّف الحزمة (دقيقتان)
[developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list) → **+** → **App IDs** → **App**:
- Description: `FieldSales Admin`
- Bundle ID: **Explicit** → **`net.fieldsa.admin`**
- بلا أي Capabilities → **Register**

## 2) أنشئ التطبيق في App Store Connect (3 دقائق)
[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** → **+** → **New App**:
- Platform **iOS** · Name: **فيلد سيلز — إدارة الشركة** · Language: **Arabic**
- Bundle ID: `net.fieldsa.admin` · SKU: `fieldsa-admin` · Full Access → **Create**

## 3) شغّل البناء في Codemagic
- Codemagic → التطبيق `-` → **Start new build**
- الفرع: **`ios-admin-app`** · الووركفلو: **`ios-admin-appstore`** → Start
- المدّة ~4 دقائق، ثم يُرفع إلى TestFlight تلقائياً.

> ⚠️ **حدّ شهادات التوزيع (3):** استُهلكت واحدة لتطبيق المندوب. هذا البناء سينشئ **ثانية**. لتفادي بلوغ الحدّ مستقبلاً، احفظ مفتاحاً خاصاً مرّة واحدة في Codemagic → Settings → **Global variables and secrets** باسم **`CERTIFICATE_PRIVATE_KEY`** (Secure)، فيعيد كل البناءات استخدام شهادة واحدة:
> ```bash
> openssl genrsa -out cert_key.pem 2048
> ```
> والصق **كامل** محتوى الملف (مع سطري BEGIN/END).

## 4) أكمل صفحة المتجر
| القسم | المصدر |
|---|---|
| الوصف والكلمات والروابط | [`metadata/app-store-listing.md`](metadata/app-store-listing.md) |
| App Privacy (6 أنواع) | [`metadata/app-privacy.md`](metadata/app-privacy.md) |
| ملاحظات المراجعة + حساب تجريبي | [`metadata/review-notes.md`](metadata/review-notes.md) |
| الفئة / العمر / حقوق المحتوى | Business + Productivity · 4+ · لا محتوى طرف ثالث |
| التسعير | مجاني (0.00) · كل الدول |
| أيقونة المتجر | [`assets/AppIcon-1024.png`](assets/AppIcon-1024.png) |

## 5) اللقطات (بعد تثبيته من TestFlight)
التقط من الآيفون: **الرئيسية** · **الفواتير** · **تفاصيل فاتورة/PDF** · **العملاء** · **كشف حساب** · **التتبّع على الخريطة**.

⚠️ **الصندوق الصحيح:** Previews and Screenshots → **View All Sizes in Media Manager** → **iPhone 6.9" Display** (يقبل 1290×2796). صندوق 6.5" يرفض هذا المقاس.
⚠️ **لا ترسل اللقطات عبر واتساب كصورة** — يضغطها إلى 591×1280 فتُرفض. استخدم «إرسال كمستند» أو iCloud/USB.

## 6) الإرسال
Add for Review → اختر البناء → **Manually release** (كي لا يُنشر دون قرارك) → **Submit for Review**.

---

## أخطاء شائعة (مُختبَرة على تطبيق المندوب)
| العرض | الحل |
|---|---|
| `No matching profiles found` | لم تسجّل Bundle ID/App record بعد → الخطوتان 1 و2. |
| `Cannot save Signing Certificates without certificate private key` | مُعالَج في `codemagic.yaml` (يولّد مفتاحاً أو يستخدم `CERTIFICATE_PRIVATE_KEY`). |
| `Certificate limit reached` | احذف شهادة قديمة من [Certificates](https://developer.apple.com/account/resources/certificates/list) أو اضبط `CERTIFICATE_PRIVATE_KEY`. |
| انهيار عند الإقلاع | كل مسبّباته المعروفة مُعالَجة مسبقاً في المولّد (راجع [README](README.md)). |
| رفض 4.2 / ميزات مالية | الردّ الجاهز في [`metadata/review-notes.md`](metadata/review-notes.md). |
