# Assess this evaluator

Read README.md, criteria/criteria.json, cases/reference-review.json and the fixture manifests first. Stages 0 and 1 are implemented; quality qualification belongs to stage 2.

The canonical repository-local orientation is [incept-ela-evaluator](.agents/skills/incept-ela-evaluator/SKILL.md).

Apply the README's opening principle and [What earns trust](README.md#what-earns-trust) to every change and progress claim. Distinguish demonstrated item repairs, process reliability and measured judgment accuracy. A model's own verdicts cannot establish its qualification; a certificate for reviewed packets cannot qualify unseen questions.

## One lane

Keep human-facing documentation in README.md and agent instructions in the existing skill and instruction files. Use `.local/current.json` as the pointer to private evidence; preserve earlier run receipts and source snapshots. Update existing sections instead of adding competing plans, status reports or handover documents. Prioritize the evaluator's existing-judgment casebook and qualification work.

## Blind boundaries

- Read only this repository, the public contract/library in incept-ela-learning-truths, and finished public lesson-context/question-set packets.
- Never read the question-generator repository, its prompts, drafts, examples, logs or selection internals.
- Keep evaluator implementation and development cases here. Never copy them into generator inputs or shared teaching exports. Keep independent gold labels and sealed tests outside public repositories.
- Never open or print key, token or env files. A live adapter consumes only a launch credential; run a model only when explicitly authorized.
- Further live generation or generator/evaluator comparison trials are on hold until the user assigns a different generator owner and an expected-label custodian outside both halves. Expected labels must be frozen before any judge runs. The user assigns these roles; an agent must not declare itself independent. Historical work by one agent across both halves is not independent validation.
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
