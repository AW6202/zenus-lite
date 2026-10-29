# -*- coding: utf-8 -*-
"""把卡片里"我估的 level"换成有出处的两个字段：

  examTags —— 词典里的原始考纲标签（zk/中考、gk/高考、cet4、cet6、ky/考研、toefl、ielts、gre）
              这是 ECDICT 的真实数据，照抄，不折算。
  level    —— 折算出的 CEFR 档位（规则见 TAG_LEVEL），只作粗分参考。

⚠️ 注意：考纲标签 ≠ CEFR 难度。salmon（三文鱼）是六级/考研词，按 tag 折算会变成 C1，
   但它在 CEFR 里是生活词（A2/B1）。所以 UI 里要说"六级词"，不要直接说"C1"。
   levelSrc 会写明这条是 tag 折算还是词频推导，没有出处的一律标 "原估值"。

规则（写死在表里，可复现、可争辩）：
  中考 zk      -> A2
  高考 gk      -> B1
  四级 cet4    -> B2
  六级 cet6    -> C1
  考研 ky      -> C1
  托福/雅思    -> B2
  GRE gre      -> C1
  一个词命中多个标签时取最高档。

字典里查不到考试标签时，退回词频：frq<=3000 -> B1，<=8000 -> B2，<=20000 -> C1。
两样都没有（多词短语、生僻词）→ 保留原值，并把 levelSrc 标成 "原估值"，让人一眼看出这条没出处。

用法: python set_levels.py [pack.json]
输出: 覆盖写入同一文件，同时在 stdout 打印统计
"""
import gzip
import io
import json
import os
import sys

TAG_LEVEL = {
    'zk': 'A2',
    'gk': 'B1',
    'cet4': 'B2',
    'cet6': 'C1',
    'ky': 'C1',
    'toefl': 'B2',
    'ielts': 'B2',
    'gre': 'C1',
}
ORDER = {'A1': 1, 'A2': 2, 'B1': 3, 'B2': 4, 'C1': 5, 'C2': 6}

HERE = os.path.dirname(os.path.abspath(__file__))


def load_dict():
    path = os.path.join(HERE, 'vendor', 'dict', 'en.json.gz')
    if not os.path.exists(path):
        print('缺 vendor/dict/en.json.gz，先跑 build_dict.py en')
        sys.exit(2)
    return json.loads(gzip.open(path, 'rb').read().decode('utf-8'))


def by_freq(frq):
    if not frq:
        return ''
    if frq <= 3000:
        return 'B1'
    if frq <= 8000:
        return 'B2'
    if frq <= 20000:
        return 'C1'
    return ''


def derive(entry):
    """返回 (level, src)。entry = [音标, 释义, 词性, 标签, 词频]

    词频优先：词频接近"这个词在实际语料里多常见"，比考纲归属更接近 CEFR 的直觉
    （salmon 是六级词但 word rank 3400 左右 → B1，而不是 C1）。
    没有词频才退回考纲标签。
    """
    frq = entry[4] if len(entry) > 4 else 0
    lv = by_freq(frq)
    if lv:
        return lv, 'ecdict:frq(%d)' % frq
    tags = (entry[3] or '').split()
    hits = [TAG_LEVEL[t] for t in tags if t in TAG_LEVEL]
    if hits:
        top = max(hits, key=lambda x: ORDER[x])
        return top, 'ecdict:tag(' + ','.join(t for t in tags if t in TAG_LEVEL) + ')'
    return '', ''


def main(path):
    pack = json.load(io.open(path, encoding='utf-8'))
    d = load_dict()
    stats = {'tag': 0, 'frq': 0, 'keep': 0, 'changed': 0}
    changed_examples = []
    for c in pack.get('courses', []):
        cid = str(c.get('id', ''))
        if not cid.startswith('en'):
            continue                      # 日语/数学不套这套规则
        for card in c.get('cards', []):
            word = str(card.get('front') or '').strip()
            if not word:
                continue
            entry = d.get(word) or d.get(word.lower())
            old = card.get('level') or ''
            if not entry:
                card['levelSrc'] = '原估值'
                stats['keep'] += 1
                continue
            lv, src = derive(entry)
            if not lv:
                card['levelSrc'] = '原估值'
                stats['keep'] += 1
                continue
            if lv != old:
                stats['changed'] += 1
                if len(changed_examples) < 12:
                    changed_examples.append('%s: %s -> %s' % (word, old or '(空)', lv))
            card['level'] = lv
            card['levelSrc'] = src
            tags = [t for t in (entry[3] or '').split() if t in TAG_LEVEL]
            if tags:
                card['examTags'] = tags
            else:
                card.pop('examTags', None)
            stats['tag' if src.startswith('ecdict:tag') else 'frq'] += 1
    io.open(path, 'w', encoding='utf-8').write(json.dumps(pack, ensure_ascii=False, indent=1))
    print('有出处（考试标签）: %d 张' % stats['tag'])
    print('有出处（词频推导）: %d 张' % stats['frq'])
    print('无出处（保留原值）: %d 张' % stats['keep'])
    print('级别发生变化    : %d 张' % stats['changed'])
    for e in changed_examples:
        print('  ', e)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'pack.json'))
