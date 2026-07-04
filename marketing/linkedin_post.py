#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تسويق FieldSales على LinkedIn (صفحة الشركة) — يعمل عبر GitHub Actions (مجاني).
يعيد استخدام نفس البطاقة بهوية FieldSales ونفس بنك المواضيع من post.py،
ويكتب منشور LinkedIn احترافيًا بـClaude، وينشره على صفحة الشركة عبر LinkedIn API.
"""
import sys
import random

import requests

# إعادة استخدام البطاقة + المواضيع + المساعدات من سكربت X
from post import TOPICS, build_card_html, render_card_png, env, ask_gemini

LI = "https://api.linkedin.com"


# ------------------------------ النص (Claude) ------------------------------ #
def ask_claude_linkedin(topic: dict) -> str:
    system = (
        "أنت كاتب محتوى تسويقي محترف على LinkedIn لمنصّة \"Field Sales\" (فيلد سيلز) — "
        "نظام سعودي لإدارة مبيعات مناديب التوزيع الميدانيين، موقعه fieldsa.net.\n"
        "اكتب منشور LinkedIn عربيًا احترافيًا (110–180 كلمة) يبرز الميزة ويحلّ ألمًا حقيقيًا لشركات التوزيع.\n"
        "البنية: سطر أول خطّاف قوي، ثم 2–3 جُمل قيمة بفراغات بينها، ثم دعوة لفعل + الرابط fieldsa.net "
        "وذكر \"تجربة مجانية 10 أيام\"، ثم **سطر أخير فيه 5–8 هاشتاقات مهنية قوية وذات صلة** "
        "(امزج القطاع والموقع والعلامة، واختر الأنسب للموضوع دون تكرارها حرفيًا كل مرة): "
        "#المبيعات #التوزيع #المبيعات_الميدانية #إدارة_المبيعات #الفوترة_الإلكترونية #فواتير_ZATCA "
        "#السعودية #الرياض #جدة #التحول_الرقمي #ريادة_الأعمال #الشركات_الناشئة #FieldSales #فيلد_سيلز.\n"
        "قواعد: ميزات حقيقية فقط بلا اختلاق؛ نبرة مهنية واثقة بلا مبالغة؛ أسطر قصيرة سهلة القراءة.\n"
        "أعِد نصّ المنشور فقط، دون أي مقدّمات أو علامات اقتباس."
    )
    user = f"الميزة: {topic['title']}\nالفائدة: {topic['benefit']}\nألم العميل: {topic['pain']}\nاكتب المنشور الآن."
    return ask_gemini(system, user, max_tokens=900)[:2900]


# ------------------------------ النشر على LinkedIn (الحساب الشخصي) ------------------------------ #
def _person_urn(token: str) -> str:
    """يجلب هوية صاحب الحساب من OpenID userinfo → urn:li:person:{sub} (نشر شخصي، بلا معرّف شركة)."""
    r = requests.get(f"{LI}/v2/userinfo", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if not r.ok:
        sys.exit(f"❌ تعذّر جلب هوية المستخدم {r.status_code}: {r.text[:300]} (تأكّد من صلاحيات openid+profile)")
    sub = (r.json() or {}).get("sub")
    if not sub:
        sys.exit("❌ userinfo لم يُرجع معرّف المستخدم (sub)")
    return f"urn:li:person:{sub}"


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json"}


def _upload_image(token: str, owner: str, image_path: str):
    """يسجّل ويرفع الصورة ويعيد asset URN، أو None عند الفشل (فيُنشر نصًا فقط)."""
    try:
        reg = requests.post(
            f"{LI}/v2/assets?action=registerUpload",
            headers=_headers(token),
            json={"registerUploadRequest": {
                "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
                "owner": owner,
                "serviceRelationships": [{"relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent"}],
            }},
            timeout=60,
        )
        reg.raise_for_status()
        v = reg.json()["value"]
        asset = v["asset"]
        upload_url = v["uploadMechanism"]["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]["uploadUrl"]
        with open(image_path, "rb") as f:
            up = requests.put(upload_url, headers={"Authorization": f"Bearer {token}"}, data=f.read(), timeout=120)
        up.raise_for_status()
        print("⬆️  رُفعت البطاقة إلى LinkedIn")
        return asset
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  رفع الصورة فشل — نشر نصّي: {e}")
        return None


def post_to_linkedin(text: str, image_path: str):
    token = env("LINKEDIN_ACCESS_TOKEN")
    owner = _person_urn(token)
    asset = _upload_image(token, owner, image_path) if image_path else None

    share = {"shareCommentary": {"text": text}, "shareMediaCategory": "IMAGE" if asset else "NONE"}
    if asset:
        share["media"] = [{"status": "READY", "media": asset, "title": {"text": "FieldSales"}}]
    body = {
        "author": owner,
        "lifecycleState": "PUBLISHED",
        "specificContent": {"com.linkedin.ugc.ShareContent": share},
        "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
    }
    r = requests.post(f"{LI}/v2/ugcPosts", headers=_headers(token), json=body, timeout=60)
    if not r.ok:
        sys.exit(f"❌ خطأ LinkedIn API {r.status_code}: {r.text[:600]}")
    print(f"✅ نُشر منشور LinkedIn (id={r.headers.get('x-restli-id', '?')}):\n{text[:200]}…")


def main():
    topic = random.choice(TOPICS)
    print(f"📌 موضوع اليوم: {topic['title']}")
    text = ask_claude_linkedin(topic)
    img = render_card_png(build_card_html(topic, "ar"), "card.jpg")
    post_to_linkedin(text, img)


if __name__ == "__main__":
    main()
