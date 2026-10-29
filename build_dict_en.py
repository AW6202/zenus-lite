# -*- coding: utf-8 -*-
"""英汉词典三元合并：ECDICT（词频/考纲/中文兜底）+ CMUdict（音标）+ FreeDict（中文释义）

为什么要换源：
  · 音标：ECDICT 的记音体系不权威（/hwisk/、缺 h），CMUdict 是确定性 ARPAbet → 可机器验证
  · 释义：FreeDict eng-zho 是独立维护的英汉词典（CC 许可、2.67 万词），可交叉核对 ECDICT

用法:
  python build_dict_en.py <ecdict.csv> <cmudict.dict> <eng-zho.tei> [pack.json]
输出:
  vendor/dict/en.json.gz   { word: [音标, 中文释义, 词性, 考纲标签, 词频, 中文来源] }
"""
import csv
import gzip
import io
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

try:
    import zhconv
except ImportError:
    zhconv = None

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'vendor', 'dict', 'en.json.gz')
EN_LIMIT = 120000

# ARPAbet -> IPA（美式）
ARP = {
    'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ', 'AY': 'aɪ',
    'B': 'b', 'CH': 'tʃ', 'D': 'd', 'DH': 'ð', 'EH': 'e', 'ER': 'ɝ', 'EY': 'eɪ',
    'F': 'f', 'G': 'ɡ', 'HH': 'h', 'IH': 'ɪ', 'IY': 'i', 'JH': 'dʒ', 'K': 'k',
    'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ŋ', 'OW': 'oʊ', 'OY': 'ɔɪ', 'P': 'p',
    'R': 'ɹ', 'S': 's', 'SH': 'ʃ', 'T': 't', 'TH': 'θ', 'UH': 'ʊ', 'UW': 'u',
    'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ',
}
VOWEL = {'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY',
         'OW', 'OY', 'UH', 'UW'}


def arp_to_ipa(phones):
    """ARPAbet → IPA。重音标记放在该音节的起首辅音前，非重读 AH 读 ə。"""
    syms = []
    stress_at = {}
    for idx, raw in enumerate(phones):
        stress = ''
        p = raw
        if p and p[-1] in '012' and p[:-1] in ARP:
            stress = p[-1]
            p = p[:-1]
        if p not in ARP:
            return ''
        if p == 'AH':
            sym = 'ʌ' if stress in ('1', '2') else 'ə'   # 非重读是 ə
        else:
            sym = ARP[p]
            if p in ('AA', 'AO', 'IY', 'UW'):
                sym += 'ː'
            elif p == 'ER':
                sym += 'ː'
        syms.append(sym)
        if stress in ('1', '2'):
            stress_at[idx] = 'ˈ' if stress == '1' else 'ˌ'

    # 重音标记前移到「紧挨元音的那串辅音」之前（音节起首）
    for idx, mark in sorted(stress_at.items(), reverse=True):
        j = idx
        while j > 0 and syms[j - 1] and syms[j - 1][0] not in 'ɑæʌɔaɪeioʊuəɝɜɐɛɪʊɔ':
            j -= 1
        syms.insert(j, mark)
    return ''.join(syms)


def load_cmudict(path):
    d = {}
    with io.open(path, encoding='utf-8', errors='ignore') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(';;;'):
                continue
            if '  ' in line:
                w, phones = line.split('  ', 1)
            elif ' ' in line:
                w, phones = line.split(' ', 1)
            else:
                continue
            w = re.sub(r'\(\d+\)$', '', w).strip().lower()
            ipa = arp_to_ipa(phones.split())
            if w and ipa and w not in d:
                d[w] = ipa
    return d


def load_freedict(path):
    """FreeDict TEI → { word: (中文释义, 英文释义, 词性) }"""
    out = {}
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        print('TEI 解析失败:', e)
        return out
    root = tree.getroot()

    def strip_ns(tag):
        return tag.split('}')[-1] if '}' in tag else tag

    for entry in root.iter():
        if strip_ns(entry.tag) != 'entry':
            continue
        word, pos = '', ''
        zh, en = [], []
        for node in entry.iter():
            name = strip_ns(node.tag)
            text = (node.text or '').strip()
            if not text:
                continue
            if name == 'orth' and not word:
                word = text
            elif name == 'pos' and not pos:
                pos = text
            elif name == 'quote':
                zh.append(text)
            elif name == 'def':
                en.append(text)
        if not word:
            continue
        if word not in out and (zh or en):
            zh_text = '；'.join(zh)
            if zhconv:                       # FreeDict 是繁体，转简体
                zh_text = zhconv.convert(zh_text, 'zh-cn')
            out[word] = (zh_text[:120], '；'.join(en)[:160], pos)
    return out


def main(ecdict_csv, cmu_path, tei_path, pack_path=None):
    cmu = load_cmudict(cmu_path)
    fd = load_freedict(tei_path)
    print('CMUdict 音标: %d 词' % len(cmu))
    print('FreeDict 词条: %d 条' % len(fd))

    rows = []
    with io.open(ecdict_csv, encoding='utf-8', errors='ignore', newline='') as f:
        for r in csv.DictReader(f):
            w = (r.get('word') or '').strip()
            if not w:
                continue
            rows.append(r)

    def key(r):
        frq = int(r['frq']) if (r.get('frq') or '').isdigit() else 10 ** 8
        return (0 if (r.get('tag') or '').strip() else 1, frq)

    rows.sort(key=key)
    picked = rows[:EN_LIMIT]
    by_word = {r['word'].strip().lower(): r for r in rows}

    # 教材用词必收
    musts = []
    if pack_path and os.path.exists(pack_path):
        pk = json.load(io.open(pack_path, encoding='utf-8'))
        for c in pk.get('courses', []):
            if str(c.get('id', '')).startswith('en'):
                for card in c.get('cards', []):
                    w = str(card.get('front') or '').strip()
                    if w:
                        musts.append(w)
    have = {r['word'].strip().lower() for r in picked}
    for w in musts:
        if w.lower() not in have and w.lower() in by_word:
            picked.append(by_word[w.lower()])
            have.add(w.lower())

    out = {}
    src_zh = {'freedict': 0, 'ecdict': 0}
    for r in picked:
        w = r['word'].strip()
        if w in out:
            continue
        lw = w.lower()
        ecd_zh = (r.get('translation') or '').replace('\\n', '；').replace('\n', '；').strip()
        fd_zh, fd_en, fd_pos = fd.get(w, ('', '', ''))
        zh = fd_zh or ecd_zh or fd_en
        zh_src = 'freedict' if fd_zh else ('ecdict' if ecd_zh else ('freedict-en' if fd_en else ''))
        src_zh['freedict' if fd_zh else 'ecdict'] += 1
        phon = cmu.get(lw) or ''
        frq = r.get('frq') or ''
        out[w] = [
            phon,
            zh[:160],
            (fd_pos or (r.get('pos') or '')).strip()[:20],
            (r.get('tag') or '').strip()[:40],
            int(frq) if frq.isdigit() else 0,
            zh_src,
        ]

    raw = json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with gzip.open(OUT, 'wb', compresslevel=9) as f:
        f.write(raw)
    has_phon = sum(1 for v in out.values() if v[0])
    print('%d 条 | 有音标 %d (%.0f%%) | 释义来源 FreeDict %d / ECDICT %d'
          % (len(out), has_phon, 100.0 * has_phon / max(1, len(out)), src_zh['freedict'], src_zh['ecdict']))
    print('en.json.gz: 原始 %.1fMB → %.1fMB' % (len(raw) / 1048576, os.path.getsize(OUT) / 1048576))


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2], sys.argv[3],
         sys.argv[4] if len(sys.argv) > 4 else os.path.join(HERE, 'pack.json'))
