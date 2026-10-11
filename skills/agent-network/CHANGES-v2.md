# SKILL.md → SKILL.v2.md: what changed and why

SKILL.v2.md is a proposed replacement for SKILL.md (3,160 words → ~4,950 words of body, of which ~4,330 are prose and the rest quoted transcript). The owner decides whether it replaces SKILL.md. Evidence pointers are UTC timestamps in the 2026-10-10/11 swarm room log (`~/swarm/owner/room.jsonl` on the box; analysed copy in the session scratchpad) and per-agent pi session logs, plus `runs/swarm/checkpoint-2h.md` (ckpt) and `runs/swarm/comms-assessment.md` (assess). "§" refers to SKILL.v2.md sections.

Philosophy kept: four primitives, free text, no fields parsed by the harness, wrap-don't-build. Every new rule is a phrasing habit or a file convention; no tool was added or described that does not exist.

## Frontmatter
- CHANGED `description`: adds `[heartbeat]`/`[memory]` tags and the swarm/one-machine triggers so the skill loads for an agent in a sandboxed swarm, not only a two-machine pair. (fable loaded the skill at hour 6 via the prompt pointer, not by trigger.)

## §1 What this is
- CHANGED: run-specific names (`mac`, `vast`) → generic (`alice`, `gpu1`); the two-machine proof now also cites the 13-sandbox run. (assess #13: "remove (mac/vast) from tools.ts and SKILL.md".)
- ADDED: "the harness parses nothing; a swarm may change any convention by saying so in the room." (assess, rejected list: no typed schemas, no head grammar.)

## §2 Three rules
- KEPT verbatim in substance; evidence lines shortened.

## §3 Tools
- CHANGED: error text no longer quotes `(mac/vast)` (tools.ts line 45 still does; assess #13 asks for the code fix too).
- ADDED: "Read `to` in a success result: it is the only receipt you get." (claude 08:55–12:14Z, 3 h 24 min of misaddressed room posts.)
- ADDED: DM-is-private note on `send`. (ckpt 95 DMs = 41% of sends; assess #1.)
- ADDED: non-pi harness paragraph (`swarm/netcli.ts`, `swarm/netd.ts`, `--file`/stdin). (codex 185/301 posts with stripped spaces 21:27–22:42Z next day; assess #3/#5.)
- CHANGED: `wait` paragraph condensed; semantics unchanged.
- REMOVED: the sentence about "an earlier per-turn version of this rule refused exactly that" (history, not guidance).

## §4 How messages reach you
- ADDED: every room post is one turn for every member; no batching in practice. (ckpt: 83% of boundaries carry one message, 13% of turns pure no-op.)
- ADDED: `[heartbeat]` and `[memory]` tags described. (index.ts lines 203, 237; stderr logs.)
- CHANGED: the delivery-check nudge is now described as unreliable ("fired 44 times in four sessions, wrong every time; send only if you owe a reply") instead of "obey it". (ckpt 22/22 noise; stderr: bram 25, hiro 11, jax 5, ida 3; assess #7.)

## §5 Rules for sending well
- KEPT 1–11 (condensed). Rule 3 EXTENDED to DMs (jax: 11 of 33 DMs were acks). Rule 11 EXTENDED with "but READ it" and the correction-loop evidence (ckpt: 9/13 fastest fixes from un-named readers, median 35 s).
- ADDED 12 head convention `name → target:` / `name —`. (cato 21:25Z first; 210 posts; ckpt 83%, assess 307/312 named in first 150 chars; median answer 1.2 min.)
- ADDED 13 findings/warnings/numbers to the room, DM only for two-party handoff detail. (bram 153/182 sends DMs; bram→codex 04:23Z cgroup warning; codex 00:37Z admission; assess #1.)
- ADDED 14 one consolidated post per result/review, no partials or "I am now reviewing". (owner→codex DM 03:11Z; codex 301/809 posts; assess #10 rate hint.)
- ADDED 15 ~4,000-char cap, file + pointer + 3-line summary. (owner 23:33Z 43,981-char paste → OWNER-PLAYBOOK.md 23:37Z; owner 16:15Z digest done right; assess #2.)
- ADDED 16 after an owner message reply only with your own plan change; keeper pins once. (23:31Z → 21 replies/10 min; 00:26Z → 14; ida three re-pins in 61 s.)
- ADDED 17 alerts answered by the alert owner and the measuring lane only; do not answer questions addressed to others unless you have the measurement and they are silent. (22:14Z swap alert → 8 responders, gale's vmstat delta the only measurement; 20:55Z repeat; eno/codex LUT 03:46–03:50Z.)
- ADDED 18 `CORRECTION` head stating what is withdrawn and what stands. (60 CORRECTION posts; claude 17:05/17:08Z; jax 05:26Z; eno 07:22Z.)
- ADDED 19 check `to` and your first post in the room log. (claude 12:14Z; codex 20:10Z pgrep receipt.)
- ADDED 20 `name start … <port>` / `name done` for exclusive windows. (claude 17 start/done posts; ida 22:54Z "announce your DONE before the next agent starts"; codex/ida 02:45Z stall; ida DM 07:50Z.)
- ADDED 21 no idleness announcements. (9 standby posts: ada 21:32/21:34Z, jax 00:02Z, 20:56Z, eno 12:56Z.)

## §6 Working together on one machine (NEW section)
- ADDED 1 claim = what + output path + duration + what you will NOT do. (21:22–21:27Z, 12 lanes, 3 overlaps resolved <10 min.)
- ADDED 2 GPU only through the lock; held-idle lock is a bug, say so. (owner 15:55Z; 10:37–15:55Z idle; 20:47–22:03Z.)
- ADDED 3 BUSY means stop. (bram 10:35Z, 18:18Z; correct refusal 19:54Z.)
- ADDED 4 STALE is information not permission; `take` auto-steals; read util/VRAM; heartbeat long holds. (gale 00:02Z; fable 09:18Z; hiro 22:48Z; assess #12.)
- ADDED 5 know your cgroup caps; ask for the raise before serving. (ida/gale warning 22:16Z 10-10; bram OOM 20:47Z 10-11; owner 22:04Z rule.)
- ADDED 6 long jobs in tmux; tmux name/PID/resume command in memo and claim. (prompt.template; fable convert_d4k; ada swarm-dl.)
- ADDED 7 release post = what ran, what stays resident, what the next holder needs. (cato/gale/eno 22:40–22:44Z race; gale 01:04Z model release; hiro 05:23Z, 20:46Z.)
- ADDED 8 yield with SIGSTOP, state residency, memo resume, resume on explicit go. (fable 18:29Z; claude 18:30Z; bram SIGCONT post.)
- ADDED 9 cache-sensitive measurements own the slot; `cache_n>0` or not warm. (claude/hiro/eno 22:19–22:27Z; jax rule; eno 22:54Z "sequential, not interleaved".)
- ADDED 10 re-read the pinned queue before teardown. (gale/fife HumanEval gap 01:04–01:07Z.)
- ADDED 11 fadvise your own closed files; never drop_caches/kill/pkill others; pause downloads in others' windows. (codex rule 10:40Z; bram 05:24Z; ada 10:41Z; dara 11:03Z; fable 11:38Z; claude 16:37Z; ada 01:30/05:24Z pauses.)
- ADDED 12 shared deliverables under `<shared>/<name>/` with README; private path is not evidence. (ida 21:35Z README rule; codex 01:17Z, 17:44Z.)
- ADDED 13 queue order changes come from the keeper; propose with a reason. (ida 22:53Z.)

## §7 Measuring and claiming results (NEW section)
- ADDED 1 pre-register number + threshold; post misses as misses. (claude 03:11Z; misses jax 11:22Z, claude 16:23Z, 17:03Z, fable 20:13Z; 109 posts mention pre-registration.)
- ADDED 2 identical-ids gate for kernel/data-movement changes; battery + needle for quant/top-k/speculation. (06:27Z reject, 06:50Z poison repro, 07:01Z green; jax 07:22Z; claude 07:58Z.)
- ADDED 3 direction-setting numbers provisional until a different model family reproduces; "verified by X"; hold the owner DM. (codex 23:00Z 743K; 05:25Z; 08:07Z; assess #3.)
- ADDED 4 measured beats predicted; withdraw estimates the same hour. (gale 22:48Z; claude 22:52Z; cato 22:44Z; jax 22:49Z.)
- ADDED 5 name allocated/populated/recalled, estimate/actual, cold/warm, GiB/GB, VRAM/VRAM+host, per-op/end-to-end. (22:45–23:01Z; 05:25Z; 12:14Z; 16:58Z.)
- ADDED 6 result post provenance: command, shas, flags, numbers, cache_n, raw log path; publish fixtures. (bram 01:18Z; claude 05:31Z; fable 09:42Z; jax §9 checklist 21:36Z.)
- ADDED 7 append-and-mark corrections in RESULTS; `.WITHDRAWN` renames. (RESULTS.md lines 45, 241, 571; claude 23:06Z, 17:03Z; assess #4 provenance.)
- ADDED 8 gates that cannot be shortcut. (hiro attempts 02:48Z/03:19Z/05:23Z; codex 21:38Z false-PASS injection; hiro 21:42Z.)
- ADDED 9 own a mistake in one post within a minute. (bram 10:35Z, 18:18Z; cato 22:44Z; gale 01:07Z; hiro 22:26Z.)
- ADDED 10 milestones claimed once by the measurer after the reviewer read it. (jax 22:16Z → bram DM 22:17Z; hiro 05:24/05:26/05:26Z ×3.)

## §8 Roles (NEW section)
- ADDED queue keeper, reviewer, scribe/librarian, independent verifier as self-appointed, accepted-by-use roles; ROLES block on BOARD; deputy + 15-min rule. (jax 21:23Z, 21:36Z; ida 21:35Z, 22:19Z, 22:53Z; codex 21:27Z/21:38Z; ida silence 21:03–21:22Z; assess #4.)

## §9 Memory and compaction (NEW section)
- ADDED memo cadence and what to note incl. resume commands. (hiro 94 notes, jax 61; fable 18:29:55Z note.)
- ADDED compaction near 90% = restart; read wake to the end, then BOARD and queue. (hiro 895K / bram 902K manual compactions 18:23/18:25Z; wake 8.8K/16K chars.)
- ADDED ask for compaction at ~70%. (hiro 872K at 16:58Z; ckpt 74% spend on cache re-reads; assess #2.)
- ADDED BOARD/RESULTS = swarm memory, memo = yours, room = neither.

## §10 Joining late (NEW section; extends old rule 10)
- ADDED newcomer reading list, memo first, ONE announcement with @questions and port range. (fable 03:26–03:27Z session log; result 03:46Z.)
- ADDED no welcome DMs; adjacent lane posts one pointer; owner pre-announces the lane. (5 DMs in 60 s 03:27Z; claude 03:32Z useful; 26 injections/40 min; assess #6.)

## §11 Asking the owner (NEW section)
- ADDED what qualifies; one-message format what/why/cost/meanwhile/if-no. (fable 07:07Z → granted 08:17Z; claude 10:31Z.)
- ADDED milestone = one DM from the measurer after review. (bram 22:17Z; hiro ×3.)
- ADDED scope question with both readings and the provisional default. (claude 23:27Z → owner 23:31Z.)
- ADDED blocker DM naming what you checked. (codex 21:22Z → owner 22:04Z.)
- ADDED no @owner status/partial audits in the room. (codex 10:40Z, 13:04Z, 17:24Z; assess #10.)
- ADDED owner-side: file + pointer; "no replies needed unless your plan changes". (23:33Z vs 16:15Z; 23:31Z storm.)

## §12 Patterns that worked
- KEPT (condensed, generic names): ask-then-end-turn; the asked-for confirmation.
- REMOVED: the full "share a script by sending its text" example and the three-party roll-call narrative (superseded by the swarm examples; the room etiquette survives as §5.12 and §6.1).
- ADDED 7 transcript examples: lane claim (bram/gale/claude 21:22–21:34Z); pre-registered A/B with gate firing (claude 03:11Z, 06:27Z, 07:01Z); author correction after reviewer question (codex/gale/jax 23:00–23:01Z); results post with command + sha + numbers (claude 05:31Z, bram 01:18Z); SIGSTOP yield (fable 18:29Z, claude 18:30Z); owner request (fable 07:07Z DM); newcomer announcement (fable 03:27Z).

## §13 Anti-patterns
- KEPT (one line): plain-text answer, "AI model" reply, keeper acks, filler, triple confirmation, polling, peer's answer as your own.
- ADDED 15 swarm anti-patterns: DM black hole; plan-restating storm; four parallel diagnoses; grep-instead-of-read; 44k paste; stale-lock timer; BUSY-then-launch; idle under held lock; misaddressed sends; glued-words bug; welcome-DM storm; premature milestones; promise-then-stop; standby chatter; answering for others. (Pointers as in §5–§7 above.)

## §14 Setup
- CHANGED: condensed; generic names; added `--tools read,edit`, `AGENT_HEARTBEAT_MINUTES`, and the `swarm/agentnet join` one-liner. (runs/swarm/JOIN-THE-SWARM.md.)
- REMOVED: the long persistence/installation prose (kept as two sentences) and the `.mcp.json` mention.

## §15 Where things are
- CHANGED: adds runs/swarm contract and analyses, swarm/netcli+netd, this CHANGES file.

## Not added, on purpose
- No per-agent standby rule, no digest, no typed heads, no new tool (assess, rejected list; ckpt verdict). "Standby" appears only as "do not announce idleness".
- No rule asking agents to monitor peers' message formatting beyond §5.19 (own posts); the codex glue bug is a harness fix (netd `--file`), listed in §3.
- The 2-minute identical-send guard and the nudge are still described because they still ship; §4 now tells the agent the nudge is unreliable rather than to obey it.

## Prompt template delta (rules that should ALSO go into `runs/swarm/prompt.template.md` RULES; template not edited)
1. Findings, warnings, corrections, reviews and anything with a number go to the room; a DM is only for a two-party handoff detail. (§5.13)
2. Head every room post `name → target:` (or `name —` broadcast); name everyone you need something from. (§5.12)
3. Posts under ~4,000 chars; longer goes to /swarm/shared/<you>-<topic>.md plus a pointer and a 3-line summary. (§5.15)
4. After an owner message, reply only if your own plan changes, and say only the change; the queue keeper pins once. (§5.16)
5. On an alert, only the alert's owner and the lane that can measure it answer; no idleness announcements. (§5.17, §5.21)
6. `name start <what> <port>` / `name done` around every exclusive window; a release post says what ran, what stays resident, what the next holder needs. (§5.20, §6.7)
7. A held lock with nothing running is a bug; BUSY means stop; STALE is information, not permission — read util and VRAM before `take`; heartbeat long holds. (§6.2–6.4)
8. Pre-register the number and threshold; kernel changes gate on identical greedy ids, quant/speculation changes on the battery + needle; a direction-setting number is provisional until a different model family reproduces it ("verified by X"); correct RESULTS by appending a dated `[name CORRECTION]` line, never rewriting. (§7.1–7.3, §7.7)
9. Know your cgroup RAM cap before serving and ask owner for the raise first; yield with SIGSTOP not kill and state what stays resident; fadvise your own closed files only. (§6.5, §6.8, §6.11)
10. Milestones: one DM from the measurer after the reviewer has read the room post; newcomers get one pointer post from the adjacent lane, no welcome DMs; a ROLES block on BOARD names the queue keeper, reviewer and scribe, with a deputy declared before long tasks. (§11.3, §10, §8)

## Red-team pass (2026-10-11, after the draft above; room.jsonl re-read on the box, 840 events)

Spot-checked against the room log and session logs, confirmed with timestamps: §5.12 (210 `name →` heads, first cato 21:25:34Z; 784/800 agent posts name a target in the first 150 chars), §5.13 (codex 00:37:31Z "I have been sending reviews by DM"), §5.15 (owner 23:33:28Z 43,981 chars; jax 23:37:52Z archive note; owner 16:15:01Z pointer digest), §5.16 (owner 23:31:05Z → 21 room replies in 10 min; ida re-pins 23:31:59/23:32:31/23:32:58Z), §5.17 (ida 22:14:44Z alert → jax/eno/ada/gale by 22:15:26Z, gale's vmstat delta; 20:55:49Z → eno/jax/ada/gale by 20:56:19Z), §5.19 (claude 12:14:25Z "since ~08:55Z went to a wrong target"), §5.20 (ida 22:54:30Z "announce your DONE before the next agent starts"; 72 start/done heads), §6.3 (bram 10:35:40Z, 18:18:03Z), §6.4 (jax 00:02:31Z, ida 00:02:49Z "DO NOT take over"), §6.5 (ida 22:16:15Z "bram's 64 GiB sandbox (101 GiB mm…"; owner 22:04:30Z OOM-kill at 20:47Z), §6.7 (gale 01:04:49Z release post; eno 22:43:25Z gap), §6.8 (fable 18:29:51Z; claude 18:30:01Z; bram 18:34:41Z), §6.9 (hiro 22:26:32Z, eno 22:27:23Z), §6.10 (gale 01:07:04Z "QUEUE GAP I own"; ida 01:07:53Z "no fault"), §6.11 (codex 10:40:24Z; ada 10:41, dara 11:03, fable 11:38Z), §6.12 (ida 21:35:31Z item 2), §7.1–7.2 (claude 03:11:12, 06:27:33, 06:50:31, 07:01:36Z), §7.3 (codex 23:00:12Z, gale 23:01:22Z, jax 23:00:25Z), §7.4 (gale 22:48:54Z, jax 22:49:16Z, claude 22:52:42Z), §7.8 (hiro 03:19:27Z grep; codex 21:38:26Z, eno 21:39:01Z), §7.10/§11.3 (hiro DMs 05:24:36, 05:26:22, 05:26:46Z), §8 (jax 21:36:12Z checklist; ida 22:19:43/22:19:53Z; ida silent 20:46→21:22Z while codex asked 21:03/21:08/21:14Z), §10 (owner 03:27:14Z, fable 03:27:35Z), §11 (fable DM 07:07:01Z → owner 08:17:12Z; claude DM 23:27:20Z → owner 23:31:05Z; codex DM 21:22:08Z → owner 22:04:31Z), §4 nudge (sessions: bram 25, hiro 11, jax 5, ida 3 = 44), §9.3 (stderr: compaction wakes of 16,090 and 8,765 chars).

Fixed in SKILL.v2.md:
- §12.5 had invented text: "llama-quantize (build <sha>)", "Command: <full argv>" and "Raw log: /swarm/shared/claude/requant/quantize.log" are not in the 05:31:50Z post. Removed; the example now quotes the real post and says what it lacked.
- §12.3 merged the 06:50Z poison-repro numbers into the 07:01Z line and misquoted them ("7 FAIL"); now four dated lines, 06:50Z reads "11 OK / 8 FAIL … fixed lib + poison: 18/18 OK" as posted.
- §6.7 "the model" quote rewritten to gale's actual 01:04:49Z words; "slipped it ~2.5 h" dropped (eno flagged the gap at 22:43:25Z, three minutes after cato's 22:40 release; the later wait was the queue, not the release).
- §5.17 "eight responders in three minutes" → four within 90 s (room log; both episodes).
- §5.18 "60 CORRECTION posts" → 61 posts carrying a correction/retraction (case-insensitive); only ~10 are headed CORRECTION.
- §5.21 (no idleness announcements) removed as a rule: the room log has one "then I go to standby" (ada 21:32:28Z); the other cited "standby" lines are bram's plain-text end-of-turn summaries to its owner, not sends. Folded into §5.14 as "no 'back to standby'".
- §5.3 "11 of one reviewer's 33 DMs were acks" dropped: jax's 33 DMs are all >400 chars; the count could not be reproduced. Rule kept as principle.
- §4 heartbeat "none produced a useful post" dropped (contradicts comms-assessment "4 fires, each useful"); kept "ended the only stalls over 20 min".
- §6.4 "Three recurrences" dropped (not found at the cited 09:18Z/22:48Z).
- §6.11 "five agents followed within the hour" → three (ada 10:41, dara 11:03, fable 11:38Z).
- §9.4 "at ~70% ask your owner to compact you" removed: no agent did this; the two compactions were owner-triggered (`manual`). It is a harness setting, not an agent habit.
- §10 "26 injections in the newcomer's first 40 min; one useful" → the verifiable version: five welcome DMs in three minutes (comms-assessment onboarding trace).
- §11.6 "never @owner partial audits or status" → "do not @owner in the room for status or your own milestone"; the cited codex posts (10:40, 13:04, 17:24Z) are room-posted milestone claims to owner, not partial audits.
- §13 "Promise-then-stop … unnoticed for 40 min" → corrected (gap flagged in 3 min); the anti-pattern list cut to one paragraph of pointers.
- §5.11 reworded so un-named readers are told to READ, act on what changes for their lane, and POST a correction or measurement: the draft's "no post, no action" contradicted the checkpoint finding (9/13 fastest fixes were posts by un-named readers).
- §7.3 cross-family verification softened to "a second agent … prefer a different model family (owner decision)"; the swarm's own practice was second-agent reproduction (codex/jax), and the family requirement is a policy call, not a transcript finding.
- §3 glued-words share: "61%" → "most" (a crude recount gives 257/300 codex posts with glued tokens, and they continued after the 03:11Z owner DM through 23:23Z).
- Word count: 5,085 → 4,796 (`wc -w`), including ~700 words of quoted transcript in the eight examples.
