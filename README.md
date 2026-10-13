# pi-rsi

English | [中文](README.zh.md)

**Recursive self-improvement for the [pi coding agent](https://github.com/earendil-works/pi).** This pi package ports the benchmark-independent mechanisms of [RSIAgent](https://github.com/AetherLabsAI/RSIAgent) (arXiv:2609.15364) to a pi extension:

- **Actor-owned experience memory**: procedures, reusable scripts, environment facts, and failure lessons, stored per project outside the project. The Actor reads it while it works; it changes only in a learning phase after an independent verdict.
- **An independent, isolated Verifier Agent**: a separate pi session that sees the user's recent messages verbatim and harness-captured change facts, never the Actor's reasoning, self-checks, or memory, and publishes `PASS`, `FAIL`, or `UNVERIFIED`. Its shell runs in a read-only bubblewrap sandbox when one is available; otherwise the candidate is checkpointed and restored.
- **Curriculum-driven exploration**: Phase 1 broad waves and Phase 2 deep, target-conditioned practice (BRS / DRS in the paper). A Curriculum Agent authors each project's fixtures; the harness captures and replays them byte for byte.
- **Frozen mode and sealed evaluation**: test-time reuse (Phase 3) and an optional host-only evaluator whose result never reaches an agent.

Model weights never change. Improvement comes only from verified experience that memory carries across tasks.

## Install

Requires Node ≥ 22.19 and pi ≥ 1.2 (`npm i -g @earendil-works/pi-coding-agent`).

```sh
# from GitHub
pi install git:github.com/mutsuki14/Pi-RSI

# or from a local checkout
git clone https://github.com/mutsuki14/Pi-RSI && pi install ./Pi-RSI

# or for a single run, without installing
pi -e ./Pi-RSI/src/index.ts
```

pi loads the TypeScript sources directly; there is no build step. On Linux, install bubblewrap (`apt install bubblewrap`, `dnf install bubblewrap`) to get the read-only Verifier sandbox.

## How it works

### Everyday tasks

The main pi agent is the Actor. pi-rsi adds the RSI protocol and a names-and-sizes memory inventory to its system prompt (as the `rsi_protocol` and `rsi_memory` sections).

```
task → Actor works (memory read as hints, via rsi_memory_list / _search / _read)
     → rsi_submit: an isolated Verifier session inspects the live result against the
       recent user messages plus git change facts; the candidate is checkpointed first
     → PASS / FAIL (a report the Actor repairs against) / UNVERIFIED (asks for CLAIM/PROBE
       evidence leads; the harness runs each probe once and labels it PASS/FAIL/NOT_RUN)
     → the same Verifier session inspects every revision of one task, across turns
     → rsi_learn: opens a learning phase on a draft copy of current memory
     → rsi_memory_write / rsi_memory_delete: distill
     → rsi_memory_commit (first call): reconcile the whole corpus
     → rsi_memory_commit (second call): atomic promotion, journal entry, before/after tree hashes
```

The task state (Verifier generation, report references, verdict, learning stage) is folded from the tool results on the current branch of the pi session, so it follows `/tree`, forks, and resumes; drafts and reports live on disk, so a learning phase survives a restart.

### Exploration lineages (`rsi_explore` tool, `/rsi-explore` command)

| phase | paper | flow |
|---|---|---|
| `broad` | Phase 1 · BRS | The Curriculum authors waves of independent projects and builds each project's fixture tree. The harness checks each tree's shape, captures it privately, and replays it into a fresh project root. Every branch starts from the same memory snapshot with a fresh Actor and a fresh Verifier. After the complete wave is verified (the **wave barrier**), the same Actor sessions distill **serially** in authored order, each against the latest memory. |
| `deep` | Phase 2 · DRS | A fresh Actor attempts an immutable target (optionally replaying `target_fixtures`). FAIL is terminal for the attempt; UNVERIFIED asks the same Actor for evidence leads. Repeated UNVERIFIED rounds or an actionless Actor stall the attempt: one forced inspection follows; if that is still unresolved, a fresh session resumes from the work log (optionally on an escalation model, with the Verifier swapped once to the Actor's model). The same Actor distills, reconciles, writes a diagnosis for the Curriculum, and only then is memory promoted. The Curriculum picks practice until `READY_FOR_TARGET` or `STALLED`. After any practice, a fresh retry of the unchanged target is mandatory, also when the practice budget runs out. |
| — | Phase 3 | Set `"mode": "frozen"`, run with `--rsi-mode frozen`, or run `/rsi-freeze`. `/rsi-eval <lineage>` runs the configured sealed evaluator. |

```
/rsi-explore broad Small data-cleaning chores with Python and the shell.
/rsi-explore deep In <PROJECT_ROOT>, implement a CSV deduplicator cli.py that ...
/rsi-explore stop
```

The command runs in the background (progress in the status line, `/rsi` for details); the `rsi_explore` tool blocks until the lineage ends. Lineages can take many model calls.

Stop policies: `curriculum_review` (default; after a target PASS the Curriculum may still ask for practice) or `verifier_pass` (stop right after a target PASS and its memory commit). Infrastructure failures are never mapped to PASS or FAIL, never commit memory, and are recorded in the lineage's `result.json` as `infra`, `quarantined`, `aborted`, or `error`.

### How role sessions work in pi

Every role (Actor, Verifier, Curriculum) is an in-process pi session created with the SDK (`createAgentSession`):

- a fresh conversation with the role's own system prompt, working directory, and tool allow-list;
- no extensions, skills, prompt templates, or context files load into it, so a role hears only the harness;
- the main session's model runtime (providers, credentials) and a model route per role;
- one `send()` is one pi run: its final assistant reply is the role's handoff, and the next `send()` continues the **same** conversation (RSIAgent's persistent `messages`).

A run that ends without a usable handoff is answered in the same session (RSIAgent's same-context continuation). Three consecutive runs without any tool action end the phase as unscored infrastructure, as in RSIAgent; a ceiling bounds runaway phases. After a pi compaction, the role's next message re-pins its opening brief verbatim and re-offers memory retrieval (RSIAgent `_memory_revisit`). Role transcripts are saved as pi session files under the lineage record (open one with `pi --session <file>`).

### Isolation

`verifier.isolation` (default `auto`):

- `sandbox`: every Verifier shell command runs under bubblewrap with the whole filesystem read-only, a fresh `/tmp`, its own process namespace, harness-private paths (memory, lineage records, pi sessions, `auth.json`) masked, and a private writable scratch directory (`$RSI_SCRATCH`) that persists across its commands. Chosen only when a preflight shows bubblewrap really confines a write; an explicit `sandbox` fails loudly otherwise.
- `rollback`: the Verifier's commands are unconfined; the harness restores the candidate afterwards. File tools still refuse private paths and the shell refuses commands that name them, but a determined command can reach them.
- `auto`: `sandbox` when available, otherwise `rollback`.

In every mode the Verifier has no `write`/`edit` tool, and the candidate is checkpointed before an inspection (and before evidence probes run) and restored if it changed; files that existed before are never deleted. In lineages, every role sees only its own tree of the lineage workspace: a wave's Actors cannot see sibling projects, and the Curriculum sees its authoring roots but not project roots (with bubblewrap this is a mount mask; otherwise the file tools enforce it). Network access is not isolated: the Verifier is told never to mutate live services.

Host-side `git` (change facts, checkpoints) never runs repository-planted programs: hooks, fsmonitor, external diff, and the filter, diff, and textconv drivers the repository defines are disabled.

## Tools and commands

| tool | used by | purpose |
|---|---|---|
| `rsi_memory_list` / `rsi_memory_read` / `rsi_memory_search` | Actor, Curriculum (unless `curriculumMemoryAccess: none`) | inspect memory (the draft, during a learning phase) |
| `rsi_memory_write` / `rsi_memory_delete` | Actor, learning phase only | edit the draft |
| `rsi_submit` | main Actor | request independent verification; pass `evidence_leads` (claim + probe pairs) after an UNVERIFIED |
| `rsi_learn` | main Actor | open the learning phase after a terminal verdict |
| `rsi_memory_commit` | main Actor | first call: reconcile; second call: promote atomically |
| `rsi_explore` | main Actor | run a `broad` or `deep` lineage (blocks until it ends) |
| `rsi_notes` | Curriculum | replace its private search notes (never shown to the Actor or Verifier) |

Commands: `/rsi` (status: mode, memory, isolation, task state, commits, lineages), `/rsi-freeze`, `/rsi-unfreeze` (checks the frozen tree hash first), `/rsi-explore broad|deep|stop`, `/rsi-eval <lineage>`. Flag: `--rsi-mode learn|frozen|off`.

## Configuration

pi-rsi reads `~/.pi/agent/rsi.json`, then `<project>/.pi/rsi.json` when the project is trusted; objects merge key by key, arrays and values replace. Every key is optional:

```json
{
  "mode": "learn",
  "memoryDir": "",
  "stateDir": "",
  "promptInventory": 40,
  "persistRoleSessions": true,
  "roles": {
    "verifier": { "provider": "<provider id>", "model": "<model id, as /model lists it>" },
    "escalation": { "provider": "<provider id>", "model": "<model id>", "thinking": "high" }
  },
  "memory": { "maxFileBytes": 65536, "maxTotalBytes": 4194304, "maxFiles": 400, "keepHistory": true },
  "audit": { "sealedTexts": [], "shingleWords": 8 },
  "verifier": {
    "isolation": "auto",
    "allowUnverified": true,
    "taskMessages": 3,
    "tools": ["read", "grep", "find", "ls", "bash"],
    "checkpointMaxBytes": 268435456,
    "checkpointMaxFiles": 20000,
    "hiddenPaths": []
  },
  "transport": { "actionlessLimit": 3, "ceiling": 24 },
  "exploration": {
    "waveCeiling": 16,
    "waveConcurrency": 1,
    "broadProjectBudget": 12,
    "deepPracticeBudget": 6,
    "targetCycleBudget": 6,
    "unverifiedRounds": 3,
    "targetResumes": 1,
    "branchRetries": 1,
    "stopPolicy": "curriculum_review",
    "curriculumMemoryAccess": "read_only"
  },
  "evaluation": { "command": [], "timeoutSec": 900, "retries": 2 }
}
```

- `mode`: `learn`, `frozen` (Phase 3 test-time reuse; learning tools are deactivated), or `off`.
- `memoryDir` / `stateDir`: empty means `~/.pi/agent/rsi/projects/<project>-<hash>/{store,…}`, outside the project.
- `roles`: optional model routes; empty fields inherit the session's current model and thinking level. A different Verifier model strengthens independence. When `escalation` is set, a resumed target Actor uses it; when it equals the Verifier route, that segment's Verifier takes the Actor route once.
- `audit.sealedTexts`: material memory must never quote (e.g. held-out evaluation tasks); any 8-word overlap quarantines the commit.
- `evaluation.command`: argv of a sealed evaluator for `/rsi-eval`. It runs in a private copy of the final candidate with `RSI_CANDIDATE_ROOT` and `RSI_TASK_FILE` set and prints `{"score": n}` as its last line; memory is frozen first and its tree hash is checked before and after. The result is written to disk for the human and never reaches an agent.

## State on disk

```
~/.pi/agent/rsi/projects/<project>-<hash>/
  store/      memory/ (the canonical tree), drafts/, journal.jsonl, reports/, history/, frozen.json
  work/       role-visible lineage roots (its own git repository that ignores itself)
  lineages/   private lineage records: lineage.json, events.jsonl, result.json, captures,
              snapshots, curriculum notes, checkpoints, role transcripts (sessions/)
  results/    sealed evaluation runs
  scratch/    per-role scratch directories
```

`tree_sha256` over memory is byte-compatible with RSIAgent's `explore/memory_hash.py`.

## Differences from RSIAgent

- **Tool-using roles, not one-program-per-turn.** RSIAgent's Actor emits one Python/Bash program, look, or `done` per turn inside a VM; pi roles use pi's tools and hand off with their final reply. The handoff tokens (`STATUS: SUBMIT`, `VERDICT:`, `DECISION:`, the wave JSON envelope) and the transport rules are RSIAgent's.
- **Processes, not VMs.** Fresh roles get fresh sessions and fresh project roots, not fresh machines. bubblewrap masks private paths and sibling projects and makes the Verifier read-only, but network, other processes outside the sandbox, and anything the main pi agent can reach are shared. Run pi in a container for stronger isolation.
- **Evidence probes** run once on the host (read-only in the sandbox, under the checkpoint otherwise) rather than as the Actor's validated `done` checks.
- **A stalled Phase 2 practice project** (repeated UNVERIFIED or an actionless Actor) ends the lineage as infrastructure, as in RSIAgent; memory committed by earlier experiences stays.
- **Lineages are not resumable** after a restart; interactive learning phases are.
- **Forks**: a verdict is learned once across a session and its forks; the first promotion wins.

## Development

```sh
npm install
npm run typecheck
npm test                 # unit + in-process pi integration tests (faux model)
npm run e2e              # the real pi CLI against a scripted OpenAI-compatible mock server
```

The integration tests run real pi sessions with pi-ai's faux provider; the sandbox tests run only where bubblewrap works.

## License

Apache-2.0. See [NOTICE](NOTICE) for attribution to RSIAgent and dsh-rsi.
