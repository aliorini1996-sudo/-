#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تسويق FieldSales على فيسبوك (صفحة الشركة) — يعمل عبر GitHub Actions (مجاني).
يعيد استخدام نفس البطاقة بهوية FieldSales ونفس بنك المواضيع من post.py،
ويكتب منشورًا بـClaude، وينشره على صفحة فيسبوك عبر Graph API (صورة + نص، مع fallback نصّي).
"""
import sys
import random

import requests

# إعادة استخدام البطاقة + المواضيع + المساعدات من سكربت X
from post import TOPICS, build_card_html, render_card_png, env

GRAPH = "https://graph.facebook.com/v21.0"


# ------------------------------ النص (Claude) ------------------------------ #
def ask_claude_facebook(topic: dict) -> str:
    system = (
        "أنت كاتب محتوى تسويقي محترف على فيسبوك لمنصّة \"Field Sales\" (فيلد سيلز) — "
        "نظام سعودي لإدارة مبيعات مناديب التوزيع الميدانيين، موقعه fieldsa.net.\n"
        "اكتب منشور فيسبوك عربيًا جذّابًا (70–130 كلمة) يبرز الميزة ويحلّ ألمًا حقيقيًا لشركات التوزيع.\n"
        "البنية: سطر أول خطّاف يلفت الانتباه، ثم 2–3 جُمل قيمة بأسطر قصيرة وفراغات، "
        "ثم دعوة لفعل واضحة + الرابط fieldsa.net وذكر \"تجربة مجانية 10 أيام\"، ثم 2–4 هاشتاقات "
        "(أمثلة: #المبيعات #التوزيع #فواتير_ZATCA #السعودية #ريادة_الأعمال).\n"
        "قواعد: ميزات حقيقية فقط بلا اختلاق؛ نبرة ودّية مهنية واثقة بلا مبالغة؛ يجوز استخدام إيموجي باعتدال.\n"
        "أعِد نصّ المنشور فقط، دون أي مقدّمات أو علامات اقتباس."
    )
    user = f"الميزة: {topic['title']}\nالفائدة: {topic['benefit']}\nألم العميل: {topic['pain']}\nاكتب المنشور الآن."
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": "claude-haiku-4-5", "max_tokens": 900, "system": system, "messages": [{"role": "user", "content": user}]},
        timeout=60,
    )
    if not r.ok:
        sys.exit(f"❌ خطأ Claude API {r.status_code}: {r.text[:600]}")
    return r.json()["content"][0]["text"].strip().strip('"').strip()


# ------------------------------ النشر على فيسبوك ------------------------------ #
def post_to_facebook(text: str, image_path: str):
    page_id = env("FB_PAGE_ID").strip()
    token = env("FB_PAGE_ACCESS_TOKEN")

    # محاولة نشر صورة + نص (caption)
    if image_path:
        try:
            with open(image_path, "rb") as f:
                r = requests.post(
                    f"{GRAPH}/{page_id}/photos",
                    data={"caption": text, "access_token": token},
                    files={"source": f},
                    timeout=120,
                )
            if r.ok:
                print(f"✅ نُشرت الصورة + النص على فيسبوك (id={r.json().get('post_id') or r.json().get('id')})")
                return
            print(f"⚠️  نشر الصورة فشل، محاولة نص فقط: {r.status_code} {r.text[:300]}")
        except Exception as e:  # noqa: BLE001
            print(f"⚠️  خطأ رفع الصورة — نشر نصّي: {e}")

    # fallback: نشر نصّي على المنشورات
    r = requests.post(f"{GRAPH}/{page_id}/feed", data={"message": text, "access_token": token}, timeout=60)
    if not r.ok:
        sys.exit(f"❌ خطأ فيسبوك Graph API {r.status_code}: {r.text[:600]}")
    print(f"✅ نُشر منشور نصّي على فيسبوك (id={r.json().get('id')})")


def main():
    topic = random.choice(TOPICS)
    print(f"📌 موضوع اليوم: {topic['title']}")
    text = ask_claude_facebook(topic)
    img = render_card_png(build_card_html(topic), "card.jpg")
    post_to_facebook(text, img)


if __name__ == "__main__":
    main()
