import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from toolkit_image_to_3d.cli import atomic_json_write, load_queue, resolve_queue_path, update_ledger


class QueueTests(unittest.TestCase):
    def test_relative_paths_resolve_under_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue.json"
            queue.write_text(json.dumps([{"id": "one", "reference": "input.png", "model": "models/output.glb"}]), encoding="utf-8")
            resolved_root = root.resolve()
            self.assertEqual(
                load_queue(queue, root),
                [("one", resolved_root / "input.png", resolved_root / "models" / "output.glb")],
            )

    def test_relative_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "escapes"):
                resolve_queue_path("../outside.png", Path(directory))

    def test_duplicate_identifier_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue.json"
            queue.write_text(json.dumps([{ "id": "one", "reference": "a.png", "model": "a.glb" }, { "id": "one", "reference": "b.png", "model": "b.glb" }]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate"):
                load_queue(queue, root)

    def test_ledger_merges_by_identifier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "ledger.json"
            atomic_json_write(ledger, {"assets": {"old": {"status": "converted"}}})
            update_ledger(ledger, [{"id": "new", "status": "skipped"}])
            self.assertEqual(json.loads(ledger.read_text(encoding="utf-8"))["assets"], {"new": {"id": "new", "status": "skipped"}, "old": {"status": "converted"}})


if __name__ == "__main__":
    unittest.main()
