#!/usr/bin/env python3
"""OG画像用フォントを生成する。IPAゴシックを、OGカードで使う文字に絞って軽量化。
現状の記事タイトル+サイト固定文言の漢字 + かな/ラテン/約物の全域を含める
(将来タイトルに新しい漢字が増えたら再実行する)。
"""
import re, pathlib, subprocess

MEDIA = pathlib.Path('/home/user/mirise/apps/media')
SRC = pathlib.Path('/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf')
OUTDIR = MEDIA / 'assets' / 'fonts'
OUTDIR.mkdir(parents=True, exist_ok=True)
OUT = OUTDIR / 'ipagp-og.ttf'

# 記事タイトル
reg = (MEDIA / 'lib' / 'articles.ts').read_text()
titles = re.findall(r"""title:\s*['"]([^'"]+)['"]""", reg)

# OGカードに出る固定文言
fixed = [
    'キョウセイの前に', '矯正治療の意思決定ガイド', '矯正治療の意思決定支援メディア',
    '難症例・外科矯正', '治療法を知る', '意思決定ガイド', 'よくある質問', '用語集',
    '歯科医師 実名監修', '監修', '富田大介 院長', 'ミライズ矯正歯科南青山',
    '顎変形症・外科矯正・再治療の意思決定を、専門医の実名監修で。',
]

chars = set()
for s in titles + fixed:
    chars.update(s)

# 明示Unicode(かな・ラテン・数字・よく使う約物は全域入れて将来のタイトルに強くする)
unicodes = set(ord(c) for c in chars)
def add_range(a, b):
    for cp in range(a, b + 1):
        unicodes.add(cp)
add_range(0x20, 0x7E)      # ASCII可視
add_range(0x3040, 0x30FF)  # ひらがな・カタカナ
# 全角約物・記号
for cp in [0x3000,0x3001,0x3002,0x30FB,0x30FC,0xFF08,0xFF09,0xFF01,0xFF1A,0xFF1B,
           0xFF0C,0xFF0E,0x300C,0x300D,0x300E,0x300F,0x2015,0x2026,0x2192,0xFF5E,
           0x25A0,0x25CB,0x25CF,0x2460,0x3005,0xFF5C,0x2018,0x2019,0x201C,0x201D]:
    unicodes.add(cp)

unis = ','.join(f'U+{cp:04X}' for cp in sorted(unicodes))
subprocess.run([
    'pyftsubset', str(SRC),
    f'--unicodes={unis}',
    '--layout-features=*',
    f'--output-file={OUT}',
], check=True)

# ライセンス同梱(IPAフォントライセンス)
lic_src = pathlib.Path('/usr/share/doc/fonts-ipafont-gothic/copyright')
if lic_src.exists():
    (OUTDIR / 'IPA_Font_License.txt').write_text(lic_src.read_text())

print(f'unique title/fixed chars: {len(chars)}, total glyphs(unicodes): {len(unicodes)}')
print(f'output: {OUT}  size: {OUT.stat().st_size//1024} KB')
