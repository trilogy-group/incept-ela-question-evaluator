# Incept ELA question evaluator

This starter checks a lesson's question sequence. Code checks structure and answer fields; an optional model answers one question per criterion using the supplied lesson context. **It has not been qualified to judge question quality.** Read [AGENTS.md](AGENTS.md) before reviewing or changing it.

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

For an authorized live run, provide `TYPESAFE_API_KEY` in the launch environment and add `--judge jev`. The key is never printed or saved; offline execution ignores it. This revision has not had a live model run. A service alias or reported revision is not yet a verified fixed model version.

## Reference results and cases

The reference contains **40 units** from the authored Othello 1.1 lesson at source commit `3ed708e`; [the fixture manifest](fixtures/reference/manifest.json) records the hashes. Code-only execution returns **40 unsure, unverified**, with identical code checks across two complete repeats. Without a model, required checks of meaning are unavailable. The exact content and conditional feedback seen by a learner have not been verified.

[cases/reference-review.json](cases/reference-review.json) contains **14 development observations**: strengths, confirmed faults, conditional concerns and unknowns, each with source evidence and limits. There are **zero independent human gold labels**. These observations do not approve whole items. The original source review is in [fixtures/source-reviews](fixtures/source-reviews); [criteria/criteria.json](criteria/criteria.json) links checks to knowledge records.

## Stages

- **Stage 0:** shared formats, the reference example, rules and a passing check.
- **Stage 1:** run the evaluator on the reference and produce a valid question set in the generator. This starter reports structure checks and abstentions; neither half claims quality.
- **Stage 2, next:** add model generation and qualify the evaluator against independent human labels. Each half needs a different owner.

Qualification needs complete learner packets, independent labels, an agreed scope and acceptance thresholds for each format, and repeated full runs on a fixed model version. Repeated code results do not establish correctness.

The repository checker detects literal home paths and credential-shaped values. To check a list of personal names, supply an external JSON file with `--name-list`; otherwise that check is unavailable.
