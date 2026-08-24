import unittest

from app.textstat import reading_ease, word_frequencies


class TestWordFrequencies(unittest.TestCase):
    def test_basic(self):
        text = "the cat and the dog and the bird"
        self.assertEqual(word_frequencies(text, 2), [("the", 3), ("and", 2)])

    def test_case_and_punctuation(self):
        text = "Hello, HELLO! world."
        self.assertEqual(word_frequencies(text, 10), [("hello", 2), ("world", 1)])

    def test_tie_breaks_alphabetical(self):
        text = "b a b a c"
        self.assertEqual(word_frequencies(text, 3), [("a", 2), ("b", 2), ("c", 1)])

    def test_empty(self):
        self.assertEqual(word_frequencies("", 5), [])
        self.assertEqual(word_frequencies("123 456", 5), [])


class TestReadingEase(unittest.TestCase):
    def test_empty_is_zero(self):
        self.assertEqual(reading_ease(""), 0.0)

    def test_positive_number(self):
        v = reading_ease("The cat sits. A dog runs fast.")
        self.assertIsInstance(v, float)

    def test_longer_words_lower_ease(self):
        easy = reading_ease("A cat. A dog. A bird.")
        hard = reading_ease("Considerably complicated terminology necessitates deliberation.")
        self.assertGreater(easy, hard)


if __name__ == "__main__":
    unittest.main()
