# -*- coding: utf-8 -*-
"""把卡片音标统一成美式（来源：CMUdict，经 build_dict_en.py 转成 IPA）。

原来卡片是我手写的英式音标，和词典的美式混在一起，校验时全是"英美元音差异"的噪声。
统一之后：音标必须与词典逐字一致，不一致就是错，能直接判 FAIL。

用法: python set_phonetics.py [pack.json]
写入字段：hint（/.../）、phonSrc（cmudict / 原估值）
"""
import gzip
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main(path):
    d = json.loads(gzip.open(os.path.join(HERE, 'vendor', 'dict', 'en.json.gz'), 'rb').read().decode('utf-8'))
    pack = json.load(io.open(path, encoding='utf-8'))
    stats = {'replaced': 0, 'same': 0, 'missing': 0}
    examples = []
    for c in pack.get('courses', []):
        if not str(c.get('id', '')).startswith('en'):
            continue
        for card in c.get('cards', []):
            word = str(card.get('front') or '').strip()
            if not word:
                continue
            entry = d.get(word) or d.get(word.lower())
            phon = (entry[0] if entry else '') or ''
            if not phon:
                card['phonSrc'] = '原估值'
                stats['missing'] += 1
                continue
            new = '/' + phon + '/'
            old = str(card.get('hint') or '')
            if old == new:
                stats['same'] += 1
            else:
                stats['replaced'] += 1
                if len(examples) < 10:
                    examples.append('%s: %s -> %s' % (word, old or '(空)', new))
            card['hint'] = new
            card['phonSrc'] = 'cmudict'
    io.open(path, 'w', encoding='utf-8').write(json.dumps(pack, ensure_ascii=False, indent=1))
    print('改用词典音标: %d 张' % stats['replaced'])
    print('本来一致    : %d 张' % stats['same'])
    print('词典没有    : %d 张（保留原值，标 原估值）' % stats['missing'])
    for e in examples:
        print('  ', e)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'pack.json'))
