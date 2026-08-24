import unittest

from app.textstat import reading_ease, word_frequencies


class TestHidden(unittest.TestCase):
    def test_top_n_limits_output(self):
        text = "a b c d e f g h"
        self.assertEqual(len(word_frequencies(text, 3)), 3)

    def test_exact_counts(self):
        text = "one two two three three three"
        self.assertEqual(word_frequencies(text, 1), [("three", 3)])

    def test_reading_ease_formula(self):
        # 3 句 8 词；音节：the/cat/sat/the/dog/ran/far 各 1，away=2 → 共 9
        text = "The cat sat. The dog ran. Far away."
        words = 8
        sentences = 3
        syllables = 9
        expect = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words)
        self.assertAlmostEqual(reading_ease(text), expect, places=3)

    def test_no_sentence_markers_counts_one_sentence(self):
        # hello=2 音节，world=1 音节，1 句 2 词
        v = reading_ease("hello world")
        self.assertAlmostEqual(v, 206.835 - 1.015 * 2 - 84.6 * (3 / 2), places=3)

    def test_digits_are_not_words(self):
        self.assertEqual(word_frequencies("a1 b2 a1", 5), [("a", 2), ("b", 1)])


if __name__ == "__main__":
    unittest.main()
