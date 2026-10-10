"""يبني نسخة fieldsales_connector لإصدار Odoo آخر من مصدر Odoo 17 نفسه — بلا فرع ثانٍ يتباعد عنه.

    python3 integrations/odoo/port_addon.py 18.0 /tmp/addons-18

الفروق بين 17 و18 التي تمسّ الوحدة شكلية:
  * رقم الإصدار في البيان يجب أن يبدأ بإصدار Odoo (18.0.x.y.z) وإلا رُفض التثبيت.
  * عرض القائمة صار <list> ونمطه 'list' (كان <tree> و'tree').
والمنطق نفسه مختبرٌ حيّاً على النسختين في .github/workflows/odoo-connector.yml.
"""
import re
import shutil
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent / 'fieldsales_connector'


def port(target: str, out_dir: Path) -> Path:
    if not re.fullmatch(r'\d+\.0', target):
        raise SystemExit('الإصدار بصيغة 18.0')
    dest = out_dir / 'fieldsales_connector'
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(SRC, dest, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'test_mapping.py'))

    manifest = dest / '__manifest__.py'
    text = manifest.read_text(encoding='utf-8')
    text, n = re.subn(r"'version':\s*'17\.0\.", "'version': '%s." % target, text)
    if n != 1:
        raise SystemExit('رقم الإصدار في البيان لم يُعثر عليه')
    manifest.write_text(text, encoding='utf-8')

    if float(target) >= 18:
        for xml in (dest / 'views').glob('*.xml'):
            s = xml.read_text(encoding='utf-8')
            s = re.sub(r'<tree(\s|>)', r'<list\1', s)
            s = s.replace('</tree>', '</list>')
            s = re.sub(r'(<field name="view_mode">)tree', r'\1list', s)
            s = s.replace("'view_mode': 'tree'", "'view_mode': 'list'")
            xml.write_text(s, encoding='utf-8')
    return dest


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    print(port(sys.argv[1], Path(sys.argv[2])))
