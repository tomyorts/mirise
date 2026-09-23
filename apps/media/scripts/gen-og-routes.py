#!/usr/bin/env python3
"""記事25本+カテゴリ4本の opengraph-image.tsx を生成する。
各ページのタイトルを日本語カードにして、SNS/AI検索のCTRを上げる。
"""
import re, pathlib

MEDIA = pathlib.Path('/home/user/mirise/apps/media')
APP = MEDIA / 'app'
reg = (MEDIA / 'lib' / 'articles.ts').read_text()

# (slug, category, title) を抽出。オブジェクト内の順序は slug -> category -> title
recs = []
for m in re.finditer(
    r"""slug:\s*['"]([^'"]+)['"][\s\S]*?category:\s*['"]([^'"]+)['"][\s\S]*?title:\s*['"]([^'"]+)['"]""",
    reg,
):
    recs.append((m.group(1), m.group(2), m.group(3)))

CAT_LABEL = {
    'jaw-surgery': '難症例・外科矯正',
    'treatment': '治療法を知る',
    'guide': '意思決定ガイド',
    'faq': 'よくある質問',
}

def esc(s: str) -> str:
    return s.replace('\\', '\\\\').replace("'", "\\'")

TPL = """import {{ ogImage, OG_SIZE, OG_CONTENT_TYPE }} from '@/lib/og';

// 自動生成(scratchpad/gen_og_routes.py)。タイトル変更時は再生成する。
export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = '{alt}';

export default function Image() {{
  return ogImage({{ title: '{title}', kicker: '{kicker}' }});
}}
"""

written = 0
seen_dirs = set()
for slug, cat, title in recs:
    d = APP / cat / slug
    if not d.exists():
        print('SKIP (no dir):', cat, slug)
        continue
    (d / 'opengraph-image.tsx').write_text(
        TPL.format(alt=esc(title), title=esc(title), kicker=CAT_LABEL.get(cat, ''))
    )
    written += 1
    seen_dirs.add((cat, slug))

# カテゴリ index 用
CAT_TITLE = {
    'jaw-surgery': '難症例・外科矯正を、決める前に理解する',
    'treatment': '矯正の治療法を、正しく理解する',
    'guide': '矯正治療の意思決定ガイド',
    'faq': '矯正のよくある誤解と不安に答える',
}
for cat, label in CAT_LABEL.items():
    d = APP / cat
    if not d.exists():
        continue
    (d / 'opengraph-image.tsx').write_text(
        TPL.format(alt=esc(label), title=esc(CAT_TITLE[cat]), kicker=esc(label))
    )
    written += 1

print(f'articles parsed: {len(recs)}, og routes written: {written}')
