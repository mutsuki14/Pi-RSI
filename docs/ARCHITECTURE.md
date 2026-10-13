# Architecture

pi-rsi has two layers.

- **Engine** (`src/engine`, `src/memory`, `src/roles`, `src/protocol`): depends on no harness. It holds the role prompts, the transport parsers, the memory store, fixtures, and the lineage state machines, behind the `RoleRuntime` seam (`src/engine/types.ts`).
- **Host** (`src/host`, `src/index.ts`, `src/config.ts`): the pi adapter. It implements `RoleRuntime` with in-process pi sessions, isolates role sessions, runs the interactive Actor protocol on the main session, and registers the tools, commands, and prompt sections.

## Source map

| Path | Responsibility | RSIAgent counterpart |
|---|---|---|
| `src/protocol/tokens.ts` | Unique standalone `VERDICT:` / `DECISION:` / `STATUS:` tokens, ignoring fences and indented code | `practice_loop._parse_unique_handoff`, `verifier._parse_agentic_verifier_report` |
| `src/protocol/wave.ts` | Wave JSON envelope (`WAVE` / `SATURATED` / `STALLED`), id rules, `<PROJECT_ROOT>` requirement | `phase1_wave.parse_wave_handoff` |
| `src/memory/hash.ts` | Canonical JSON and `treeSha256` (byte-compatible) | `explore/memory_hash.py` |
| `src/memory/store.ts` | Canonical tree, persisted drafts with base manifests, limits at write and commit time, pending-commit record before a stage-and-rename install, journal, history, quarantine, content-addressed reports, freeze, crash recovery, cross-process lock | `practice_loop._atomic_install_memory`, `commit.journal`, Phase 3 frozen-memory checks |
| `src/memory/audit.ts` | Optional word-shingle leakage tripwire; a hit quarantines the commit | `commit.silent_audit` |
| `src/roles/*.ts` | Epistemic core, memory preamble (inventory only), lifecycle memory re-offers, Actor / Verifier / Curriculum charters, runtime contracts, resume messages, distillation, reconciliation, diagnosis | `core/actor.py`, `core/verifier_runtime.py`, `explore/charter.py`, `loop._memory_revisit` |
| `src/engine/converse.ts` | Same-context continuation: re-prompt the same session until it publishes a parseable handoff; consecutive actionless segments end the phase as transport infrastructure; a ceiling bounds runaway phases | `_run_handoff_phase` transport loop |
| `src/engine/fixtures.ts` | Fixture shape gate, private capture with manifest, byte-exact replay, read-only original-fixture view | `phase1_wave` fixture capture / replay, Phase 2 original view |
| `src/engine/steps.ts` | `STATUS: SUBMIT` handoffs, CLAIM/PROBE leads as LEAD blocks with a harness classification, one inspection, same-context learning (distill → reconcile → diagnosis → commit) | `_run_handoff_phase`, `loop.py` lead blocks, `_promote_learning` |
| `src/engine/lineage.ts` | Phase 1 waves (snapshot, barrier, serial learning); Phase 2 attempts with a persistent Verifier, UNVERIFIED rounds, stall → forced inspection → resume, escalation route and Verifier swap; stop policies; `result.json`; per-role visible trees; private checkpoints | `phase1_wave.py`, `core/self_evolving_loop.py`, `unified_evolution.evolve_until_ready` |
| `src/engine/workspace.ts` | Project manifests and change context for the Verifier, whole-tree fingerprints, exact copies | `loop._surface_delta` |
| `src/host/role-runtime.ts` | `RoleRuntime` on `createAgentSession`: role system prompt, tool allow-list, no extensions/skills/context files, model route, memory tools bound to the engine's `MemoryBinding`, path guards, sandboxed bash, per-role scratch, truncation continuation, compaction re-pin, usage accounting, persisted transcripts | a fresh VM plus model client per role |
| `src/host/sandbox.ts` | bubblewrap preflight, read-only (Verifier) and visibility (lineage Actor/Curriculum) sandboxes, private-path and sibling-project guards with physical path resolution | `verifier_runtime` effect-isolated namespaces |
| `src/host/probes.ts` | Runs Actor-proposed evidence probes once, after the checkpoint, and classifies them | Done-check execution and lead classification |
| `src/host/checkpoint.ts` | Interactive candidate checkpoint (one listing method, stat-first sizing, detect-only above the caps) and a restore that never deletes pre-existing files | `_verify_candidate` rollback |
| `src/host/git.ts` | Git that runs no repository-planted program while honouring global and system configuration; interactive change facts | `_surface_delta` |
| `src/host/task-state.ts` | Interactive task state folded from state-tool `details` on the current session branch | Actor/Verifier loop state |
| `src/host/interactive.ts` | `rsi_submit`, `rsi_learn`, `rsi_memory_commit`, and the main session's memory tools | the target Actor/Verifier loop |
| `src/host/explore.ts` | Lineage requests, engine configuration, progress text | `run_osworld.py` / `run_ale.py` lineage drivers |
| `src/host/sealed.ts` | Sealed evaluation of a private final-candidate copy, checked against its digest, on frozen memory | official evaluator, `officialEvaluatorCalls = 0` during training |
| `src/host/stores.ts` | Per-project state roots under the pi agent directory, outside every project; self-ignoring work root | per-run memory directory |
| `src/index.ts` | Extension entry: flag, config, mode-dependent active tools, `rsi_protocol` / `rsi_memory` prompt sections, memory re-offers after compaction and resume, `rsi_explore`, commands, status line | host harness |

## Authority boundaries

| Role | Can | Cannot |
|---|---|---|
| Actor | work with pi's tools; read memory; write the **draft** during learning | change canonical memory directly; grade itself; see sibling projects (lineages) |
| Verifier | inspect the live candidate with read and execute tools, read-only in the sandbox (or under rollback); keep a private scratch; publish one verdict | see memory, harness-private paths, the Actor's conversation, self-checks, or handoff narrative; write or edit files; delegate |
| Curriculum | build fixtures in its own authoring roots; read memory as evidence (unless `none`); keep private notes; choose the next experiment or stop | write or approve memory; grade candidates; see project roots; author solutions or checks |
| Host | capture and replay fixtures, checkpoint and restore candidates, run evidence probes, commit memory at valid boundaries, run the sealed evaluator | turn infrastructure failures, readiness, or `STALLED` into a verdict |

## Invariants

1. **Memory is immutable during work.** Writes go to a draft opened from the current canonical tree. A draft whose base is no longer canonical is refused (`MemoryConflictError`); the interactive Actor relearns against current memory. Commits are serialized across processes.
2. **Wave barrier.** No branch of a wave learns until every branch has a verdict. A branch whose runtime fails before a verdict gets one unscored restart; transport exhaustion or a second failure blocks the whole wave and no memory is merged.
3. **Infrastructure is unscored.** A session that never publishes a parseable handoff, consecutive actionless segments, a failed start, or a provider failure raises `InfraError`. It is never PASS or FAIL and never commits memory; lineages record it in `result.json`.
4. **A FAIL teaches but never counts as success.** Both outcomes distill, and the outcome is recorded in the journal.
5. **Readiness is not correctness.** `READY_FOR_TARGET` returns control to the target; after any practice, a fresh target attempt is mandatory, also when the practice budget runs out. `STALLED` buys exactly one final target test.
6. **Verification has no lasting effects.** Every candidate is checkpointed before an inspection (and before evidence probes) and restored if it changed; with `sandbox` isolation the Verifier cannot write at all.
7. **Sealed means sealed.** The evaluator runs only on a frozen candidate copy, from a human command, and its result is written to disk for the human.
8. **Roles hear only the harness.** Role sessions load no extensions, skills, or context files; only the engine sends them messages.
9. **Memory installs are recoverable.** A pending-commit record precedes every install; recovery either journals an installed tree or drops an install that never happened.
10. **Lineage ids are unique.** Episode ids derive from the lineage id, so a reused id is refused rather than mistaken for an already promoted experience.

## Why sessions instead of a handoff tool

dsh-rsi needed a parked `rsi_handoff` tool call to keep one sub-agent context alive across harness-driven phases. pi's SDK already gives the harness a conversation it can prompt repeatedly: `session.prompt()` resolves when the run ends, and the next `prompt()` continues the same context. A role's handoff is therefore just its final reply, exactly like RSIAgent's per-turn text, and the engine's same-context continuation, stall accounting, and learning phases map one-to-one onto pi runs.
