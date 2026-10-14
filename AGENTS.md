# Assess this evaluator

Read README.md, criteria/criteria.json, cases/reference-review.json and the fixture manifests first. Stages 0 and 1 are implemented; quality qualification belongs to stage 2.

The canonical repository-local orientation is [incept-ela-evaluator](.agents/skills/incept-ela-evaluator/SKILL.md).

## Blind boundaries

- Read only this repository, the public contract/library in incept-ela-learning-truths, and finished public lesson-context/question-set packets.
- Never read the question-generator repository, its prompts, drafts, examples, logs or selection internals.
- Keep evaluator implementation and development cases here. Never copy them into generator inputs or shared teaching exports. Keep independent gold labels and sealed tests outside public repositories.
- Never open or print key, token or env files. A live adapter consumes only a launch credential; run a model only when explicitly authorized.
- Development observations, passing code checks, agreement between model samples and absence of detected defects do not establish academic approval.
- Preserve source quotes, versions, conditions and counterevidence. Abstain on unsupported operations.

## Verify

Run each command separately; all must exit 0 before a commit:

```sh
npm test
npm run check
```

Run the reference with Node 18.18 or later using `node bin/evaluate.mjs`. No installation or sibling checkout is required. Preserve test results and source hashes. Mock tests verify integration, not model accuracy.

Useful feedback names the case or file, identifies the defect or missing scope, cites what the learner sees and gives a reproducible check. Distinguish confirmed source faults, conditional concerns and unknowns. This handover covers packaging; do not start research, model-heavy work or HTML reports.
