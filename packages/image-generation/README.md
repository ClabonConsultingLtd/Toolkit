# Image generation

Resumable batch image generation driven by a simple prompt file and an image-capable command-line runner.

## Use

```bash
toolkit-image-generate prompts.txt --output-dir generated --runner image-runner --runner-arg run --runner-arg "{instruction}"
```

The runner is deliberately caller-supplied. `--runner-arg` is repeatable and supports `{instruction}`, `{prompt}`, and `{output}` without shell expansion. Use `--dry-run` to validate a queue without a runner.

## Behaviour

- A prompt file contains an output identifier followed by prompt text, separated by blank lines.
- The caller chooses output, staging, state, and log directories.
- Each prompt runs in an isolated session.
- A non-empty output file is required before an item becomes `done`.
- Quota or rate-limit signals stop the batch without marking the current item failed.
- Ordinary failures retry a caller-selected number of times and retain a structured state record.
- Failed items are skipped on resume unless `--retry-failed` is supplied.

No image style, remote share, model, executable path, or prompt collection is bundled with this package.
