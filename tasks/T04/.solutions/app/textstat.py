import re

_WORD_RE = re.compile(r"[A-Za-z]+")


def word_frequencies(text, top_n=10):
    """统计词频，返回前 top_n 个 (word, count)。"""
    counts = {}
    for w in _WORD_RE.findall(text or ""):
        w = w.lower()
        counts[w] = counts.get(w, 0) + 1
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return items[:top_n]


def _count_syllables(word: str) -> int:
    n = 0
    prev_vowel = False
    for ch in word.lower():
        is_vowel = ch in "aeiou"
        if is_vowel and not prev_vowel:
            n += 1
        prev_vowel = is_vowel
    return max(1, n)


def reading_ease(text):
    """Flesch Reading Ease 近似值。"""
    text = text or ""
    words = _WORD_RE.findall(text)
    if not words:
        return 0.0
    sentences = len([s for s in re.split(r"[.!?]+", text) if s.strip()])
    sentences = max(1, sentences)
    syllables = sum(_count_syllables(w) for w in words)
    return 206.835 - 1.015 * (len(words) / sentences) - 84.6 * (syllables / len(words))
