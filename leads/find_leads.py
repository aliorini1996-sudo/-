#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
صيد العملاء المحتملين لـFieldSales — يبحث يوميًا عن شركات التوزيع/الجملة في السعودية
عبر Google Places (New)، يؤهّلها بـClaude، ويحفظ الجدد فقط في Google Sheet خاص.
بيانات أعمال عامّة فقط — قائمة لمراجعة فريق المبيعات (لا تواصل آلي).

وضع الاختبار: إن لم تُضبط أسرار Google Sheet، يطبع عدد ونماذج النتائج فقط (لفحص التغطية).
"""
import os
import sys
import json
import time
import datetime

import requests

CITIES = [
    "الرياض", "جدة", "الدمام", "مكة المكرمة", "المدينة المنورة", "الخبر",
    "الطائف", "تبوك", "بريدة", "خميس مشيط", "حائل", "الأحساء", "نجران",
    "الجبيل", "ينبع", "أبها",
]

QUERIES = [
    "شركة توزيع مواد غذائية",
    "تجارة جملة",
    "موزع مواد استهلاكية",
    "مستودع توزيع",
    "شركة توزيع مشروبات",
    "موزع مستلزمات",
    "تاجر جملة",
    "شركة توريدات",
    "موزع منتجات تنظيف",
    "توزيع أدوية ومستلزمات طبية",
]

HEADERS = ["place_id", "الاسم", "الهاتف", "الموقع الإلكتروني", "العنوان",
           "التقييم", "عدد المراجعات", "النوع", "المدينة", "رابط الخريطة",
           "الملاءمة (1-10)", "ملاحظة", "تاريخ الإضافة"]


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"❌ سرّ مفقود: {name} (أضِفه في GitHub Secrets)")
    return v


# --------------------------- Google Places (New) --------------------------- #
def search_places(query: str, api_key: str) -> list:
    r = requests.post(
        "https://places.googleapis.com/v1/places:searchText",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": (
                "places.id,places.displayName,places.formattedAddress,"
                "places.internationalPhoneNumber,places.nationalPhoneNumber,"
                "places.websiteUri,places.rating,places.userRatingCount,"
                "places.googleMapsUri,places.primaryTypeDisplayName"
            ),
        },
        json={"textQuery": query, "regionCode": "SA", "languageCode": "ar", "maxResultCount": 20},
        timeout=60,
    )
    if not r.ok:
        print(f"⚠️  بحث فشل ({query}): {r.status_code} {r.text[:160]}")
        return []
    return r.json().get("places", [])


def open_sheet():
    import gspread
    from google.oauth2.service_account import Credentials
    info = json.loads(env("GOOGLE_SERVICE_ACCOUNT_JSON"))
    creds = Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return gspread.authorize(creds).open_by_key(env("GOOGLE_SHEET_ID")).sheet1


def qualify(leads: list) -> dict:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key or not leads:
        return {}
    items = [{"i": i, "name": l["name"], "type": l["type"], "city": l["city"]} for i, l in enumerate(leads)]
    system = (
        "أنت محلّل مبيعات لمنصّة FieldSales (نظام سعودي لإدارة مبيعات مناديب التوزيع الميدانيين). "
        "قيّم ملاءمة كل نشاط: شركات التوزيع/الجملة التي لديها مناديب ميدانيون = الأعلى؛ التجزئة الصغيرة/غير المتعلق = الأقل. "
        "أعِد JSON فقط: مصفوفة {\"i\":رقم, \"score\":1-10, \"note\":\"سبب موجز جدًا بالعربية\"}."
    )
    user = "النشاطات:\n" + json.dumps(items, ensure_ascii=False)
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": "claude-haiku-4-5", "max_tokens": 3000, "system": system,
                  "messages": [{"role": "user", "content": user}]},
            timeout=90,
        )
        if not r.ok:
            return {}
        import re
        m = re.search(r"\[.*\]", r.json()["content"][0]["text"], re.S)
        arr = json.loads(m.group(0)) if m else []
        return {int(x["i"]): (x.get("score", ""), x.get("note", "")) for x in arr}
    except Exception as e:  # noqa: BLE001
        print("⚠️  تأهيل Claude فشل:", e)
        return {}


def main():
    api_key = env("GOOGLE_MAPS_API_KEY")
    dry = not (os.environ.get("GOOGLE_SHEET_ID", "").strip() and os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip())

    if dry:
        print("🧪 وضع الاختبار: لا أسرار Google Sheet بعد — سأطبع التغطية فقط دون الكتابة.")
        sh, existing_ids = None, set()
    else:
        sh = open_sheet()
        rows_all = sh.get_all_values()
        if not rows_all:
            sh.append_row(HEADERS); existing_ids = set()
        else:
            existing_ids = {row[0] for row in rows_all[1:] if row and row[0]}

    query = QUERIES[datetime.date.today().toordinal() % len(QUERIES)]
    print(f"🔎 بحث اليوم: «{query}» في {len(CITIES)} مدينة (Google Places)")

    found = {}
    for city in CITIES:
        for p in search_places(f"{query} في {city}", api_key):
            pid = p.get("id")
            if not pid or pid in existing_ids or pid in found:
                continue
            found[pid] = {
                "id": pid,
                "name": (p.get("displayName") or {}).get("text", ""),
                "phone": p.get("internationalPhoneNumber") or p.get("nationalPhoneNumber") or "",
                "website": p.get("websiteUri", ""),
                "address": p.get("formattedAddress", ""),
                "rating": p.get("rating", ""),
                "reviews": p.get("userRatingCount", ""),
                "type": (p.get("primaryTypeDisplayName") or {}).get("text", ""),
                "city": city,
                "maps": p.get("googleMapsUri", ""),
            }
        time.sleep(0.2)

    leads = list(found.values())
    with_phone = sum(1 for l in leads if l["phone"])
    print(f"🆕 نتائج: {len(leads)} | منها بهاتف: {with_phone}")

    if dry:
        for l in leads[:12]:
            print(f"  - {l['name']} | {l['phone'] or 'بلا هاتف'} | {l['city']}")
        print("✅ انتهى الاختبار. إن أعجبتك التغطية، أكمل إعداد Google Sheet لتُحفظ تلقائيًا.")
        return

    if not leads:
        print("لا عملاء محتملين جدد اليوم.")
        return

    scores = qualify(leads)
    today = datetime.date.today().isoformat()
    rows = []
    for i, l in enumerate(leads):
        score, note = scores.get(i, ("", ""))
        rows.append([l["id"], l["name"], l["phone"], l["website"], l["address"], l["rating"],
                     l["reviews"], l["type"], l["city"], l["maps"], score, note, today])
    rows.sort(key=lambda r: r[10] if isinstance(r[10], (int, float)) else 0, reverse=True)
    sh.append_rows(rows, value_input_option="RAW")
    print(f"✅ أُضيف {len(rows)} عميلًا محتملاً إلى Google Sheet (الأعلى ملاءمة أولًا).")


if __name__ == "__main__":
    main()
