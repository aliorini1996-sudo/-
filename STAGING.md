# بيئة Staging وسير العمل (Branching)

نموذج فرعين يفصل الإنتاج عن الاختبار:

| الفرع | البيئة | الروابط |
|---|---|---|
| **`master`** | الإنتاج (مستقر) | https://fieldsa.net · https://api.fieldsa.net |
| **`staging`** | الاختبار/التطوير | خادم staging + قاعدة بيانات staging **معزولة** |

> القاعدة الذهبية: لا يصل إلى `master` إلا كود تمّ اختباره على `staging`.

---

## الإعداد لمرة واحدة

### 1) الخادم + قاعدة البيانات (Render)
- **New → Blueprint →** اربط مستودع GitHub واختر **`render.staging.yaml`** (الفرع `staging`).
  - يُنشئ تلقائياً: خدمة `dsd-backend-staging` + قاعدة بيانات `dsd-db-staging` معزولة.
- أو يدوياً: **New → Web Service →** المستودع، الفرع **`staging`**، `rootDir=backend`، نفس أوامر build/start، واربطها بقاعدة بيانات staging جديدة، وأضِف متغيّرات البيئة كما في الملف.
- سيكون رابط الخادم مثل: `https://dsd-backend-staging.onrender.com`.

### 2) الواجهة (Vercel)
- خيار أ (الأسهل): انشر فرع staging كمعاينة:
  ```
  cd web-admin
  npx vercel deploy --yes --scope areen1 --build-env VITE_API_URL=https://dsd-backend-staging.onrender.com
  ```
  (بلا `--prod` = نشر معاينة منفصل عن fieldsa.net.)
- خيار ب: اربط دومين `staging.fieldsa.net` بمشروع/معاينة staging.

---

## سير العمل اليومي

```
# 1) طوّر على staging (أو فرع feature ثم ادمجه فيه)
git checkout staging
# ... عدّل الكود ...
git commit -am "وصف التغيير"
git push origin staging        # → ينشر تلقائياً على بيئة staging

# 2) اختبر على بيئة staging (آمنة — بيانات اختبار معزولة)

# 3) عند الاستقرار: رقّ إلى الإنتاج
git checkout master
git merge staging
git push origin master         # → ينشر تلقائياً على الإنتاج
git checkout staging           # عُد للعمل على staging
```

---

## لماذا هذا أكثر احترافاً (وأماناً)
- **تغييرات قاعدة البيانات تُختبَر أولاً:** `prisma db push` يعمل على قاعدة بيانات staging المعزولة، فلا تمسّ بيانات العملاء الحقيقية إطلاقاً.
- **بريد staging لا يُرسِل فعلياً:** بلا `RESEND_API_KEY` على staging، فلا تصل رسائل اختبار إلى `info@` الحقيقي (تُسجَّل فقط).
- **بيانات دخول تجريبية جاهزة:** `seedDefaults` ينشئ owner/admin/rep على قاعدة staging الفارغة — مثالية للتجربة.
- **الإنتاج يبقى مستقراً:** لا ينكسر fieldsa.net بتجربة غير مكتملة.
