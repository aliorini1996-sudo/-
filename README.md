# تطبيق الإدارة على App Store (iPhone)

غلاف iOS لتطبيق إدارة الشركة (`fieldsa.net/m`) — التطبيق الثاني بعد [تطبيق المندوب](../ios-app/README.md).

| | تطبيق المندوب | **تطبيق الإدارة** |
|---|---|---|
| Bundle ID | `net.fieldsa.rep` | **`net.fieldsa.admin`** |
| الرابط | `fieldsa.net/rep` | **`fieldsa.net/m`** |
| اسم الوحدة | `FieldSales` | **`FieldSalesAdmin`** |
| تحت الأيقونة | FieldSales | **إدارة** |
| الأيقونة | برتقالية | **فحميّة (ألوان معكوسة)** |
| الأذونات | كاميرا + صور + موقع | **موقع فقط** |
| أوف‑لاين | نعم | لا (أون‑لاين) |
| فرع البناء | `ios-app` | **`ios-admin-app`** |

المشروعان يُولَّدان من **مصدر واحد**: `web-admin/scripts/gen-ios-project.mjs`.

---

## إعادة التوليد
```bash
cd web-admin
node scripts/gen-ios-project.mjs admin    # هذا المشروع
node scripts/gen-ios-project.mjs rep      # تطبيق المندوب
```
> السكربت يحتاج قالب PWABuilder في مجلّد العمل المؤقّت؛ إن غاب نزّله:
> `curl -sSL -o p.tar.gz https://codeload.github.com/pwa-builder/pwabuilder-ios-app-store/tar.gz/refs/heads/main && tar -xzf p.tar.gz`
>
> ⚠️ **لا تُشغّل الهدفين في أمر واحد متتابع** — مزامنة OneDrive تسبّب تعارض ملفات عابراً يُفشل الثاني. شغّلهما منفصلين.

## ما طُبّق على القالب (نفس إصلاحات تطبيق المندوب)
1. **لا `CODE_SIGN_ENTITLEMENTS`** ولا مجلّد Entitlements ولا أي سطر يذكره في pbxproj — صلاحيات تخالف ملف التعريف تقتل التطبيق عند الإقلاع بـCODESIGNING.
2. **Firebase خامل تماماً** (configure وdelegate معلّقان) — لا كود يعمل عند الإقلاع.
3. **لا `as! UIWindowScene`** — استُبدلت بـ`as?` (انهيار إقلاع معروف في القالب).
4. **إصلاح `CloudpilotEmu`** المتسرّب من القالب.
5. `WKAppBoundDomains = fieldsa.net, api.fieldsa.net` · iPhone فقط · الإصدار 1.0.0.
6. **أذونات مطابقة للواقع:** الموقع فقط (حُذفت الكاميرا والميكروفون ومكتبة الصور من `Info.plist`) — `src/m` يستدعي `navigator.geolocation` فحسب.

## الملفات
```
ios-admin-app/
├── codemagic.yaml              خط البناء (فرع ios-admin-app)
├── CODEMAGIC-SETUP.md          دليل الربط والإرسال
├── FieldSalesAdmin.xcworkspace  ← يُبنى هذا
├── FieldSalesAdmin.xcodeproj    السكيم: FieldSalesAdmin
├── FieldSalesAdmin/            الغلاف + Info.plist + الأيقونات
├── assets/AppIcon-1024.png     أيقونة المتجر
└── metadata/                   بيانات المتجر + الخصوصية + ملاحظات المراجعة
```

## الحالة
- ✅ المشروع مُولّد ومتحقَّق (0 رموز عالقة، 0 أسماء قديمة).
- ✅ `codemagic.yaml` + بيانات المتجر + الخصوصية + ملاحظات المراجعة + أيقونة 1024.
- 🔴 **على المالك:** حساب مراجعة أدمن عامل (القديم `admin@dsd.com` يرجع 401) — التفاصيل في [`review-notes.md`](metadata/review-notes.md).
- ⏳ ثم: تسجيل Bundle ID → App record → بناء Codemagic → لقطات → إرسال. راجع [`CODEMAGIC-SETUP.md`](CODEMAGIC-SETUP.md).
