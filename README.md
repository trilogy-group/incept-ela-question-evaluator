# Incept ELA question evaluator

> **Questions must test the intended knowledge in lesson context; trust the evaluator only for criteria and conditions supported by independent human judgments on cases kept out of tuning.**

A standalone evaluator for finished questions and lesson sequences. It checks supplied fields, prepares blind review packets and can collect explicitly authorized model observations. **No real scope is qualified to approve question quality.**

Read [AGENTS.md](AGENTS.md) before changing it. Teaching knowledge and shared formats come from [incept-ela-learning-truths](https://github.com/trilogy-group/incept-ela-learning-truths). The evaluator reads finished teaching packets; generator code, prompts, drafts and selection logs stay outside this lane. Independent gold labels and sealed tests stay outside public repositories.

## What earns trust

- **Better questions:** demonstrate a specific repair against the source, task purpose and rubric. Correcting a misquote or missing scoring requirement does not demonstrate improved learning.
- **Better process:** preserve complete learner context, blind solving, source versions, first-attempt results and replayable comparisons. Passing software tests demonstrates implementation behaviour.
- **Better evaluator:** measure missed defects, false flags, abstentions and repeated-run variation against attributable human decisions on complete learner packets. Include both defects and accepted designs; keep duplicate groups and tuning examples out of the held-out set. Compare with a strong ordinary AI review given the same context before claiming superiority.

Reuse existing human judgments before requesting new review. Resolve missing context and conflicting rulings; feedback status and model-produced rules are not labels. Repeated AI agreement is not correctness. The current certificate gate covers exact reviewed packets, not unseen generated questions; generalization and learning gains remain unmeasured.

**Context is part of the review.** An optional public `instructional-plan/0.1` declares the lesson's purpose, target authority, ordered teaching, response/feedback events, support and expected response evidence. Target authority is the producer's declaration, not externally authenticated course approval. Text solving receives only the declared learner preview and prior task opportunities, without author keys, future teaching or teacher evidence claims. A separate whole-sequence review considers knowledge selection, evidence coverage, preparation, support transitions, exposure, focus/load and the limits of the claims. It runs before item reviews in each fresh-process draw. Native trials run the sequence review only; they do not probe each activity's semantic correctness.

Prior teaching is not automatically answer leakage. Guided practice can reuse a model; a diagnostic can probe untaught knowledge. Explicit disclosure of a particular task answer conflicts with an explicit withheld-answer policy. Missing purposes, required conditional exposure and unsupported individual/mastery claims produce holds. Context completeness is not verified: extra returned event references are not reconciled with exposure holds, and unsupported passive native nodes can be omitted from the preview. An all-yes model review still gives **no academic approval**.

## Start here

Node 18.18 or later; no installation, credential or sibling checkout is needed. Replay receipts record the actual runtime used.

```sh
npm test
npm run check
node bin/evaluate.mjs --help
node bin/evaluate.mjs
```

The default runs the included **40-unit historical reference**, pinned to source commit `3ed708e` and [knowledge-v1](https://github.com/trilogy-group/incept-ela-learning-truths/tree/knowledge-v1). It returns 40 unverified items and repeats the code checks in fresh processes. This archive stays fixed when the current teaching source changes.

Use the same runner for every input below. Each command selects one route; unknown, duplicate, incomplete or conflicting options fail before evaluation. It also runs from another working directory when given the path to `bin/evaluate.mjs`. New outputs remain private under `.local/` by default; earlier runs cannot be overwritten.

## Choose the input

### Finished native activities

For a `native-activity-transport/0.2` directory:

```sh
node bin/evaluate.mjs --native-package /path/finished-native --native-source-pin <source-sha256>
```

This preserves native task types, checks source/context bindings and prepares key-blind review, separate author proposals, field observations and whole-sequence design review. With an explicit plan, event content defines the learner preview; citing an asset does not expose its entire text. Without one, phase sources remain declared availability. Unsupported field interpreters fail explicitly. Add `--config config.lesson.json --mode development --judge jev` and/or `--side-judge gemini-flash` for an authorized repeated sequence trial. It uses the same frozen worker as text lessons. Per-format semantic correctness, actual learner exposure, served UI and runtime marking remain unverified.

### Finished text lesson

The directory contains `course-request.json`, `course-source-packet.json`, `lesson-context.json` and `question-set.json`:

```sh
node bin/evaluate.mjs --lesson-package /path/finished --config config.lesson.json --course-pin <request-sha256>
```

This checks declared placement, knowledge references, source anchors and joined pairing rows. A supplied instructional plan resolves task purpose, prior teaching and response/feedback events before review. Prior tasks are planned opportunities, not proof that a learner attempted them. Teacher goals, course constraints and expected evidence enter design review separately from blind solving. Learner descriptors do not establish readiness.

If a finished packet returns `sequence_plan`, its two copies, canonical public input hash, task conditions and expected-evidence references are checked independently. Field pointers must resolve under `/view/`; their role as learner response evidence is not checked, and an existing author-key field can pass. The declared return also enters the separate sequence review. Matching declarations and existing pointers establish field consistency; the model must still judge what the task actually elicits. Legacy packets without this extension remain accepted with their context limits explicit.

The preview supports passive `nodes` followed by `question_slots`: single-best choices/evidence selection, one-category classification and open responses. Other response rules need an appropriate interpreter. Outputs include:

- `lesson.txt` and `lesson-audit.json`: the proposed sequence and its field checks.
- `review-packet.json`, `review-a.json`, `review-b.json`: blank independent review forms with author keys withheld.
- `solver-packet.json` and `author-fields.json`: separately held solving/editorial data and author intent.
- `source-assets.json`: supplied asset text/hash consistency, with absent declarations undetermined.
- `instructional-context.json` and `sequence-review-packet.json`: resolved teaching conditions, unknowns and the separate full-sequence design review; both are hash-pinned.
- `quote-diagnostics.json`: feedback spans compared with supplied text, including ambiguity and limited source scope; no quotation or item verdict.
- `criterion-sources.json` and `manifest.json`: source limits, input/build/configuration hashes and replay settings.

For the original shared `lesson-context 0.1` / `question-set 0.1` reference profile:

```sh
node bin/evaluate.mjs --context /path/lesson-context.json --set /path/question-set.json
```

### Authored reference and assessment history

The current authored teaching collection is the user-designated primary positive reference. This designation does not supply independent criterion labels.

```sh
node bin/evaluate.mjs --golden-reference /path/capture --out .local/golden/current
node bin/evaluate.mjs --golden-check .local/golden/current --golden-pin <manifest-sha256>
```

Preparation retains exact source bytes, task/context identities, field observations, separate controlled fault variants and pending quality assessments. Use `--reference-tier secondary` for lower-priority source candidates; source inputs and finished assessments remain distinct.

Preserve existing testing or assessment artifacts with the check command:

```sh
node bin/evaluate.mjs --golden-check .local/golden/current --assessment /path/report.json --assessment-kind integration-test --assessment-relation related-diagnostic
```

Kinds are `integration-test`, `source-review`, `model-development`, `human-review`, `generator-context-coverage` and `manual-notes`. Relations are `same-reference`, `related-diagnostic`, `historical` and `generated-candidate`. Assessment bytes are retained in a hash-linked journal. Retain the returned manifest and journal pins separately. Imported claims are not admitted labels or transferred verdicts. These commands make zero model calls.

### Retained example collection

```sh
node bin/evaluate.mjs --corpus /path/question-examples --catalog-sha256 <catalog-sha256>
```

This verifies source-file hashes, checks authored answer fields and prepares a passage-choice pilot. Unsupported operations, missing media or antecedents remain excluded with reasons. A derived choice packet does not certify its native lesson.

## Models and trust

Default execution makes zero model or academic API calls. Live review requires explicit authorization and launch credentials. Never commit credentials or raw private results.

Further live generation or generator/evaluator comparison trials are on hold until the user assigns a different generator owner and an expected-label custodian outside both halves. Freeze expectations before judges run. Historical work by one agent across both halves does not establish independent validation.

```sh
node bin/evaluate.mjs --judge jev
node bin/evaluate.mjs --judge jev --mode development
node bin/evaluate.mjs --judge jev --mode development --side-judge gemini-flash
```

The first command considers every supported criterion but calls Jev only where [qualification](criteria/jev-qualification.json) clears. **No real scope clears yet, so it currently makes zero calls.** Development uses the [partial profile](criteria/jev-profile.json): classification placement/alternatives and explicit open-response rubric requirements, 125 of 543 checks across 13 archive units. Other semantic checks remain unavailable. `--profile jev-full-experimental` enables the broader development probe.

Supply `TYPESAFE_API_KEY` at launch; `TYPESAFE_MODEL` selects the requested Jev model. The profile checks reported serving identity and complete samples. Qualified use requires a fixed model and verified serving revision. An alias does not establish an immutable revision.

Gemini Flash uses launch `MAAT_API_TOKEN` or `TFY_API_KEY`; its default TFY-EU route is `gemini-group/gemini-3.8-flash`. `GEMINI_FLASH_MODEL` can select the approved primary alias. MAAT resolves an existing active personal/development VAT without creating or enabling keys. An explicitly authorized launch file can be supplied with `--env-file /path/authorized.env`; approved settings are parsed without executing or retaining credentials.

Text and corpus model trials also require `--mode development`. Text trials separate blind solving from stateless feedback/rubric review, then compare author intent afterward. Corpus trials retain identical-input and rotated-choice draws separately. Fresh processes retain samples, serving observations, disagreements, abstentions and gateway-reported cost when supplied. Uncertainty or conflicting samples prevent a decisive criterion. A Google writer and Gemini reviewer share a model family.

The [99% policy](criteria/jev-qualification.json) requires independent held-out human labels, zero observed misses/abstentions and a 99% lower accuracy bound for sound and defective cases at 95% joint confidence. With zero misses, at least 368 distinct independent cases are needed in each group; repeats do not increase that sample. See the [exact binomial method](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).

Private signed studies and externally trusted reviewer public keys are selected in `config.json`. The current gate binds the exact reviewed packet, build, model, serving revision and sample settings. It can only re-judge packets that already have a signed human label; disagreement with that label makes the model verdict unavailable. Qualification for unseen questions is not implemented. Whole-item approval and future-question accuracy remain open. Code checks, source matches, author-key agreement and model agreement do not establish academic accuracy or learning gains.

## Independent human review

```sh
node bin/evaluate.mjs --review prepare --out .local/pilot
node bin/evaluate.mjs --review reconcile --bundle .local/pilot/bundle.json --review-a .local/pilot/review-a.json --review-b .local/pilot/review-b.json --out .local/pilot-labels
node bin/evaluate.mjs --review score --bundle .local/pilot/bundle.json --labels .local/pilot-labels/labels.json --draws /path/draw-1/report.json,/path/draw-2/report.json
```

The archive pilot contains 125 checks across 13 units. Reviewers supply their own alias, independence declaration, verdict and rationale. Identity/independence need external confirmation; blanks, disagreements and uncertainty stay pending. These public, correlated cases are not a fresh sealed holdout. Scoring verifies input/build/profile/label bindings and keeps absent model answers unmeasured. Model-specific preparation uses both `--review-model` and `--reported-model`.

## Existing reviewer feedback

With `FEEDBACK_KEY` supplied in the launch environment:

```sh
node scripts/read-feedback.mjs --out .local/feedback/NEW --checklist true
```

This separate source reader uses only allowlisted GET routes on [Course Feedback](https://feedback.inceptapi.com/). It walks report and item cursors, reads report details and visible invariant versions, and optionally reads checklist history. Output is a new private directory; credentials and signed screenshot URLs are omitted. It never opens a draft, files feedback or changes triage.

Read `receipt.json` before using the capture. Exit 2 means a required read is incomplete or endpoints disagree; recovered report-detail items remain in `reconciled-items.json`. Access is limited to the key owner's visibility. Published invariants retain their course scope; draft rules, reviewer text, fix notes and statuses remain separate observations.

Use existing human judgments for retrospective development cases before requesting new reviews. Reconstruct the reviewed question, preceding teaching and relevant response history; group duplicate findings and keep later rulings. “Fixed”, “verified” and a published rule do not supply an independent whole-question label. Ask academics only about unresolved decisions or a small targeted sample. Qualification still needs independent held-out evidence.

## Evidence and maintenance

This README is the human entry point. On a working checkout, `.local/current.json` points to the latest private evidence index. Earlier run directories retain source snapshots and receipts; they are historical evidence, not separate work plans.

[Reference observations](cases/reference-review.json) contain 14 source-backed development findings and zero independent human gold labels. [Reference trial evidence](evidence/reference-pilot.json) records fresh-process variation and the documented classification fault. [Collected-example evidence](evidence/corpus-pilot.json) retains field findings and the corrected 39-case model pilot; its controls and repeated answers remain development evidence.

[Route metadata](criteria/route-checks.json) links emitted checks to exact frozen learning records and their scope, limits and counterevidence. Transport integrity applies to the emitted operation without making a teaching-quality claim. Supplied purpose is passed to item metadata; purpose alone does not resolve every source rule's applicability. Missing purpose remains undetermined. Sequence metadata currently reports applicability from purpose alone even when separate holds remain; that annotation does not establish that the teaching conditions are satisfied. Source links do not qualify a judge.

The [evaluator skill](.agents/skills/incept-ela-evaluator/SKILL.md) covers orientation and optional general academic source lookup. Source retrieval never creates question labels or automatically changes criteria. Run `npm test` and `npm run check` separately before committing. The checker scans home paths and credential-shaped values; personal-name coverage requires an explicitly supplied external `--name-list` file.

Next: reconstruct complete lesson and learner packets behind existing human judgments, then measure these item and sequence reviews against them. The regression suite checks context transport, blind boundaries, missing-data holds, replay and verdict aggregation; it does not establish that a model judges instruction correctly. Request targeted academic review for unresolved decisions, then qualify a fixed model and scope against independent held-out evidence. Keep final holdouts sealed and the generator/evaluator owners separate.
