# Incept ELA question evaluator

This starter checks a lesson's question sequence. Code checks structure and answer fields; optional Jev review checks selected claims against the supplied lesson context. **It has not been qualified to approve question quality.** Read [AGENTS.md](AGENTS.md) before reviewing or changing it.

Teaching knowledge and shared formats come from [incept-ela-learning-truths](https://github.com/trilogy-group/incept-ela-learning-truths) and its [contract](https://github.com/trilogy-group/incept-ela-learning-truths/tree/main/contract). This public repository contains the implementation and development cases. Generator work must not inspect or consume them. Independent gold labels and held-out tests belong outside this public repository. The evaluator reads finished lesson-context/question-set packets, without access to the generator's code, prompts, drafts or selection logs.

The shared input is pinned to [knowledge-v1](https://github.com/trilogy-group/incept-ela-learning-truths/tree/knowledge-v1). Runs record its digest from [fixtures/knowledge-baseline.json](fixtures/knowledge-baseline.json).

## Run: Node 18 or later, no installation

```sh
npm test
npm run check
node bin/evaluate.mjs
```

Run these commands from this repository. The evaluator also works from another directory when given the path to `bin/evaluate.mjs`. `config.json` selects the included reference, two complete repeats and three samples per model call. The default uses code only: no Python, credential, sibling repository or service is needed. [src/typed/manifest.json](src/typed/manifest.json) records the decision layer's source commit and file hashes.

Each run creates a separate private directory under `.local/runs/`. It stores the input packet with producer identity removed, hashes of the code and configuration, the Node version, two runs in fresh processes, journals, a report and repeat statistics. Earlier runs cannot be overwritten. Producer metadata is excluded from model inputs and packet hashes. A valid packet can still contain an operation the evaluator cannot assess.

Reports for the original native reference and text or native0.2 lessons link emitted checks to [route metadata](criteria/route-checks.json) and exact frozen learning records, including their limits and counterevidence. Transport integrity and coverage instrumentation stay distinct from quality judgments. Text and native0.2 preparation also save `criterion-sources.json`. Missing assessment purpose or unresolved applicability remains undetermined; source links do not qualify a judge.

For another finished public packet:

```sh
node bin/evaluate.mjs --context /path/lesson-context.json --set /path/question-set.json
```

The [evaluator skill](.agents/skills/incept-ela-evaluator/SKILL.md) provides repository orientation and optional academic source lookup guidance.

For Jev, provide `TYPESAFE_API_KEY` in the launch environment:

```sh
node bin/evaluate.mjs --judge jev
```

This considers every supported criterion and calls Jev only where the [99% qualification policy](criteria/jev-qualification.json) clears. **No real scope qualifies yet, so this command currently makes zero model calls.** Model probabilities and repeated development answers do not count as accuracy.

Qualification requires independent held-out human labels, zero observed misses or abstentions, and a 99% lower accuracy bound for both sound and defective cases, at 95% joint confidence. With zero misses, this needs at least 368 distinct cases in each group; repeats do not increase the sample. The [exact binomial method](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm) assumes the reviewed sampling units are independent.

Private signed studies and trusted academic reviewer public keys are selected in `config.json`. The gate binds the exact reviewed packet, build, sample settings, fixed model and verified serving revision. Changed or unseen packets cannot inherit qualification. A conflicting model verdict is discarded. This verifies reviewed packets; it does not promise perfect judgment on future questions. Gold-linked reports stay within the evaluator lane.

For explicit development testing:

```sh
node bin/evaluate.mjs --judge jev --mode development
```

This uses [criteria/jev-profile.json](criteria/jev-profile.json)'s partial profile:

- **Classification:** does the keyed placement fit, and could another offered placement also fit?
- **Open checks:** do the model answer and accepted examples meet each explicit rubric criterion?

This selects **125 of 543 criterion checks (23%) across 13 of the 40 reference units**. MCQ semantics, evidence selection, feedback, hints, readiness, difficulty and lesson alignment remain outside this partial route. Other semantic checks stay visible as `unavailable`. Code checks still run. Hidden classification meanings and unassessed hints are excluded from the partial packet. Neither development agreement nor absence of detected defects approves a whole question.

Development launch defaults to `jev-latest`; `TYPESAFE_MODEL` can select another advertised model. The partial profile accepts the reported development-trial ID, currently `jev-1.13.0`; changed or missing IDs, incomplete samples and uncertainty cannot pass. Qualified use requires a fixed model and reviewed serving revision. Credentials are excluded from run artifacts.

Add `--profile jev-full-experimental` in development mode to probe all supported criteria. The partial profile draws on 16 source-derived development cases; the broader stress controls and three reference repeats do not establish accuracy outside those cases.

For a separate Gemini Flash side review:

```sh
node bin/evaluate.mjs --judge jev --side-judge gemini-flash
```

Supply `MAAT_API_TOKEN` or a `TFY_API_KEY` at launch. MAAT resolves an existing active personal or development VAT; it does not create, rotate or enable keys. The default route is `gemini-group/gemini-3.8-flash` on TFY-EU. `GEMINI_FLASH_MODEL` may select the approved primary alias. For an explicitly authorized env file, add `--env-file /path/authorized.env`; only approved launch settings are read, without executing values or saving credentials.

The side judge covers all supported semantic checks and receives the finished packet and criteria without Jev's answers or human labels. Child processes receive only the requested adapters' launch settings and portable runtime settings. Separate journals and repeat statistics preserve disagreements and abstentions. Any categorical unsure draw stays unsure. Side answers are signals with unmeasured accuracy; agreement never changes the primary verdict or qualifies either model.

For a private development casebook, run `node scripts/test-jev.mjs --cases .local/path/to/cases.json`. This freezes an offline plan with zero calls. Add `--live --draws 5` for an authorized model run. Labels are stored separately from model inputs; reports include wrong approvals, wrong rejections, abstentions and variation between full runs. Cases and results stay under `.local/` and must not be passed to generator work.

## Complete lesson packages

The current authored collection is the default golden positive reference. Prepare its exact questions, context, field observations, controlled fault variants and pending quality assessments with the same runner:

```sh
node bin/evaluate.mjs --golden-reference /path/current-capture --out .local/golden/current
node bin/evaluate.mjs --golden-check .local/golden/current
```

For an additional lower-priority source, prepare a separate bundle with `--reference-tier secondary`. It remains a reference candidate, without inheriting the primary source's positive designation. Source hashes and assessment histories stay separate.

For a finished `native-activity-transport/0.2` package, prepare key-blind review tasks, separate author proposals and field observations:

```sh
node bin/evaluate.mjs --native-package /path/finished-native --native-source-pin <original-source-sha256>
```

This intake preserves native activity types and declared source availability. It prepares review for all current types; semantic judgment, actual learner exposure and quality remain pending. Unsupported family field interpreters remain explicit failures. It does not route native extensions through the older reference adapter.

Add `--assessment /path/report.json --assessment-kind model-development --assessment-relation historical` to the check command to preserve an existing assessment. Other kinds are `source-review`, `integration-test`, `human-review`, `generator-context-coverage` and `manual-notes`. Records are appended and hash-linked; retain the returned manifest and journal hashes separately. Historical and candidate observations do not become current reference verdicts. Quality evaluation remains pending. Preparation and checks use zero model calls. Private assessment records and fault variants stay in this evaluator; the generator consumes the original course/source reference.

The same runner accepts a finished text-lesson directory containing `course-request.json`, `course-source-packet.json`, `lesson-context.json` and `question-set.json`:

```sh
node bin/evaluate.mjs --lesson-package /path/finished --config config.lesson.json --course-pin <course-request-sha256>
```

It checks placement, planned knowledge references, source bindings and declared pairing relationships, then writes `lesson.txt`, a structured audit and two blank blind review forms. Supplied procedure, prior-teaching declarations and course constraints enter the separate editorial review; they do not enter independent solving or establish actual learner exposure. The supported preview has passive `nodes` followed by `question_slots`; it covers MCQ, evidence selection, classification and open responses. It does not certify a served player or runtime marker.

For authorized model trials, add `--mode development --judge jev --side-judge gemini-flash`. Three samples are repeated in three fresh processes with frozen inputs. Blind solving excludes intended keys, mappings, feedback and rubrics. Separate stateless calls review candidate feedback and rubrics. Any uncertain, failed or conflicting sample prevents a decisive criterion. Author-key comparisons join afterward. A Google writer and Gemini side reviewer share a model family. Reports include observed variation and any gateway-reported USD; independent academic accuracy remains unmeasured. Outputs stay private.

## Collected examples

Use the same runner for the private collection produced by the knowledge repository:

```sh
node bin/evaluate.mjs --corpus /path/question-examples --catalog-sha256 <catalog-sha256>
```

This verifies retained-file hashes, checks authored answer fields across every row and selects a passage-choice pilot. Unsupported operations, absent media and missing antecedents stay excluded with reasons. Original fields and source versions are preserved; the derived choice packet is not a native lesson evaluation. Outputs stay private, under `.local/` by default.

Add `--mode development --judge jev --side-judge gemini-flash` for explicitly authorized model testing. `config.json` sets samples and fresh-process draws. The first two draws use identical inputs; later draws rotate choice order. Every sample is retained. Any missing, unsure or conflicting sample prevents a decisive verdict. Models receive passage, question, choices and necessary learner instructions; authored keys, feedback, rubrics and producer identity are withheld. Source-key comparisons are added after the draws. Duplicate-choice and removed-passage controls are reported separately. Neither agreement nor repeatability establishes academic accuracy. When using `--env-file`, put `--` between `node` and `bin/evaluate.mjs` so Node leaves the launch file to the evaluator's filtered loader.

[The collected-example study](evidence/corpus-pilot.json) checked 4,172 representations and version variants: 3,443 had an explicit answer contract. It found 95 historical export ID collisions and one separate QTI key/association-limit conflict. These are source-field findings; live delivery remains unverified. The initial pilot exposed missing verse and unclear evaluator instructions; both were corrected before a separate rerun.

The corrected pilot used 39 source cases, eight altered controls, three samples and three fresh-process draws per judge. Jev gave the same verdict on 38 of 39 identical-input repeats; Gemini on 39 of 39. In the rotated draw, Gemini supported two later events in a question asking what happened “after.” The study does not separate sampling variation from answer-order effects. Both judges withheld unique approval on every duplicate-choice control and rejected answerability after passage removal. These observations remain unqualified; independent academic labels are still absent. Use [the study config](evidence/corpus-pilot-config.json) with `--config` to repeat its settings. Raw questions, keys and journals remain private.

## Reference results and cases

The reference contains **40 units** from the authored Othello 1.1 lesson at source commit `3ed708e`; [the fixture manifest](fixtures/reference/manifest.json) records the hashes. Code-only execution returns **40 unsure, unverified**, with identical code checks across two complete repeats. Without a model, required checks of meaning are unavailable. The exact content and conditional feedback seen by a learner have not been verified.

[cases/reference-review.json](cases/reference-review.json) contains **14 development observations**: strengths, confirmed faults, conditional concerns and unknowns, each with source evidence and limits. There are **zero independent human gold labels**. These observations do not approve whole items. The original source review is in [fixtures/source-reviews](fixtures/source-reviews); [criteria/criteria.json](criteria/criteria.json) links checks to knowledge records.

## Stages

- **Stage 0:** shared formats, the reference example, rules and a passing check.
- **Stage 1:** run the evaluator on the reference, optionally collecting explicit Jev/Gemini development signals, and produce a valid question set in the generator. Structure checks and observations are available; neither half claims quality.
- **Stage 2, next:** add model generation and qualify the evaluator against independent human labels. Each half needs a different owner.

Qualification needs complete learner packets, independent reviewed labels and repeated runs on a fixed version. The 99% gate applies to criteria, while whole-item academic approval remains open.

## Human review pilot

Prepare two blank, independent review sheets with the same runner:

```sh
node bin/evaluate.mjs --review prepare --out .local/pilot
```

The pilot contains 125 checks across 13 public reference units: classification and explicit open-response rubrics. Each reviewer fills their own alias, independence declaration, `verdict` (`yes`, `no` or `unsure`) and rationale. Source observations and expected polarity stay in a separate private file. Blank, disputed and unsure judgments remain pending. Reviewer identity and independence require external confirmation.

```sh
node bin/evaluate.mjs --review reconcile --bundle .local/pilot/bundle.json --review-a .local/pilot/review-a.json --review-b .local/pilot/review-b.json --out .local/pilot-labels
node bin/evaluate.mjs --mode development --out .local/pilot-run
node bin/evaluate.mjs --review score --bundle .local/pilot/bundle.json --labels .local/pilot-labels/labels.json --draws .local/pilot-run/draw-1/report.json,.local/pilot-run/draw-2/report.json
```

These commands make zero model calls. Scoring binds the input, build, profile, baseline and labels. Without reviewed labels and model answers, accuracy is unmeasured. For a declared Jev development study, prepare with both `--review-model <requested-model>` and `--reported-model <served-model>`, then run with `--judge jev --mode development`. Changed serving identities cannot be scored against the declared model. All pilot outputs stay private and unqualified. These correlated, previously public cases are not a fresh sealed holdout.

[The recorded development proof](evidence/reference-pilot.json) ran three fresh-process draws. Both judges flagged the documented “angry” placement problem each time: the key assigns it to Roderigo while earlier lesson content describes Iago as angry. Jev kept the same verdict on 123 of 125 selected checks; two varied. Gemini had 42, 159 and 147 unavailable checks across its draws. The evidence includes source, input and runtime digests, replay settings and limits. Academic accuracy remains unmeasured.

The repository checker detects literal home paths and credential-shaped values. To check a list of personal names, supply an external JSON file with `--name-list`; otherwise that check is unavailable.
