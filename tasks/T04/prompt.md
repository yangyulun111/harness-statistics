在 `app/textstat.py` 中实现两个函数（当前为占位实现）：

1. `word_frequencies(text, top_n=10) -> list[tuple[str, int]]`
   - 单词 = 连续的字母序列，统一转小写；
   - 返回出现次数最多的前 top_n 个 (word, count)；
   - 排序：次数降序，次数相同按字母升序；
   - text 为空或无单词时返回 []。

2. `reading_ease(text) -> float`
   - Flesch Reading Ease 近似公式：206.835 - 1.015 * (词数/句数) - 84.6 * (音节数/词数)；
   - 句子按 . ! ? 切分（连续分隔符算一句）；没有句子时按 1 句计；
   - 音节数用近似：每个连续元音组（aeiou，大小写不敏感）记 1 个音节，单词至少 1 个音节；
   - 没有单词时返回 0.0。

要求：
- 只修改 `app/textstat.py`；
- 不得修改 `tests/`（另有隐藏测试在评分时注入）；
- 完成判据：`python -m unittest discover -s tests` 全部通过。
