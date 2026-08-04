# ربط Codemagic ورفع تطبيق المندوب إلى TestFlight/App Store

> يُنفَّذ **بعد تفعيل حساب Apple Developer**. الترتيب مهم: أنشئ App record أولاً (ليوجد Bundle ID) قبل أول بناء.
> أدوارك أنت (المالك): إنشاء المفاتيح والحسابات والدفع. أنا جهّزت المشروع و`codemagic.yaml` بالكامل.

---

## نظرة عامة على التدفّق
```
مشروع iOS (جاهز) ──push──▶ GitHub ──▶ Codemagic (بناء macOS + توقيع) ──▶ TestFlight ──▶ App Store
```
`codemagic.yaml` في جذر هذا المجلّد يفعل كل شيء: `pod install` → توقيع → بناء IPA → رفع لـTestFlight.

---

## 1) أنشئ مفتاح App Store Connect API (بعد تفعيل الحساب)
App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** → **Generate API Key**:
- الدور: **App Manager** (أو Admin).
- نزّل ملف **`.p8`** (يُنزَّل مرة واحدة فقط — احفظه).
- انسخ **Issuer ID** و **Key ID**.

## 2) أنشئ App record (ليوجد Bundle ID قبل التوقيع)
App Store Connect → **Apps** → **+** → **New App**:
- Platform: **iOS** · Name: **فيلد سيلز — مندوب المبيعات** · Primary Language: **Arabic**
- **Bundle ID:** إن لم يظهر `net.fieldsa.rep`، أنشئه في [Certificates, IDs & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list) (App ID، Explicit، `net.fieldsa.rep`) ثم عُد.
- SKU: `fieldsa-rep` · User Access: Full.

## 3) المشروع على GitHub ✅ (منجز)
مشروع iOS مدفوع كفرع مستقل جذره محتوى ios-app (كما يتطلّب Codemagic):
- المستودع: `aliorini1996-sudo/-` (مستودع dsd القائم) · **الفرع: `ios-app`** · 73 ملفاً، `codemagic.yaml` في الجذر.

## 4) أنشئ حساب Codemagic واربط المفتاح
- سجّل الدخول على <https://codemagic.io> بحساب GitHub (الخطة المجانية: **500 دقيقة macOS/شهر** — تكفي).
- **Teams → Personal Account → Integrations → Developer Portal (App Store Connect) → Connect**: ألصق **Issuer ID** و**Key ID** وارفع ملف **`.p8`**، وسمّه **حرفياً**: `FieldSales ASC Key` (يطابق `codemagic.yaml`).
- **Add application** → اختر المستودع `aliorini1996-sudo/-` → Codemagic يقرأ `codemagic.yaml` من الفرع المُختار عند البناء.

## 5) شغّل البناء
- افتح التطبيق في Codemagic → **Start new build** → اختر **الفرع `ios-app`** + ووركفلو **`ios-appstore`**.
- سيبني، يوقّع (يُنشئ الشهادة وملف التعريف تلقائياً)، ويرفع إلى **TestFlight**.
- عند النجاح: يظهر البناء في App Store Connect → **TestFlight** خلال ~10–30 دقيقة (بعد معالجة آبل).

## 6) بعد أول بناء ناجح
1. **TestFlight:** ثبّت التطبيق على آيفونك عبر تطبيق TestFlight وجرّبه فعلياً.
2. **صفحة المتجر:** املأ بيانات المتجر من [`metadata/app-store-listing.md`](metadata/app-store-listing.md) + ارفع [الأيقونة](assets/AppIcon-1024.png) واللقطات.
3. **الخصوصية والمراجعة:** أجب استبيان App Privacy ([`metadata/app-privacy.md`](metadata/app-privacy.md)) وأضف ملاحظات المراجِع + حساب تجريبي ([`metadata/review-notes.md`](metadata/review-notes.md)).
4. **أرسل للمراجعة** (Submit for Review). مدة المراجعة عادةً 24–48 ساعة.

---

## ⚠️ فخّ حدّ الشهادات (مهم للبناءات القادمة)
سكربت التوقيع الحالي **يولّد مفتاحاً خاصاً جديداً في كل بناء**، فتُنشأ **شهادة توزيع جديدة كل مرة**. وآبل تسمح بـ**3 شهادات توزيع** فقط.
- **الحالة (5 أغسطس 2026):** شهادة واحدة مستخدمة (تنتهي 2027/08/05) ⇒ يتبقّى بناءان قبل بلوغ الحدّ.
- **الحلّ الدائم (يُنفَّذ مرّة واحدة):** ولّد مفتاحاً خاصاً واحفظه في Codemagic كمتغيّر سرّي فيُعاد استخدام نفس الشهادة دائماً:
  1. ولّد المفتاح محلياً: `openssl genrsa -out cert_key.pem 2048`
  2. Codemagic → **Settings (الحساب الشخصي)** → **codemagic.yaml settings** → **Global variables and secrets** → أضف متغيّراً باسم **`CERTIFICATE_PRIVATE_KEY`** والصق **كامل محتوى** `cert_key.pem` (بما فيه سطرا BEGIN/END)، وفعّل **Secure**.
  3. السكربت يلتقطه تلقائياً (الفرع الآخر في `codemagic.yaml`) ولن يُنشئ شهادة جديدة بعدها.
- **إن بلغت الحدّ فعلاً:** احذف شهادة قديمة من [Certificates](https://developer.apple.com/account/resources/certificates/list) (حذف شهادة توزيع لا يُعطّل تطبيقاً منشوراً بالفعل).

## مصادر شائعة للفشل وحلولها (مُختبَرة فعلياً في أول نشر)
| العرض | السبب/الحل |
|---|---|
| `No matching profiles found for bundle identifier ... app_store` | **سببان:** (أ) لم تُنشئ App ID/App record بعد → نفّذ الخطوتين 1 و2. (ب) **الأهم:** كتلة `ios_signing` في `environment` تجلب ملف تعريف موجوداً فقط ولا تُنشئه، وتفشل أثناء التحضير **قبل** تشغيل السكربتات → أُزيلت، والتوقيع صار في السكربتات بـ`fetch-signing-files --create`. |
| `Cannot save Signing Certificates without certificate private key` | `fetch-signing-files --create` يحتاج مفتاحاً خاصاً → السكربت يولّده بـ`openssl genrsa` ويمرّره بـ`--certificate-key` (أو يستخدم `CERTIFICATE_PRIVATE_KEY` إن ضُبط). |
| `Certificate limit reached` | راجع فخّ حدّ الشهادات أعلاه. |
| فشل `pod install` (Firebase) | Firebase مثبّت على `~> 11.0` في `Podfile`؛ إن تغيّرت البيئة جرّب `pod repo update`. |
| رفض «Guideline 4.2» | راجع [`metadata/review-notes.md`](metadata/review-notes.md) — التموضع كأداة أعمال وإبراز الوظائف الأصلية. |
| رفض «الميزات المالية» | نفس ما واجهناه في Google Play → التطبيق أداة أعمال داخلية، لا خدمة مالية للمستهلك. |

## ملاحظات تقنية عن المشروع (للمرجع)
- غلاف **WKWebView** يحمّل `https://fieldsa.net/rep` حيّاً (كالـTWA على أندرويد) — أي تحديث واجهة يظهر فوراً بلا إعادة بناء.
- `WKAppBoundDomains = fieldsa.net, api.fieldsa.net` → يُفعّل Service Worker والعمل دون اتصال.
- Firebase مُضمّن ومُهيّأ لكنه خامل (بلا تسجيل إشعارات) — لا يطلب إذناً ولا ينهار.
- Entitlements فارغة (لا صلاحيات خاصة) → توقيع تلقائي بلا احتكاك. الكاميرا/الموقع تكفيها أوصاف `Info.plist`.
- الإصدار: `1.0.0` (build يتزايد تلقائياً في كل تشغيل Codemagic).
