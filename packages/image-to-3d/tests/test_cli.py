import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from toolkit_image_to_3d.cli import (
    atomic_json_write,
    load_queue,
    main,
    mesh_sanity,
    read_env_file,
    resolve_queue_path,
    update_ledger,
)


class QueueTests(unittest.TestCase):
    def test_relative_paths_resolve_under_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue.json"
            queue.write_text(
                json.dumps(
                    [
                        {
                            "id": "one",
                            "reference": "input.png",
                            "model": "models/output.glb",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            resolved_root = root.resolve()
            self.assertEqual(
                load_queue(queue, root),
                [
                    (
                        "one",
                        resolved_root / "input.png",
                        resolved_root / "models" / "output.glb",
                    )
                ],
            )

    def test_relative_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "escapes"):
                resolve_queue_path("../outside.png", Path(directory))

    def test_duplicate_identifier_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue.json"
            queue.write_text(
                json.dumps(
                    [
                        {"id": "one", "reference": "a.png", "model": "a.glb"},
                        {"id": "one", "reference": "b.png", "model": "b.glb"},
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate"):
                load_queue(queue, root)

    def test_ledger_merges_by_identifier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "ledger.json"
            atomic_json_write(ledger, {"assets": {"old": {"status": "converted"}}})
            update_ledger(ledger, [{"id": "new", "status": "skipped"}])
            self.assertEqual(
                json.loads(ledger.read_text(encoding="utf-8"))["assets"],
                {
                    "new": {"id": "new", "status": "skipped"},
                    "old": {"status": "converted"},
                },
            )


class EnvFileTests(unittest.TestCase):
    def test_parses_simple_key_value_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "# comment\nHF_TOKEN=secret-value\nQUOTED=\"a b\"\n\nBLANK=\n",
                encoding="utf-8",
            )
            self.assertEqual(
                read_env_file(env_path),
                {"HF_TOKEN": "secret-value", "QUOTED": "a b", "BLANK": ""},
            )

    def test_missing_file_returns_empty(self) -> None:
        self.assertEqual(read_env_file(Path("/does/not/exist/.env")), {})

    def test_main_reads_token_from_env_file_when_unset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input.png").write_text("x", encoding="utf-8")
            queue = root / "queue.json"
            queue.write_text(
                json.dumps(
                    [{"id": "one", "reference": "input.png", "model": "out.glb"}]
                ),
                encoding="utf-8",
            )
            env_file = root / ".env"
            env_file.write_text("HF_TOKEN=from-env-file\n", encoding="utf-8")
            argv = [
                "prog",
                str(queue),
                "--source-root",
                str(root),
                "--env-file",
                str(env_file),
            ]
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("HF_TOKEN", None)
                with mock.patch.object(sys, "argv", argv):
                    with self.assertRaises(SystemExit):
                        main()
            report = json.loads(queue.with_name("queue.results.json").read_text())
            # The token reached conversion (no "not set" refusal); the only
            # possible failure here is the optional dependency being absent.
            self.assertIn("gradio-client is not installed", report[0]["error"])


class MeshSanityTests(unittest.TestCase):
    def test_returns_none_when_trimesh_is_not_installed(self) -> None:
        with mock.patch.dict(sys.modules, {"trimesh": None}):
            self.assertEqual(mesh_sanity(Path("anything.glb")), (None, None))

    def test_reports_triangle_count_and_watertight_flag(self) -> None:
        fake = mock.Mock()
        fake.load.return_value = mock.Mock(
            faces=[0, 1, 2, 3, 4], is_watertight=False
        )
        with mock.patch.dict(sys.modules, {"trimesh": fake}):
            self.assertEqual(mesh_sanity(Path("anything.glb")), (5, False))

    def test_returns_none_on_load_failure(self) -> None:
        fake = mock.Mock()
        fake.load.side_effect = RuntimeError("bad mesh")
        with mock.patch.dict(sys.modules, {"trimesh": fake}):
            self.assertEqual(mesh_sanity(Path("anything.glb")), (None, None))


if __name__ == "__main__":
    unittest.main()
