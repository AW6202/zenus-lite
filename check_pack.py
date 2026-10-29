# -*- coding: utf-8 -*-
"""内容包自检：数学题重算、选择题唯一答案、字段完整、重复项。
用法: python check_pack.py [pack.json]
退出码: 0 全过 / 1 有问题（问题清单打到 stdout）
"""
import gzip
import json
import os
import re
import string
import unicodedata
import sys
from fractions import Fraction

FAIL = []
WARN = []
NOTE = []


def fail(msg):
    FAIL.append(msg)


def warn(msg):
    WARN.append(msg)


def note(msg):
    NOTE.append(msg)


def norm(s):
    t = (str(s).replace("−", "-").replace("－", "-").replace("×", "*")
         .replace("÷", "&").replace("×", "*").replace(" ", ""))
    t = re.sub(r"(\d)(x)", r"\1*\2", t)          # 2x -> 2*x
    t = re.sub(r"(\d)\(", r"\1*(", t)             # 3(x+2) -> 3*(x+2)
    t = re.sub(r"\)x", ")*x", t)
    return t


def solve_linear(eq):
    """解 ax+b=c 形式的一元一次方程，用两点取值求斜率和截距，不依赖符号库。"""
    lhs, rhs = eq.split("=", 1)

    def f(x):
        return eval(norm(lhs), {"__builtins__": {}}, {"x": x}) - eval(norm(rhs), {"__builtins__": {}}, {"x": x})

    f0, f1 = f(0), f(1)
    slope = f1 - f0
    if abs(slope) < 1e-12:
        return None
    return Fraction(-f0 / slope).limit_denominator(10000)


def as_fraction(s):
    s = norm(s)
    if "/" in s:
        a, b = s.split("/", 1)
        return Fraction(int(a), int(b))
    return Fraction(s)


def check_math(card, cid):
    front = card.get("front", "")
    back = card.get("back", "")
    q = front.replace("，x = ?", "").strip()

    try:
        if "x = ?" in front and "=" in q:
            got = solve_linear(q)
            if got is None:
                fail(f"{cid}: 无法解析方程 {front}")
            elif as_fraction(back) != got:
                fail(f"{cid}: 方程算错 {front} 期望 {got} 实际 {back}")
            return
        # 纯算术：a op b = ?
        qq = norm(q)
        m = re.fullmatch(r"(.+?)=[?？]", qq)
        if m:
            expr = norm(m.group(1))
            if "&" in expr:
                left, right = expr.split("&", 1)
                val = Fraction(left) / Fraction(right)
                if as_fraction(back) != val:
                    fail(f"{cid}: 除法算错 {front} 期望 {val} 实际 {back}")
                return
            if re.fullmatch(r"[-+*/()0-9.]+", expr):
                val = eval(expr, {"__builtins__": {}}, {})
                val = Fraction(val).limit_denominator(1000)
                if as_fraction(back) != val:
                    fail(f"{cid}: 算术算错 {front} 期望 {val} 实际 {back}")
                return
        # 百分数 / 比例 / 打折 这类用规则校验
        rules = [
            (r"^([\d.]+)% 写成小数是？$", lambda m: Fraction(m.group(1)) / 100, "小数"),
            (r"^([\d.]+) 写成百分数是？$", lambda m: Fraction(m.group(1)) * 100, "百分数"),
            (r"^([\d.]+) 的 ([\d.]+)% 是多少？$", lambda m: Fraction(m.group(1)) * Fraction(m.group(2)) / 100, "数值"),
            (r"^([\d.]+) 元打([一二三四五六七八九])折是多少？$",
             lambda m: Fraction(m.group(1)) * Fraction("一二三四五六七八九".index(m.group(2)) + 1, 10), "金额"),
            (r"^([\d.]+)% 化成最简分数是？$", lambda m: Fraction(m.group(1)) / 100, "分数"),
            (r"^([\d.]+) 化成最简分数是？$", lambda m: Fraction(m.group(1)), "分数"),
            (r"^([\d.]+) : ([\d.]+) = ?([\d.]+) : ([\d.]+)，若 a = ([\d.]+)，b = ?$",
             lambda m: Fraction(m.group(5)) * Fraction(m.group(4)) / Fraction(m.group(3)), "数值"),
        ]
        for pat, fn, kind in rules:
            mm = re.fullmatch(pat, front)
            if not mm:
                continue
            want = fn(mm)
            got = norm(back)
            if kind == "百分数":
                if not got.endswith("%") or as_fraction(got[:-1]) != want:
                    fail(f"{cid}: 百分数算错 {front} 期望 {want}% 实际 {back}")
            elif kind == "分数":
                parts = got.split("/")
                gv = Fraction(int(parts[0]), int(parts[1])) if len(parts) == 2 else Fraction(got)
                if gv != want:
                    fail(f"{cid}: 分数算错 {front} 期望 {want} 实际 {back}")
            elif kind == "金额":
                if as_fraction(got) != want:
                    fail(f"{cid}: 打折算错 {front} 期望 {want} 实际 {back}")
            else:
                if as_fraction(got) != want:
                    fail(f"{cid}: 算错 {front} 期望 {want} 实际 {back}")
            return
        warn(f"{cid}: 这条没被规则覆盖，请人工看一眼 —— {front} -> {back}")
    except Exception as e:  # noqa: BLE001
        fail(f"{cid}: 校验异常 {front} ({e})")



# ── 日语五十音：对照固定表校验（这张表是死的，错一个字都能抓出来）──
KANA = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "を": "wo", "ん": "n",
}


def check_kana(card, cid):
    f, b = card.get("front"), card.get("back")
    if f not in KANA:
        fail(f"{cid}: 五十音表里没有这个假名 {f}")
    elif norm(str(b)).lower() != KANA[f]:
        fail(f"{cid}: 假名罗马字错 {f} 期望 {KANA[f]} 实际 {b}")


# 英语音标：只做结构检查（没接词典时无法逐个核对，先保证格式与字符集）
def ipa_char_ok(ch):
    if ch in "/() :":
        return True
    cat = unicodedata.category(ch)
    return cat.startswith("L") or cat.startswith("M")


# ── 用离线词典校验音标（ECDICT）──────────────────────────
DICT_EN = None


def load_en_dict():
    global DICT_EN
    if DICT_EN is not None:
        return DICT_EN
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "dict", "en.json.gz")
    if not os.path.exists(path):
        DICT_EN = {}
        return DICT_EN
    DICT_EN = json.loads(gzip.open(path, "rb").read().decode("utf-8"))
    return DICT_EN


VOWELS = set("aeiouəɜɑɒɔæʌɛɪʊyɚɝɐœøɵɤ")


def ipa_core(x):
    """归一化：去掉长度/重音符号和英美记音体系差异，返回 (元音骨位, 辅音骨位)。"""
    t = str(x or "").strip().strip("/[]")
    t = (t.replace("ˈ", "").replace("ˌ", "").replace("'", "")
         .replace("ː", "").replace(":", "").replace("ɡ", "g")
         .replace("ɹ", "r").replace("ә", "ə").replace(" ", "").replace("-", ""))
    t = (t.replace("əʊ", "ou").replace("oʊ", "ou").replace("eɪ", "ei")
         .replace("aɪ", "ai").replace("ɔɪ", "oi").replace("aʊ", "au")
         .replace("ɪə", "ie").replace("eə", "ee").replace("ʊə", "ue")
         .replace("ɪ", "i").replace("ʊ", "u"))
    vowel_part = "".join(ch for ch in t if ch in VOWELS)
    cons_part = "".join(ch for ch in t if ch not in VOWELS)
    cons_part = cons_part.replace("j", "")     # /tjuː/ 与 /tuː/ 是记音体系差异，不算错
    cons_part = cons_part.replace("r", "")     # 英式不卷舌、美式卷舌：r 的有无不判错
    return vowel_part, cons_part


def check_level(card, cid, c_id, en_dict):
    """级别必须有出处：levelSrc 写了来源，就必须能用同一套规则重算出来。"""
    src = str(card.get("levelSrc") or "")
    lvl = card.get("level")
    if not src:
        return
    if src == "原估值":
        note(f"{cid}: {c_id} 《{card.get('front')}》级别无出处（保持原估值）")
        return
    entry = en_dict.get(str(card.get("front") or "").lower()) or en_dict.get(str(card.get("front") or ""))
    if not entry:
        warn(f"{cid}: {c_id} levelSrc 说有出处，但词典里查不到这个词")
        return
    from set_levels import derive
    want, want_src = derive(entry)
    if want != lvl:
        fail(f"{cid}: {c_id} 级别与推导不一致 {card.get('front')}: 卡片 {lvl} 推导 {want}")
    elif want_src != src:
        warn(f"{cid}: {c_id} 级别来源标注不一致 {card.get('front')}: 卡片 {src} 推导 {want_src}")


def check_phonetic(card, cid, c_id):
    """音标现在统一来自词典：标了 cmudict 就必须逐字一致，否则直接判错。"""
    hint = str(card.get("hint") or "")
    word = str(card.get("front") or "").strip()
    src = str(card.get("phonSrc") or "")
    if not hint or not word:
        return
    d = load_en_dict()
    entry = d.get(word) or d.get(word.lower())
    if src == "原估值" or not entry or not entry[0]:
        note(f"{cid}: {c_id} 《{word}》音标无词典出处（多词短语常见）{hint}")
        return
    want = "/" + entry[0] + "/"
    if hint != want:
        fail(f"{cid}: {c_id} 音标与词典不一致 {word}: 卡片 {hint} vs 词典 {want}")



def main(path="pack.json"):
    pack = json.load(open(path, encoding="utf-8"))
    ids = set()
    fronts = {}
    total = 0
    for c in pack.get("courses", []):
        cid = c.get("id", "?")
        for card in c.get("cards", []):
            total += 1
            c_id = card.get("id")
            if not c_id:
                fail(f"{cid}: 有卡片没有 id")
            elif c_id in ids:
                fail(f"{cid}: 卡片 id 重复 {c_id}")
            ids.add(c_id)
            if not card.get("front"):
                fail(f"{cid}: {c_id} front 为空")
            if not card.get("back"):
                fail(f"{cid}: {c_id} back 为空")
            f = card.get("front")
            if f in fronts:
                warn(f"{cid}: 正面与 {fronts[f]} 重复 —— {f[:24]}")
            else:
                fronts[f] = cid
            opts = card.get("options")
            if opts:
                if len(set(opts)) != len(opts):
                    fail(f"{cid}: {c_id} 选项有重复 {opts}")
                right = [o for o in opts if str(o) == str(card.get("back"))]
                if len(right) != 1:
                    fail(f"{cid}: {c_id} 正确答案不在选项里或不止一个 back={card.get('back')} opts={opts}")
            if cid.startswith("math"):
                check_math(card, cid)
            if cid == "jp-kana":
                check_kana(card, cid)
            hint = str(card.get("hint") or "")
            if hint.startswith("/"):
                if not (hint.startswith("/") and hint.endswith("/") and len(hint) > 2):
                    fail(f"{cid}: {c_id} 音标格式不对 {hint}")
                bad = [ch for ch in hint if not ipa_char_ok(ch)]
                if bad:
                    warn(f"{cid}: {c_id} 音标里有非 IPA 字符 {bad} —— {hint}")
            check_phonetic(card, cid, c_id)
            if cid.startswith("en"):
                check_level(card, cid, c_id, load_en_dict())
            lvl = card.get("level")
            if lvl not in (None, "", "A1", "A2", "B1", "B2", "C1", "C2"):
                fail(f"{cid}: {c_id} level 取值异常 {lvl}")
    # 课程名里的级别（B1/B2/C1）和卡片实际级别是否相符
    for c in pack.get("courses", []):
        cid = str(c.get("id", ""))
        if not cid.startswith("en"):
            continue
        title = str(c.get("title") or "")
        claimed = set(re.findall(r"(A1|A2|B1|B2|C1|C2)", title))
        if not claimed:
            continue
        lv = [card.get("level") for card in c.get("cards", []) if card.get("level")]
        if lv:
            common = max(set(lv), key=lv.count)
            if common not in claimed:
                note(f"{cid}: 课程名标 {'/'.join(sorted(claimed))}，但卡片实际级别多为 {common}")
    print(f"共 {total} 张卡、{len(pack.get('courses', []))} 门课")
    for w in WARN:
        print("WARN ", w)
    for n in NOTE:
        print("NOTE ", n)
    for f in FAIL:
        print("FAIL ", f)
    print(f"\n结果: {'PASS' if not FAIL else 'FAIL'}（{len(FAIL)} 个错误 / {len(WARN)} 个提示）")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "pack.json"))
