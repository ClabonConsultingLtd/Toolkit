# Image to 3D

Generic authenticated image-to-GLB batch conversion using a Gradio-compatible image-to-3D service. The included CLI uses the TRELLIS API sequence.

## Queue format

Input queues use explicit records so no project taxonomy is implied:

```json
[
  {
    "id": "sample-object",
    "reference": "references/sample-object.png",
    "model": "models/sample-object.glb"
  }
]
```

Relative paths resolve beneath `--source-root` and cannot escape it. Absolute paths are allowed when deliberately supplied. Existing model outputs are skipped by default; replacing one requires `--overwrite`.

## Use

Install from this package directory with `uv sync` (or another Python package installer), then run:

```bash
HF_TOKEN=hf_... toolkit-image-to-3d queue.json --source-root .
```

Useful controls:

- `--dry-run` validates the queue and reports planned conversions without requiring a token or contacting the service.
- `--results results.json` chooses the per-run report destination.
- `--ledger ledger.json` maintains a cumulative record keyed by queue ID.
- `--space`, `--token-env`, `--resolution`, `--decimation-target`, `--texture-size`, `--retries`, and `--retry-delay` configure the service run.

Per-run JSON reports and an optional cumulative ledger make resumed runs auditable without prescribing any environment categories, scheduling system, storage service, or directory layout.
