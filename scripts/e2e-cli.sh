#!/usr/bin/env bash
# End-to-end check through the real `pi` CLI: loads pi-rsi from this checkout,
# drives the interactive protocol (work → rsi_submit → isolated Verifier → PASS
# → rsi_learn → rsi_memory_write → rsi_memory_commit ×2) against a scripted
# OpenAI-compatible mock server, and checks what landed on disk.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi_bin="${PI_BIN:-$here/node_modules/.bin/pi}"
work="$(mktemp -d "${TMPDIR:-/tmp}/pi-rsi-e2e-XXXXXX")"
trap 'kill "${mock_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

agent="$work/agent"
project="$work/project"
mkdir -p "$agent" "$project"
git -C "$project" init -q
printf '# e2e\n' > "$project/README.md"
git -C "$project" -c user.email=e2e@local -c user.name=e2e -c core.hooksPath=/dev/null add -A
git -C "$project" -c user.email=e2e@local -c user.name=e2e -c core.hooksPath=/dev/null commit -q -m init

log="$work/requests.jsonl"
: > "$log"
node "$here/scripts/mock-openai.mjs" "$log" "$project" > "$work/mock.out" &
mock_pid=$!
for _ in $(seq 1 50); do
  grep -q LISTENING "$work/mock.out" 2>/dev/null && break
  sleep 0.1
done
port="$(awk '/LISTENING/ {print $2}' "$work/mock.out")"
[ -n "$port" ] || { echo "mock server did not start" >&2; exit 1; }

cat > "$agent/models.json" <<JSON
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:$port/v1",
      "api": "openai-completions",
      "apiKey": "mock-key",
      "models": [{ "id": "mock-1", "contextWindow": 128000, "maxTokens": 4096 }]
    }
  }
}
JSON
printf '{ "verifier": { "isolation": "%s" } }\n' "${RSI_ISOLATION:-auto}" > "$agent/rsi.json"

cd "$project"
output="$(PI_CODING_AGENT_DIR="$agent" "$pi_bin" --print --no-session -ne -e "$here/src/index.ts" \
  --model mock/mock-1 --thinking off "Create hello.txt containing the word hello." 2>"$work/stderr.txt")" || {
  echo "pi exited with an error" >&2
  cat "$work/stderr.txt" >&2
  cat "$log" >&2
  exit 1
}

fail() {
  echo "E2E FAILED: $1" >&2
  echo "--- stdout"; echo "$output"
  echo "--- stderr"; cat "$work/stderr.txt"
  echo "--- requests"; cat "$log"
  exit 1
}

[[ "$output" == *E2E-DONE* ]] || fail "final reply missing"
[ "$(cat "$project/hello.txt")" = "hello" ] || fail "hello.txt was not kept as the Actor wrote it"
memory="$(find "$agent/rsi/projects" -path '*/store/memory/procedures/hello.md' | head -1)"
[ -n "$memory" ] || fail "memory was not promoted"
grep -q 'printf' "$memory" || fail "memory content differs"
[ ! -e "$project/.pi-rsi" ] || fail "pi-rsi state leaked into the project"
grep -q '"role":"verifier"' "$log" || fail "no Verifier request was made"
grep '"role":"verifier"' "$log" | head -1 | grep -q 'Create hello.txt containing the word hello.' || fail "Verifier did not get the verbatim task"
if grep '"role":"verifier"' "$log" | head -1 | grep -q '"rsi_submit"'; then fail "Verifier was offered rsi_submit"; fi
grep -q 'scratch-ok' "$log" || fail "Verifier scratch was not writable"
grep -q 'Memory promoted (PASS experience)' "$log" || fail "commit result missing"
journal="$(find "$agent/rsi/projects" -name journal.jsonl | head -1)"
[ "$(wc -l < "$journal")" -eq 1 ] || fail "expected one journal record"

if [ "${RSI_ISOLATION:-auto}" != rollback ] && command -v bwrap >/dev/null && bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid true 2>/dev/null; then
  grep -q "Read-only file system" "$log" || fail "the sandboxed Verifier could write the candidate"
fi
echo "pi-rsi e2e passed (isolation ${RSI_ISOLATION:-auto})"
