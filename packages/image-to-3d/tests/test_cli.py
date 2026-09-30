import contextlib
import io
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
    redact,
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


class RedactTests(unittest.TestCase):
    def test_replaces_bare_secret(self) -> None:
        self.assertEqual(redact("error: token abc123 rejected", "abc123"), "error: token [REDACTED] rejected")

    def test_replaces_secret_inside_bearer_header(self) -> None:
        self.assertEqual(
            redact("HTTP 401: Authorization: Bearer abc123", "abc123"),
            "HTTP 401: Authorization: Bearer [REDACTED]",
        )

    def test_replaces_every_occurrence(self) -> None:
        self.assertEqual(redact("abc123 and abc123 again", "abc123"), "[REDACTED] and [REDACTED] again")

    def test_empty_secret_leaves_text_unchanged(self) -> None:
        self.assertEqual(redact("nothing to redact here", ""), "nothing to redact here")

    def test_none_secret_leaves_text_unchanged(self) -> None:
        self.assertEqual(redact("nothing to redact here", None), "nothing to redact here")

    def test_none_text_stays_none(self) -> None:
        self.assertIsNone(redact(None, "abc123"))


class ErrorRedactionTests(unittest.TestCase):
    def test_client_error_containing_token_is_redacted_everywhere(self) -> None:
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
            ledger = root / "ledger.json"
            token = "hf_secrettoken123"  # noqa: S105 -- fake fixture value, not a real credential

            class FakeClient:
                def __init__(self, *args, **kwargs) -> None:
                    pass

                def predict(self, *args, **kwargs):
                    raise RuntimeError(
                        f"upstream rejected request: bare={token} "
                        f"header='Authorization: Bearer {token}'"
                    )

            fake_module = mock.Mock()
            fake_module.Client = FakeClient
            fake_module.handle_file = lambda value: value

            argv = [
                "prog",
                str(queue),
                "--source-root",
                str(root),
                "--ledger",
                str(ledger),
                "--retries",
                "1",
            ]
            with mock.patch.dict(os.environ, {"HF_TOKEN": token}):
                with mock.patch.dict(sys.modules, {"gradio_client": fake_module}):
                    with mock.patch.object(sys, "argv", argv):
                        stdout = io.StringIO()
                        stderr = io.StringIO()
                        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                            with self.assertRaises(SystemExit):
                                main()

            report = json.loads(queue.with_name("queue.results.json").read_text(encoding="utf-8"))
            ledger_text = ledger.read_text(encoding="utf-8")
            report_text = json.dumps(report)

            for haystack in (stdout.getvalue(), stderr.getvalue(), report_text, ledger_text):
                self.assertNotIn(token, haystack)
            self.assertIn("[REDACTED]", report_text)
            self.assertIn("[REDACTED]", ledger_text)


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
