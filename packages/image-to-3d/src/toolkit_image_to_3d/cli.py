"""Convert an explicit JSON queue of reference images into GLB models.

The queue is a JSON list of records with ``id``, ``reference`` and ``model``
strings. Relative paths resolve beneath ``--source-root`` and may not escape
it. This command deliberately has no project-specific source or output
directory defaults.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

DEFAULT_SPACE = "microsoft/TRELLIS.2"
DEFAULT_RESOLUTION = "1024"
DEFAULT_DECIMATION_TARGET = 300_000
DEFAULT_TEXTURE_SIZE = 2048


def atomic_json_write(path: Path, data: Any) -> None:
    """Write JSON without leaving a partial state/report file on interruption."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def quota_error(error: str | None) -> bool:
    """Whether retrying immediately is unlikely to succeed."""
    text = (error or "").lower()
    return "zerogpu quota" in text or "quota exhausted" in text or "rate limit" in text


def resolve_queue_path(value: str, source_root: Path) -> Path:
    """Resolve a queue path and reject relative traversal outside source_root."""
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate.resolve()
    resolved_root = source_root.resolve()
    resolved = (resolved_root / candidate).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError(f"path escapes --source-root: {value}") from exc
    return resolved


def parse_record(item: Any, source_root: Path) -> tuple[str, Path, Path]:
    if not isinstance(item, dict):
        raise ValueError("queue entry must be an object")
    values = {key: item.get(key) for key in ("id", "reference", "model")}
    if not all(isinstance(value, str) and value.strip() for value in values.values()):
        raise ValueError("queue entry requires non-empty string id, reference and model fields")
    identifier = values["id"]
    assert isinstance(identifier, str)
    return identifier, resolve_queue_path(values["reference"], source_root), resolve_queue_path(values["model"], source_root)


def load_queue(path: Path, source_root: Path) -> list[tuple[str, Path, Path]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read queue {path}: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError("queue JSON must be a list")
    records: list[tuple[str, Path, Path]] = []
    identifiers: set[str] = set()
    for index, item in enumerate(data, start=1):
        try:
            record = parse_record(item, source_root)
        except ValueError as exc:
            raise ValueError(f"queue entry {index}: {exc}") from exc
        if record[0] in identifiers:
            raise ValueError(f"queue entry {index}: duplicate id {record[0]!r}")
        identifiers.add(record[0])
        records.append(record)
    return records


def convert(
    reference: Path,
    destination: Path,
    *,
    token: str,
    space: str,
    resolution: str,
    decimation_target: int,
    texture_size: int,
    retries: int,
    retry_delay: float,
) -> tuple[bool, int, int, str | None]:
    """Run one TRELLIS-compatible conversion, retrying non-quota failures."""
    try:
        from gradio_client import Client, handle_file
    except ImportError as exc:
        return False, 0, 0, "gradio-client is not installed; install the package dependencies"

    last_error: str | None = None
    for attempt in range(1, retries + 1):
        try:
            client = Client(space, token=token, verbose=False)
            client.predict(api_name="/start_session")
            preprocessed = client.predict(input=handle_file(str(reference)), api_name="/preprocess_image")
            seed = client.predict(randomize_seed=True, seed=0, api_name="/get_seed")
            image = preprocessed["path"] if isinstance(preprocessed, dict) else preprocessed
            client.predict(image=handle_file(image), seed=seed, resolution=resolution, api_name="/image_to_3d")
            glb = client.predict(decimation_target=decimation_target, texture_size=texture_size, api_name="/extract_glb")
            generated = Path(glb[0] if isinstance(glb, (list, tuple)) else glb)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(generated, destination)
            return True, destination.stat().st_size, attempt, None
        except Exception as exc:  # The service reports its own transient errors as exceptions.
            last_error = str(exc)
            if quota_error(last_error):
                break
            if attempt < retries:
                time.sleep(retry_delay)
    return False, 0, attempt, last_error


def update_ledger(path: Path, results: list[dict[str, Any]]) -> None:
    try:
        current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"assets": {}}
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read ledger {path}: {exc}") from exc
    assets = current.get("assets")
    if not isinstance(assets, dict):
        raise ValueError(f"ledger {path} must contain an assets object")
    for result in results:
        assets[result["id"]] = result
    atomic_json_write(path, {"assets": dict(sorted(assets.items()))})


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("queue", type=Path, help="JSON queue containing id/reference/model records")
    result.add_argument("--source-root", type=Path, default=Path.cwd(), help="root for relative queue paths (default: current directory)")
    result.add_argument("--token-env", default="HF_TOKEN", help="environment variable containing the service token")
    result.add_argument("--space", default=DEFAULT_SPACE, help="Gradio Space name")
    result.add_argument("--resolution", default=DEFAULT_RESOLUTION)
    result.add_argument("--decimation-target", type=int, default=DEFAULT_DECIMATION_TARGET)
    result.add_argument("--texture-size", type=int, default=DEFAULT_TEXTURE_SIZE)
    result.add_argument("--retries", type=int, default=3)
    result.add_argument("--retry-delay", type=float, default=3.0)
    result.add_argument("--results", type=Path, help="per-run JSON report (default: beside queue)")
    result.add_argument("--ledger", type=Path, help="optional cumulative JSON ledger")
    result.add_argument("--overwrite", action="store_true", help="replace an existing model output")
    result.add_argument("--dry-run", action="store_true", help="validate and report actions without calling the service")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.retries < 1:
        raise SystemExit("--retries must be at least 1")
    if args.retry_delay < 0:
        raise SystemExit("--retry-delay must not be negative")
    if args.decimation_target < 1 or args.texture_size < 1:
        raise SystemExit("--decimation-target and --texture-size must be positive")
    try:
        records = load_queue(args.queue, args.source_root)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    token = os.environ.get(args.token_env)
    if not args.dry_run and not token:
        raise SystemExit(f"{args.token_env} is not set; set it or use --dry-run")

    results: list[dict[str, Any]] = []
    for identifier, reference, model in records:
        error: str | None = None
        attempts = 0
        size = 0
        if not reference.is_file():
            status = "failed"
            error = f"reference does not exist: {reference}"
        elif model.exists() and not args.overwrite:
            status = "skipped"
            size = model.stat().st_size
        elif args.dry_run:
            status = "would-convert"
        else:
            ok, size, attempts, error = convert(reference, model, token=token or "", space=args.space, resolution=args.resolution, decimation_target=args.decimation_target, texture_size=args.texture_size, retries=args.retries, retry_delay=args.retry_delay)
            status = "converted" if ok else "failed"
        result = {"id": identifier, "reference": str(reference), "model": str(model), "status": status, "size": size, "attempts": attempts, "error": error}
        results.append(result)
        print(f"{status.upper()}: {identifier}" + (f" - {error}" if error else ""), flush=True)
        if quota_error(error):
            print("Stopping batch: service quota or rate limit is exhausted.", flush=True)
            break

    report = args.results or args.queue.with_name(f"{args.queue.stem}.results.json")
    atomic_json_write(report, results)
    if args.ledger:
        try:
            update_ledger(args.ledger, results)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
    if any(result["status"] == "failed" for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
