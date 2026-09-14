import sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from toolkit_image_generation.cli import prompts


class Tests(unittest.TestCase):
    def test_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "p.txt"
            p.write_text("# x\none\nfirst\n\ntwo\nsecond\n")
            self.assertEqual(prompts(p), [("one", "first"), ("two", "second")])

    def test_unsafe_id(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "p.txt"
            p.write_text("../bad\nx")
            with self.assertRaises(ValueError):
                prompts(p)


if __name__ == "__main__":
    unittest.main()
