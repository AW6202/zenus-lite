# -*- coding: utf-8 -*-
"""把开源词典裁成手机端能用的瘦身版（gzip）。

数据源（都是开放许可）：
  ECDICT      https://github.com/skywind3000/ECDICT        MIT，英汉，含音标/词频/考试标签
  JMdict      https://github.com/scriptin/jmdict-simplified  CC-BY-SA 4.0，日英（EDRDG）

用法：
  python build_dict.py en <ecdict.csv>     -> vendor/dict/en.json.gz
  python build_dict.py ja <jmdict.json>    -> vendor/dict/ja.json.gz

产物结构（越小越好，字段用数组不用对象名）：
  en: { "word": [音标, 释义, 词性, 标签] }
  ja: { "读音或汉字": [汉字, 词性, 英文释义] }
"""
import csv
import gzip
import io
import json
import os
import sys
import zipfile

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor', 'dict')
EN_LIMIT = 120000


def write_gz(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with gzip.open(path, 'wb', compresslevel=9) as f:
        f.write(raw)
    print(f'{os.path.basename(path)}: {len(obj)} 条，原始 {len(raw)/1048576:.1f}MB → 压缩 {os.path.getsize(path)/1048576:.1f}MB')


def clean_phonetic(p):
    """ECDICT 的音标是 'rʌniŋ 这种（撇号当重音、西里尔 ә），换成标准 IPA 写法。"""
    if not p:
        return ''
    t = p.strip().strip('/')
    t = (t.replace("'", 'ˈ').replace('ә', 'ə').replace('ɡ', 'g')
         .replace('^', 'g').replace('є', 'ə').replace('.', '')
         .replace('hw', 'w'))       # ECDICT 的记音瑕疵：^ 是 g，є 是 ə，hw 是旧式 w
    return t


def build_en(src):
    rows = []
    with io.open(src, encoding='utf-8', errors='ignore', newline='') as f:
        for r in csv.DictReader(f):
            w = (r.get('word') or '').strip()
            tr = (r.get('translation') or '').strip()
            if not w or not tr:
                continue
            if ' ' in w and len(w) > 24:      # 长短语不要，查词用不上
                continue
            rows.append(r)

    def sort_key(r):
        frq = int(r['frq']) if (r.get('frq') or '').isdigit() else 10 ** 8
        return (0 if (r.get('tag') or '').strip() else 1, frq)

    rows.sort(key=sort_key)
    picked = rows[:EN_LIMIT]

    # 教材里出现的词必须收进来，不能被"词频截断"漏掉（否则查不到自己的卡片）
    pack_words = []
    pack_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pack.json')
    if os.path.exists(pack_path):
        try:
            pk = json.load(io.open(pack_path, encoding='utf-8'))
            for c in pk.get('courses', []):
                if str(c.get('id', '')).startswith('en'):
                    for card in c.get('cards', []):
                        w = str(card.get('front') or '').strip()
                        if w:
                            pack_words.append(w)
        except Exception:
            pass
    by_word = {r['word'].strip().lower(): r for r in rows}
    have = {r['word'].strip().lower() for r in picked}
    for w in pack_words:
        if w.lower() in have:
            continue
        r = by_word.get(w.lower())
        if r:
            picked.append(r)
            have.add(w.lower())
    rows = picked

    out = {}
    for r in rows:
        w = r['word'].strip()
        if w in out:
            continue
        tr = r['translation'].replace('\\n', '；').replace('\n', '；').strip()[:160]
        item = [clean_phonetic(r.get('phonetic')), tr]
        if r.get('pos'):
            item.append(r['pos'][:20])
        if r.get('tag'):
            item.append(r['tag'].strip()[:40])
        out[w] = item
    write_gz(os.path.join(OUT_DIR, 'en.json.gz'), out)


def build_ja(src):
    if src.endswith('.zip'):
        with zipfile.ZipFile(src) as z:
            name = [n for n in z.namelist() if n.endswith('.json')][0]
            data = json.loads(z.read(name).decode('utf-8'))
    else:
        data = json.load(io.open(src, encoding='utf-8'))

    out = {}
    for w in data.get('words', []):
        kanji = [k['text'] for k in w.get('kanji', []) if k.get('common')]
        kana = [k['text'] for k in w.get('kana', []) if k.get('common')]
        if not kana:
            continue
        senses = w.get('sense', [])[:2]
        gloss = '；'.join(g['text'] for s in senses for g in s.get('gloss', []) if g.get('lang') == 'eng')[:80]
        pos = ','.join(senses[0].get('partOfSpeech', [])[:2])[:20] if senses else ''
        if not gloss:
            continue
        item = [kanji[0] if kanji else '', pos, gloss]
        for k in kana[:2]:
            out.setdefault(k, item)
        for kj in kanji[:2]:
            out.setdefault(kj, item)
    write_gz(os.path.join(OUT_DIR, 'ja.json.gz'), out)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    kind, src = sys.argv[1], sys.argv[2]
    if kind == 'en':
        build_en(src)
    elif kind == 'ja':
        build_ja(src)
    else:
        print('kind 只能是 en / ja')
        sys.exit(2)
