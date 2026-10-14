# Incept ELA question evaluator

This starter checks a lesson's question sequence. Code checks structure and answer fields; optional Jev review checks selected claims against the supplied lesson context. **It has not been qualified to approve question quality.** Read [AGENTS.md](AGENTS.md) before reviewing or changing it.

Teaching knowledge and shared formats come from [incept-ela-learning-truths](https://github.com/trilogy-group/incept-ela-learning-truths) and its [contract](https://github.com/trilogy-group/incept-ela-learning-truths/tree/main/contract). This public repository contains the implementation and development cases. Generator work must not inspect or consume them. Independent gold labels and held-out tests belong outside this public repository. The evaluator reads finished lesson-context/question-set packets, without access to the generator's code, prompts, drafts or selection logs.

## Run: Node 18 or later, no installation

```sh
npm test
npm run check
node bin/evaluate.mjs
```

Run these commands from this repository. The evaluator also works from another directory when given the path to `bin/evaluate.mjs`. `config.json` selects the included reference, two complete repeats and three samples per model call. The default uses code only: no Python, credential, sibling repository or service is needed. [src/typed/manifest.json](src/typed/manifest.json) records the decision layer's source commit and file hashes.

Each run creates a separate private directory under `.local/runs/`. It stores the input packet with producer identity removed, hashes of the code and configuration, the Node version, two runs in fresh processes, journals, a report and repeat statistics. Earlier runs cannot be overwritten. Producer metadata is excluded from model inputs and packet hashes. A valid packet can still contain an operation the evaluator cannot assess.

For another finished public packet:

```sh
node bin/evaluate.mjs --context /path/lesson-context.json --set /path/question-set.json
```

For an authorized live run, provide `TYPESAFE_API_KEY` in the launch environment:

```sh
node bin/evaluate.mjs --judge jev
```

This uses [criteria/jev-profile.json](criteria/jev-profile.json), a partial development profile:

- **Classification:** does the keyed placement fit, and could another offered placement also fit?
- **Open checks:** do the model answer and accepted examples meet each explicit rubric criterion?

Every other semantic check remains visible as `unavailable`: MCQ key meaning, evidence selection, feedback, hints, readiness and lesson alignment. Code checks still run. Reports count selected, requested and unavailable criteria; no whole question earns approval. Hidden classification meanings and unassessed hints are excluded from the partial judge packet.

The launch defaults to `jev-latest`; `TYPESAFE_MODEL` selects another advertised model. The partial profile accepts only the reported model ID exercised in the development trial, currently `jev-1.13.0`. A changed or missing ID, incomplete samples or uncertain answers cannot pass. That ID is a service observation, not an independently verified immutable revision. The credential is never saved; offline execution ignores it.

`--profile jev-full-experimental` retains the earlier all-criterion probe for explicit experiments. Its scope has not been qualified. The partial profile draws on 16 source-derived development cases; the broader stress controls and three reference repeats do not establish accuracy outside those cases. Independent academic labels are still needed.

For a private development casebook, run `node scripts/test-jev.mjs --cases .local/path/to/cases.json`. This freezes an offline plan with zero calls. Add `--live --draws 5` for an authorized model run. Labels are stored separately from model inputs; reports include wrong approvals, wrong rejections, abstentions and variation between full runs. Cases and results stay under `.local/` and must not be passed to generator work.

## Reference results and cases

The reference contains **40 units** from the authored Othello 1.1 lesson at source commit `3ed708e`; [the fixture manifest](fixtures/reference/manifest.json) records the hashes. Code-only execution returns **40 unsure, unverified**, with identical code checks across two complete repeats. Without a model, required checks of meaning are unavailable. The exact content and conditional feedback seen by a learner have not been verified.

[cases/reference-review.json](cases/reference-review.json) contains **14 development observations**: strengths, confirmed faults, conditional concerns and unknowns, each with source evidence and limits. There are **zero independent human gold labels**. These observations do not approve whole items. The original source review is in [fixtures/source-reviews](fixtures/source-reviews); [criteria/criteria.json](criteria/criteria.json) links checks to knowledge records.

## Stages

- **Stage 0:** shared formats, the reference example, rules and a passing check.
- **Stage 1:** run the evaluator on the reference, optionally using partial Jev review, and produce a valid question set in the generator. Structure checks and development observations are available; neither half claims quality.
- **Stage 2, next:** add model generation and qualify the evaluator against independent human labels. Each half needs a different owner.

Qualification needs complete learner packets, independent labels, an agreed scope and acceptance thresholds for each format, and repeated full runs on a fixed model version. Repeated code results do not establish correctness.

The repository checker detects literal home paths and credential-shaped values. To check a list of personal names, supply an external JSON file with `--name-list`; otherwise that check is unavailable.
