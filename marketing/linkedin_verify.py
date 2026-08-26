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

    # ٢) هل يرى الرمز صفحات يديرها؟ يتطلّب صلاحية إدارة المؤسسة
    head("٢) الوصول الإداري لصفحة الشركة")
    r = requests.get(
        f"{LI}/v2/organizationAcls",
        params={"q": "roleAssignee", "role": "ADMINISTRATOR", "state": "APPROVED"},
        headers={"Authorization": f"Bearer {TOKEN}", "X-Restli-Protocol-Version": "2.0.0"},
        timeout=30,
    )
    if r.ok:
        els = (r.json() or {}).get("elements", [])
        orgs = [e.get("organization", "") for e in els]
        verdict["org_admin"] = bool(orgs)
        print(f"✅ صفحات يديرها الرمز: {orgs or 'لا شيء'}")
        if ORG and not any(ORG in o for o in orgs):
            print(f"⚠️  LINKEDIN_ORG_ID={ORG} ليس ضمن ما يراه الرمز")
    else:
        print(f"❌ لا وصول إداري ({r.status_code}): {r.text[:200]}")
        print("   ⇐ الرمز بلا صلاحية إدارة المؤسسة (rw_organization_admin).")

    # ٣) الاختبار الحاسم: هل يستطيع الكتابة باسم الصفحة؟
    #    حجز موضع رفع — **لا يُنشئ منشوراً** ولا يظهر لأحد.
    head("٣) صلاحية النشر باسم الصفحة (بلا نشر)")
    if not ORG:
        print("⏭️  LINKEDIN_ORG_ID غير مضبوط — النشر سيقع باسم الحساب الشخصي")
    else:
        owner = f"urn:li:organization:{ORG.rsplit(':', 1)[-1]}"
        r = requests.post(
            f"{LI}/v2/assets?action=registerUpload",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "X-Restli-Protocol-Version": "2.0.0",
                "Content-Type": "application/json",
            },
            json={"registerUploadRequest": {
                "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
                "owner": owner,
                "serviceRelationships": [
                    {"relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent"}
                ],
            }},
            timeout=60,
        )
        if r.ok:
            verdict["can_post_as_org"] = True
            print(f"✅ الرمز يملك w_organization_social على {owner}")
            print("   (حُجز موضع رفع ولم يُنشر شيء — ينتهي وحده)")
        else:
            print(f"❌ مرفوض ({r.status_code}): {r.text[:300]}")
            print("   ⇐ الرمز لا يحمل w_organization_social لهذه الصفحة.")

    return _report(verdict)


def _report(v: dict) -> int:
    head("الخلاصة")
    if v["can_post_as_org"]:
        print("🟢 جاهز: فعّل وورك فلو LinkedIn وسينشر باسم صفحة الشركة.")
        return 0
    if v["alive"]:
        print("🟡 الرمز حيّ لكنه **لا يستطيع النشر باسم الصفحة**.")
        print("   السبب الغالب: صلاحيات الرمز تُجمَّد لحظة إصداره، فرمزٌ صدر قبل")
        print("   اعتماد Community Management API لا يحمل w_organization_social.")
        print("   العلاج: إعادة تفويض OAuth بالصلاحيات الجديدة وتحديث السرّ.")
        return 2
    print("🔴 الرمز غير صالح — يلزم رمز جديد.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
