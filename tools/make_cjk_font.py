"""Builds assets/cjk.ttf (+ cjk-map.json) from WenQuanYi Zen Hei for Chinese text support.
Keeps Latin, common symbols, CJK punctuation, kana, bopomofo and all CJK Unified Ideographs
(simplified + traditional). Metrics are normalised so screen and PDF line up exactly."""
import json, subprocess, sys, os
from fontTools.ttLib import TTCollection, TTFont

SRC = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
tmp = '/tmp/claude-0/f/wqy0.ttf'
TTCollection(SRC).fonts[0].save(tmp)
uni = ("U+0020-007E,U+00A0-024F,U+02C6-02DD,U+0300-036F,U+0391-03C9,U+0401-0451,U+2000-206F,U+20AC,"
       "U+2100-215F,U+2160-217F,U+2190-21FF,U+2200-22FF,U+2460-24FF,U+2500-257F,U+25A0-25FF,U+2600-26FF,"
       "U+3000-303F,U+3040-30FF,U+3100-312F,U+3200-32FF,U+4E00-9FFF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF")
out = os.path.join(OUT, 'cjk.ttf')
subprocess.check_call(['pyftsubset', tmp, '--unicodes=' + uni, '--no-hinting', "--layout-features=",
    '--drop-tables+=BDF,FFTM,GDEF,GPOS,GSUB,vhea,vmtx,gasp', '--name-IDs=*', '--output-file=' + out])
f = TTFont(out)
asc, desc = 986, 304
f['hhea'].ascent, f['hhea'].descent, f['hhea'].lineGap = asc, -desc, 0
o = f['OS/2']
o.sTypoAscender, o.sTypoDescender, o.sTypoLineGap = asc, -desc, 0
o.usWinAscent, o.usWinDescent = asc, desc
o.fsSelection |= 1 << 7  # USE_TYPO_METRICS
f['post'].formatType = 3.0
f.save(out)
f = TTFont(out)
cmap = sorted(f.getBestCmap().items())
order = {n: i for i, n in enumerate(f.getGlyphOrder())}
ranges = []
for cp, name in cmap:
    g = order[name]
    if ranges and ranges[-1][0] + ranges[-1][2] == cp and ranges[-1][1] + ranges[-1][2] == g:
        ranges[-1][2] += 1
    else:
        ranges.append([cp, g, 1])
json.dump({'upm': f['head'].unitsPerEm, 'asc': asc, 'desc': desc, 'ranges': ranges}, open(os.path.join(OUT, 'cjk-map.json'), 'w'), separators=(',', ':'))
print(len(cmap), 'chars', len(ranges), 'ranges', os.path.getsize(out), 'bytes')
