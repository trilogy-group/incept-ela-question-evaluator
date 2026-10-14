import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditLessonAlignment, digest, lessonReviewPacket, loadLessonPackage } from "../src/lesson-package.mjs";

// Arbitrary transport data only: no retained candidate content or actual source keys.
function fixture() {
  const phases = [
    { id: "F-ORIENT", after: [] },
    { id: "F-TEACH", after: ["F-ORIENT"] },
    { id: "F-GUIDED", after: ["F-TEACH"] },
    { id: "F-INDEPENDENT", after: ["F-GUIDED"] }
  ];
  const assets = Array.from({ length: 14 }, (_, i) => ({ id: `source-${i + 1}`, text: `Fixture source sentence ${i + 1}.` }));
  const request = {
    course_context: {
      source_assets: assets,
      core_knowledge: assets.map((_, i) => ({ id: `target-${i + 1}` })),
      content_keys: assets.map((_, i) => ({ id: `content-${i + 1}` })),
      pairing_tables: [{ id: "fixture-pairs", pairs: assets.map((_, i) => ({ id: `pair-${i + 1}` })) }],
      lesson_plan: { phases }
    },
    sequence_blueprint: []
  };
  const context = {
    contract: "lesson-context 0.1", source: {},
    lesson: { id: "fixture-lesson", title: "Portable fixture", learning_question: "What does the supplied fixture text show?", keywords: [] },
    native: { pages: [
      { id: "F-ORIENT", nodes: [{ type: "learning_question", text: "Read each supplied sentence before answering." }] },
      { id: "F-TEACH", nodes: [{ type: "learning_question", text: "A source sentence can be quoted exactly." }] },
      { id: "F-GUIDED", nodes: [] },
      { id: "F-INDEPENDENT", nodes: [] }
    ] }
  };
  const set = { contract: "question-set 0.1", source: {}, lesson: context.lesson.id, made_by: { kind: "authored" }, items: [] };
  for (let i = 0; i < 14; i++) {
    const phase = i < 7 ? "F-GUIDED" : "F-INDEPENDENT", pageIndex = i < 7 ? 2 : 3;
    const page = context.native.pages[pageIndex], nodeIndex = page.nodes.length, open = i === 13;
    const alignment = { phase_ref: phase, target_refs: [`target-${i + 1}`], source_refs: [assets[i].id],
      content_key_refs: [`content-${i + 1}`], pair_refs: [`pair-${i + 1}`], role: open ? "explain" : "check", support: i < 7 ? "guided" : "none" };
    const prompt = `What does fixture sentence ${i + 1} show?`;
    let native, pointer, view;
    if (open) {
      native = { question: prompt, criteria: [{ id: "fixture-criterion", requirement: "PRIVATE_RUBRIC_SENTINEL", accept: ["PRIVATE_ACCEPT_SENTINEL"] }], reveal: "PRIVATE_REVEAL_SENTINEL" };
      page.nodes.push({ type: "independent", rubric: native });
      pointer = `/pages/${pageIndex}/nodes/${nodeIndex}/rubric`;
      view = { prompt, rubric: structuredClone(native) };
    } else {
      native = { q: prompt, options: ["Fixture option one", "Fixture option two"], answer: 0,
        why: ["PRIVATE_FEEDBACK_SENTINEL", "PRIVATE_FEEDBACK_SENTINEL"], yes: "PRIVATE_CORRECT_FEEDBACK_SENTINEL" };
      page.nodes.push({ type: "reading", blocks: [{ lines: [assets[i].text] }], mcqs: [native] });
      pointer = `/pages/${pageIndex}/nodes/${nodeIndex}/mcqs/0`;
      view = { stem: prompt, options: [...native.options], key: [0], option_feedback: [...native.why], correct_feedback: native.yes };
    }
    set.items.push({ id: `arbitrary-task-${i + 1}`, page: phase, order: i + 1, kind: open ? "open_check" : "reading_mcq",
      pointer, native: structuredClone(native), view, alignment, source_anchors: [{ source_ref: assets[i].id, quote: assets[i].text }] });
    request.sequence_blueprint.push({ formats: [open ? "short_explanation" : "source_choice"], position: { page: phase, alignment: structuredClone(alignment) } });
  }
  return { request, source: { assets: structuredClone(assets) }, context, set };
}
const runAudit = ({ request, set, context }) => auditLessonAlignment(request, set, context);
const check = (audit, id) => audit.checks.find(row => row.id === id);

test("finished lesson transport verifies the exact external course pin and rejects a changed request", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-package-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { request, source, context, set } = fixture();
  for (const [name, value] of [["course-request", request], ["course-source-packet", source], ["lesson-context", context], ["question-set", set]]) {
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value) + "\n");
  }
  const coursePin = digest(fs.readFileSync(path.join(directory, "course-request.json")));
  const loaded = loadLessonPackage(directory, { coursePin });
  assert.equal(loaded.external_course_pin_verified, true);
  assert.equal(loaded.set.items.length, 14);
  assert.equal(loaded.hashes["course-request.json"], coursePin);
  assert.equal(loadLessonPackage(directory).external_course_pin_verified, false);
  assert.throws(() => loadLessonPackage(directory, { coursePin: "0".repeat(64) }), /external pin/);
  fs.appendFileSync(path.join(directory, "course-request.json"), " ");
  assert.throws(() => loadLessonPackage(directory, { coursePin }), /external pin/);
});

test("all fourteen planned targets may follow instruction-only prerequisite phases", () => {
  const data = fixture(), audit = runAudit(data);
  assert.equal(data.set.items.some(item => ["F-ORIENT", "F-TEACH"].includes(item.page)), false);
  assert.equal(audit.status, "structural_alignment_checked");
  assert.equal(check(audit, "all_teaching_phases_present").verdict, "pass");
  assert.equal(check(audit, "every_planned_question_phase_represented").verdict, "pass");
  assert.equal(check(audit, "every_planned_target_referenced").verdict, "pass");
  assert.equal(audit.academic_approval, false);
  assert.ok(audit.items.every(item => item.factual_entailment === "requires independent review"));
});

test("source anchors require an unchanged quote in a known asset used by that item", () => {
  const mutations = [
    item => { item.source_anchors[0].quote = "Altered fixture sentence."; },
    item => { item.source_anchors[0].source_ref = "unknown-source"; },
    item => { item.source_anchors[0] = { source_ref: "source-2", quote: "Fixture source sentence 2." }; }
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data.set.items[0]);
    const audit = runAudit(data);
    assert.equal(audit.status, "needs_revision");
    assert.ok(audit.items[0].issues.includes("source_anchor_not_exact_in_declared_asset"));
  }
});

test("unknown course references and lost target coverage cannot pass placement checks", () => {
  for (const field of ["target_refs", "source_refs", "content_key_refs", "pair_refs"]) {
    const data = fixture(); data.set.items[0].alignment[field] = ["unknown-reference"];
    assert.ok(runAudit(data).items[0].issues.includes(`missing_or_unknown_${field}`));
  }
  const data = fixture(); data.set.items[13].alignment.target_refs = ["target-1"];
  const audit = runAudit(data);
  assert.equal(check(audit, "every_planned_target_referenced").verdict, "fail");
  assert.deepEqual(check(audit, "every_planned_target_referenced").evidence.missing, ["target-14"]);
  assert.ok(audit.items[13].issues.includes("differs_from_planned_target_refs"));
});

test("nested planned placement, roles, support and the actual prerequisite page order are enforced", () => {
  const misplaced = fixture(); misplaced.set.items[0].alignment.phase_ref = "F-INDEPENDENT";
  const first = runAudit(misplaced).items[0];
  assert.ok(first.issues.includes("unknown_or_wrong_phase"));
  assert.ok(first.issues.includes("item_page_differs_from_declared_phase"));
  const changed = fixture(); changed.set.items[0].alignment.role = "unplanned-role"; changed.set.items[0].alignment.support = "none";
  const issues = runAudit(changed).items[0].issues;
  assert.ok(issues.includes("role_differs_from_plan"));
  assert.ok(issues.includes("support_differs_from_plan"));
  const missing = fixture(); missing.context.native.pages = missing.context.native.pages.filter(page => page.id !== "F-TEACH");
  const absent = runAudit(missing);
  assert.equal(check(absent, "all_teaching_phases_present").verdict, "fail");
  assert.ok(absent.items[0].issues.includes("prerequisite_phase_not_yet_present"));
  const reversed = fixture(); [reversed.context.native.pages[1], reversed.context.native.pages[2]] = [reversed.context.native.pages[2], reversed.context.native.pages[1]];
  assert.ok(runAudit(reversed).items[0].issues.includes("prerequisite_phase_not_yet_present"));
});

test("academic review exposes supplied tasks and text while withholding answers, rubrics and conditional feedback", () => {
  const { context, set } = fixture(), packet = lessonReviewPacket(context, set);
  assert.equal(packet.items.length, 14);
  assert.equal(packet.source_key_and_feedback_withheld, true);
  assert.match(packet.items[1].seen_before, /Fixture source sentence 1\./);
  assert.equal(packet.items[0].task.question, set.items[0].view.stem);
  assert.deepEqual(packet.items[0].task.options, set.items[0].view.options);
  assert.equal(packet.items[13].task.question, set.items[13].view.prompt);
  assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_/);
  const forbidden = new Set(["key", "answer", "answer_index", "rubric", "criteria", "reveal", "feedback", "option_feedback", "correct_feedback", "producer", "made_by", "source_anchors"]);
  const inspect = value => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { assert.equal(forbidden.has(key), false, key); inspect(child); }
  };
  inspect(packet);
  assert.ok(packet.items.every(item => Object.values(item.review).every(value => value === null)));
});

test("different producer and task identities leave the same blind review packet and hashes", () => {
  const first = fixture(), changed = structuredClone(first), identity = "PRIVATE_PRODUCER_SENTINEL";
  changed.set.made_by = { kind: "generated", note: identity };
  changed.set.source = { generator: identity };
  changed.context.source = { generator: identity };
  changed.context.native.metadata = { producer: identity };
  for (const item of changed.set.items) {
    item.id = `private-task-${item.order}`;
    item.view.producer_id = identity;
    item.native.metadata = { generator: identity };
    const parts = item.pointer.split("/").slice(1);
    let target = changed.context.native;
    for (const part of parts) target = target[part];
    target.metadata = { generator: identity };
  }
  const original = lessonReviewPacket(first.context, first.set), blind = lessonReviewPacket(changed.context, changed.set);
  assert.deepEqual(blind, original);
  assert.doesNotMatch(JSON.stringify(blind), /PRIVATE_|private-task-/);
  assert.equal(new Set(blind.items.map(item => item.id)).size, 14);
});
