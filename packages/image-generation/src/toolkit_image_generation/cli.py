import argparse, json, re, subprocess, time, shutil
from pathlib import Path

ID = re.compile(r"^[\w][\w./-]*$")


def prompts(path):
    out = []
    seen = set()
    for n, b in enumerate(re.split(r"\n\s*\n", path.read_text().strip()), 1):
        lines = [x for x in b.splitlines() if not x.lstrip().startswith("#")]
        if not lines:
            continue
        i = lines[0].strip()
        p = "\n".join(lines[1:]).strip()
        if not ID.fullmatch(i) or ".." in i.split("/") or not p or i in seen:
            raise ValueError(f"invalid prompt block {n}")
        seen.add(i)
        out.append((i, p))
    return out


def save(p, o):
    p.parent.mkdir(parents=True, exist_ok=True)
    t = p.with_suffix(".tmp")
    t.write_text(json.dumps(o, indent=2))
    t.replace(p)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("prompts", type=Path)
    a.add_argument("--output-dir", type=Path, required=True)
    a.add_argument("--staging-dir", type=Path)
    a.add_argument("--runner")
    a.add_argument("--runner-arg", action="append", default=[])
    a.add_argument("--state", type=Path)
    a.add_argument("--log-dir", type=Path)
    a.add_argument("--retries", type=int, default=2)
    a.add_argument("--retry-delay", type=float, default=5)
    a.add_argument("--timeout", type=float, default=600)
    a.add_argument("--limit", type=int)
    a.add_argument("--retry-failed", action="store_true")
    a.add_argument("--dry-run", action="store_true")
    x = a.parse_args()
    if not x.dry_run and not x.runner:
        raise SystemExit("--runner required unless --dry-run")
    state = x.state or x.output_dir / "image-generation-state.json"
    data = json.loads(state.read_text()) if state.exists() else {}
    for number, (i, p) in enumerate(prompts(x.prompts), 1):
        if x.limit and number > x.limit:
            break
        if data.get(i, {}).get("status") == "done" or (
            data.get(i, {}).get("status") == "failed" and not x.retry_failed
        ):
            continue
        destination = x.output_dir / f"{i}.png"
        out = (x.staging_dir or x.output_dir) / f"{i}.png"
        if x.dry_run:
            print(f"WOULD GENERATE: {i} -> {destination}")
            continue
        instruction = f"{p}\n\nGenerate an image and save it to: {out}"
        cmd = [
            x.runner,
            *[
                v.format(instruction=instruction, prompt=p, output=out)
                for v in x.runner_arg
            ],
        ]
        for attempt in range(1, x.retries + 2):
            try:
                r = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=x.timeout
                )
            except subprocess.TimeoutExpired:
                r = None
            detail = "runner timed out" if r is None else (r.stderr or r.stdout).strip()
            log = (
                x.log_dir or x.output_dir / "image-generation-logs"
            ) / f'{i.replace("/","__")}.log'
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(detail, encoding="utf-8")
            if any(
                s in detail.lower()
                for s in ("usage limit", "rate limit", "429 too many")
            ):
                data[i] = {
                    "status": "pending",
                    "error": "runner reported quota/rate limit",
                }
                save(state, data)
                raise SystemExit(2)
            if out.is_file() and out.stat().st_size:
                if out != destination:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(out, destination)
                data[i] = {
                    "status": "done",
                    "output": str(destination),
                    "attempts": attempt,
                }
                print(f"OK: {i}")
                break
            if attempt > x.retries:
                data[i] = {"status": "failed", "error": detail, "attempts": attempt}
                print(f"FAIL: {i}")
                break
            time.sleep(x.retry_delay)
        save(state, data)


if __name__ == "__main__":
    main()
