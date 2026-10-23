import sys, re, json, html
src = open(sys.argv[1]).read()
def title(s): return dict((k, v) for k, v in (p.strip().split(' ', 1) for p in s.split(';') if p.strip()))
paras = []
for pm in re.finditer(r"<p class='ocr_par'[^>]*>(.*?)</p>", src, re.S):
    lines = []
    for lm in re.finditer(r"<span class='ocr_(?:line|caption|header|textfloat)' id='[^']*' title=\"([^\"]*)\">(.*?)</span>\s*(?=<span class='ocr_(?:line|caption|header|textfloat)'|$)", pm.group(1), re.S):
        t = title(lm.group(1)); x0, y0, x1, y1 = map(int, t['bbox'].split())
        words = re.findall(r"<span class='ocrx_word'[^>]*title='bbox (\d+) (\d+) (\d+) (\d+); x_wconf (\d+)'[^>]*>(.*?)</span>", lm.group(2), re.S)
        words = [(w[4], w[5], tuple(map(int, w[:4]))) for w in words]
        text = ' '.join(html.unescape(re.sub('<[^>]+>', '', w[1])) for w in words)
        conf = sum(int(w[0]) for w in words) / max(1, len(words))
        slope, off = map(float, t.get('baseline', '0 0').split())
        by = y1 + off
        wl = [{'text': html.unescape(re.sub('<[^>]+>', '', w[1])), 'confidence': int(w[0]), 'bbox': {'x0': w[2][0], 'y0': w[2][1], 'x1': w[2][2], 'y1': w[2][3]}} for w in words]
        lines.append({'text': text + '\n', 'confidence': conf, 'words': wl, 'bbox': {'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1},
                      'baseline': {'x0': x0, 'y0': by, 'x1': x1, 'y1': by + slope * (x1 - x0), 'has_baseline': True},
                      'rowAttributes': {'row_height': float(t.get('x_size', y1 - y0)), 'ascenders': float(t.get('x_ascenders', 0)), 'descenders': float(t.get('x_descenders', 0))}})
    if lines: paras.append({'lines': lines})
print(json.dumps({'paragraphs': paras, 'text': ''.join(l['text'] for p in paras for l in p['lines'])}))
