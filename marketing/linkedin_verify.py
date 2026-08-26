#!/usr/bin/env python3
"""
فحص جاهزية LinkedIn للنشر **باسم صفحة الشركة** — بلا نشر أي شيء.

لماذا فحصٌ منفصل: تشغيل خطّ النشر للتأكّد يعني منشوراً عاماً على صفحة الشركة،
وهذا ثمنٌ لا يُدفع مقابل سؤال. والأهمّ أن **صلاحيات رمز LinkedIn تُجمَّد لحظة
إصداره**: رمزٌ صدر قبل اعتماد Community Management API لا يحمل
`w_organization_social` مهما ضُبط `LINKEDIN_ORG_ID` بعده. فالفحص يجيب سؤالين
مختلفين: هل الرمز حيّ؟ وهل يملك حقّ الكتابة باسم الصفحة؟

الفحص الثالث (`registerUpload`) يحجز موضع رفع لصورة ولا يُنشئ منشوراً؛ الموضع
غير المستعمل ينتهي وحده. وهو الاختبار الوحيد الذي يمسّ صلاحية الكتابة نفسها
بدل الاستدلال عليها.
"""

import os
import sys
import requests

LI = "https://api.linkedin.com"
TOKEN = (os.environ.get("LINKEDIN_ACCESS_TOKEN") or "").strip()
ORG = (os.environ.get("LINKEDIN_ORG_ID") or "").strip()


def head(t: str) -> None:
    print(f"\n{'=' * 60}\n{t}\n{'=' * 60}")


def main() -> int:
    if not TOKEN:
        print("❌ LINKEDIN_ACCESS_TOKEN غير مضبوط")
        return 1

    verdict = {"alive": False, "org_admin": False, "can_post_as_org": False}

    # ١) هل الرمز حيّ أصلاً؟ رموز LinkedIn تنتهي بعد ٦٠ يوماً من إصدارها
    head("١) صلاحية الرمز")
    r = requests.get(f"{LI}/v2/userinfo", headers={"Authorization": f"Bearer {TOKEN}"}, timeout=30)
    if r.ok:
        info = r.json() or {}
        verdict["alive"] = True
        print(f"✅ الرمز حيّ — صاحبه: {info.get('name', '?')} ({info.get('sub', '')[:12]}…)")
    else:
        print(f"❌ الرمز مرفوض ({r.status_code}): {r.text[:200]}")
        print("   ⇐ منتهٍ أو مُبطَل. يلزم إعادة تفويض للحصول على رمز جديد.")
        return _report(verdict)

    # ٢) شكل المعرّف نفسه — قبل اتّهام الصلاحيات
    head("٢) معرّف الصفحة")
    org_id = ORG.rsplit(":", 1)[-1].strip() if ORG else ""
    if not org_id:
        print("⏭️  LINKEDIN_ORG_ID غير مضبوط")
    elif not org_id.isdigit():
        print(f"❌ المعرّف ليس رقماً خالصاً: {org_id!r} — النشر سيُرفض على حقل author")
    else:
        print(f"✅ المعرّف رقم صالح (…{org_id[-4:]}) ⇒ urn:li:organization:…{org_id[-4:]}")

    # ٣) الوصول الإداري — على **الواجهة المُصدَّرة** لا القديمة.
    #    `/v2/organizationAcls` قديمة وقد تردّ 403 لسبب إصداريّ لا صلاحيّ،
    #    فاتّهام الصلاحيات بناءً عليها وحدها تشخيصٌ خاطئ. نجرّب الاثنتين.
    head("٣) الوصول الإداري لصفحة الشركة")
    for label, url, hdrs in [
        ("الواجهة المُصدَّرة /rest", f"{LI}/rest/organizationAcls",
         {"Authorization": f"Bearer {TOKEN}", "LinkedIn-Version": "202405", "X-Restli-Protocol-Version": "2.0.0"}),
        ("الواجهة القديمة /v2", f"{LI}/v2/organizationAcls",
         {"Authorization": f"Bearer {TOKEN}", "X-Restli-Protocol-Version": "2.0.0"}),
    ]:
        r = requests.get(url, params={"q": "roleAssignee", "role": "ADMINISTRATOR", "state": "APPROVED"},
                         headers=hdrs, timeout=30)
        if r.ok:
            orgs = [e.get("organization", "") for e in (r.json() or {}).get("elements", [])]
            verdict["org_admin"] = verdict["org_admin"] or bool(orgs)
            print(f"✅ {label}: {orgs or 'لا صفحات'}")
        else:
            print(f"❌ {label}: {r.status_code} {r.text[:150]}")

    # ٤) الاختبار الحاسم الحقيقيّ: هل يُقبل **حقل author** نفسه؟
    #
    #    `registerUpload` ليس برهاناً — نجح بينما رُفض النشر بـ403 على `/author`.
    #    درسٌ مدفوع الثمن: اختبر الحقل الذي يفشل، لا حقلاً مجاوراً له.
    #    نرسل منشوراً **ناقصاً عمداً** (بلا نصّ): لو كان author مرفوضاً ردّت
    #    لينكدإن 403 عليه، ولو كان مقبولاً ردّت 422/400 على النصّ الناقص —
    #    وفي الحالتين **لا يُنشر شيء**.
    head("٤) قبول حقل author (بلا نشر)")
    if not org_id:
        print("⏭️  بلا معرّف")
    else:
        r = requests.post(
            f"{LI}/v2/ugcPosts",
            headers={"Authorization": f"Bearer {TOKEN}", "X-Restli-Protocol-Version": "2.0.0",
                     "Content-Type": "application/json"},
            json={"author": f"urn:li:organization:{org_id}", "lifecycleState": "PUBLISHED"},
            timeout=30,
        )
        body = r.text[:300]
        if r.status_code == 403 and "author" in body:
            print(f"❌ حقل author مرفوض (403) — الرمز لا يملك النشر باسم هذه الصفحة")
            print(f"   {body[:200]}")
        elif r.status_code in (400, 422):
            verdict["can_post_as_org"] = True
            print("✅ author مقبول — الرفض جاء على الحقول الناقصة عمداً، أي أن الهوية سليمة")
        elif r.ok:
            # لا ينبغي أن يحدث ببنية ناقصة؛ نُبلّغ بصوت عالٍ
            print(f"⚠️ ردّت لينكدإن بنجاح على بنية ناقصة — راجع الصفحة يدوياً: {body[:150]}")
        else:
            print(f"❓ ردّ غير متوقّع {r.status_code}: {body[:200]}")

    return _report(verdict)


def _report(v: dict) -> int:
    head("الخلاصة")
    if v["can_post_as_org"]:
        print("🟢 جاهز: فعّل وورك فلو LinkedIn وسينشر باسم صفحة الشركة.")
        return 0
    if v["alive"]:
        print("🟡 الرمز حيّ لكنه **لا يستطيع النشر باسم الصفحة**.")
        print("   صلاحيات رمز لينكدإن تُجمَّد لحظة إصداره: رمزٌ صدر قبل اعتماد")
        print("   Community Management API لا يحمل w_organization_social مهما ضُبط")
        print("   LINKEDIN_ORG_ID بعده.")
        print("   العلاج: إعادة تفويض OAuth بالصلاحيات الجديدة وتحديث السرّ")
        print("   (الخطوات في marketing/LINKEDIN-SETUP.md).")
        return 2
    print("🔴 الرمز غير صالح — يلزم رمز جديد.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
