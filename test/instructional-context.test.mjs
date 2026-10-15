import test from "node:test";
import assert from "node:assert/strict";
import { resolveInstructionalContext, InstructionalContextError } from "../src/instructional-context.mjs";

// Deliberately small fictitious transports; these tests verify context plumbing, not academic labels.
function fixture() {
  const items = [1, 2].map(order => ({ id: `Q${order}`, order, page: `P${order}`, kind: "reading_mcq", pointer: `/pages/${order - 1}/question_slots/0`,
    alignment: { target_refs: ["K1"], role: "independent-response-check", support: "source visible" },
    view: { stem: `What does the fox do ${order}?`, options: ["crosses", "waits"], key: [0], correct_feedback: "AUTHOR_ONLY_CONFIRMATION", option_feedback: ["AUTHOR_ONLY_FEEDBACK", "AUTHOR_ONLY_FEEDBACK"] } }));
  const course = { core_knowledge: [{ id: "K1", claim: "The fox crosses the river.", performance: "Explain the stated action." }],
    source_assets: [{ id: "S1", kind: "text", text: "The fox crosses the river." }],
    prerequisites: [{ id: "P-READ", claim: "Read a short sentence.", status: "declared-only" }],
    knowledge_map: { nodes: [{ id: "P-READ", role: "prerequisite" }, { id: "K1", role: "core" }], edges: [{ from: "P-READ", to: "K1", relation: "supports", warrant: "proposed" }] },
    pairing_tables: [{ id: "TABLE", pairs: [{ id: "PAIR", target_ref: "K1", source_ref: "S1", rationale: "Text supports this proposed target." }] }],
    lesson_plan: { phases: [{ id: "P1", role: "instruction", target_refs: ["K1"] }, { id: "P2", role: "practice", target_refs: ["K1"] }] },
    instructional_plan: { version: "instructional-plan/0.1", id: "PLAN", lesson: { purpose: "practice", scope: "static-design", objective: "Explain a source-supported action.", goal_refs: ["K1"], purpose_note: "Practice after explicit teaching." },
      goal_authority: [{ goal_ref: "K1", kind: "packet-proposed", source_refs: ["S1"], note: "A proposed toy target." }],
      events: [
        { id: "E1", order: 1, before_item_id: "Q1", kind: "teaching", status: "declared", content: "Read the sentence and locate its verb.", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: ["K1"], provenance: "toy authored instruction" },
        { id: "E2", order: 2, before_item_id: "Q2", kind: "feedback", status: "conditional", content: "A correction may be shown after the first response.", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: ["K1"], provenance: "toy authored feedback route" },
        { id: "E3", order: 3, before_item_id: "END", kind: "teaching", status: "declared", content: "FUTURE_TEACHING_SENTINEL", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: [], provenance: "later instruction" }
      ],
      items: [1, 2].map(order => ({ item_id: `Q${order}`, purpose: "assessment", scope: "static-design", measurement_intent: "Supported application after instruction; not unexposed recall.", goal_refs: ["K1"],
        prior_event_refs: order === 1 ? ["E1"] : ["E1", "E2"], prepares_for_item_ids: order === 1 ? ["Q2"] : [],
        expected_evidence: [{ id: `R${order}`, goal_refs: ["K1"], claim: "Relates the verb to the action.", source_refs: ["S1"] }],
        support: { mode: "source-visible", event_refs: ["E1"], source_refs: ["S1"], answer_exposure: "allowed" } })),
      sequence: { goal_coverage: [{ goal_ref: "K1", item_ids: ["Q1", "Q2"] }], support_transitions: [{ from_item_id: "Q1", to_item_id: "Q2", reason: "Apply the same procedure again." }] } }
  };
  return { request: { course_context: course, sequence_blueprint: items.map(() => ({ role: "independent-response-check", support: "source visible" })), student_context: { grade: 8, language: "English", access_needs: "Text remains visible.", prerequisite_response_evidence: null }, known_constraints: ["Do not claim mastery."] },
    context: { lesson: { id: "TOY", learning_question: "What does the fox do?" }, native: { pages: [{ id: "P1", nodes: [{ type: "reading", blocks: [{ lines: [{ who: "Narrator", line: "The fox crosses the river." }] }] }] },
      { id: "P2", nodes: [{ type: "worked_instruction", line: "Read the source before you respond.", steps: [{ sentence: "Notice the verb.", think: "Use the words." }] }] },
      { id: "P3", nodes: [{ type: "instruction", text: "LEGACY_FUTURE_SENTINEL" }] }] } }, set: { items } };
}
function plan(pkg) { return pkg.request.course_context.instructional_plan; }
function fails(change, code) { const pkg = fixture(); change(pkg); assert.throws(() => resolveInstructionalContext(pkg), error => error instanceof InstructionalContextError && error.code === code); }

test("resolves purpose, complete design relationships and explicit teaching without certifying their authority", () => {
  const result = resolveInstructionalContext(fixture());
  assert.equal(result.whole_lesson.objective, "Explain a source-supported action.");
  assert.equal(result.whole_lesson.source_authority[0].kind, "packet-proposed");
  assert.equal(result.whole_lesson.knowledge_map.edges[0].warrant, "proposed");
  assert.equal(result.whole_lesson.pairing_tables[0].pairs[0].rationale, "Text supports this proposed target.");
  assert.equal(result.items[0].assessment_purpose.purpose, "assessment");
  assert.equal(result.items[0].design_context.expected_evidence[0].claim, "Relates the verb to the action.");
  assert.equal(result.items[0].learner_context.ordered_teaching[0].id, "E1");
  assert.equal(result.items[0].design_context.known_student_context.supplied.access_needs, "Text remains visible.");
  assert.equal(result.qualification, false); assert.equal(result.independent_gold_labels, 0);
});
test("prior task previews retain prompts and options but never author keys or feedback", () => {
  const result = resolveInstructionalContext(fixture()), learner = result.items[1].learner_context;
  assert.equal(learner.prior_tasks[0].task.stem, "What does the fox do 1?");
  assert.deepEqual(learner.prior_tasks[0].task.options, ["crosses", "waits"]);
  assert.equal(JSON.stringify(learner).includes("AUTHOR_ONLY"), false);
  assert.equal(Object.hasOwn(learner.prior_tasks[0].task, "key"), false);
});
test("future teaching and design expected evidence do not enter a learner preview", () => {
  const result = resolveInstructionalContext(fixture()), row = result.items[0];
  assert.equal(JSON.stringify(row.learner_context).includes("FUTURE_TEACHING_SENTINEL"), false);
  assert.equal(JSON.stringify(row.learner_context).includes("Relates the verb to the action."), false);
  assert.equal(row.design_context.future_teaching[0].id, "E3");
});
test("conditional feedback is held as unknown, not treated as shown or absent", () => {
  const result = resolveInstructionalContext(fixture()), second = result.items[1];
  assert(second.holds.includes("conditional_exposure_unresolved"));
  assert.equal(second.learner_context.declared_events.length, 0);
  assert.equal(second.learner_context.observed_events.length, 0);
  assert.equal(second.design_context.conditional_events[0].id, "E2");
});
test("supplied observed response/feedback claims are preserved without proving readiness or mastery", () => {
  const pkg = fixture(); plan(pkg).events[1].status = "observed"; plan(pkg).events[1].kind = "response";
  const result = resolveInstructionalContext(pkg), second = result.items[1];
  assert.equal(second.learner_context.observed_events[0].id, "E2");
  assert(second.learner_context.exposure_status.includes("not authenticated"));
  assert.equal(second.holds.includes("conditional_exposure_unresolved"), false);
});
test("target teaching is not automatically answer leakage, even for an assessment", () => {
  const pkg = fixture(); plan(pkg).items[0].support.answer_exposure = "withheld";
  const row = resolveInstructionalContext(pkg).items[0];
  assert.equal(row.design_context.prior_revealed_targets.length, 1);
  assert.equal(row.design_context.answer_exposure_conflict, false);
});
test("an explicit disclosed-item event conflicts only with an explicit withheld policy", () => {
  const pkg = fixture(); plan(pkg).events[0].disclosed_item_ids = ["Q1"];
  assert.equal(resolveInstructionalContext(pkg).items[0].design_context.answer_exposure_conflict, false);
  plan(pkg).items[0].support.answer_exposure = "withheld";
  const row = resolveInstructionalContext(pkg).items[0];
  assert.equal(row.design_context.answer_exposure_conflict, true);
  assert(row.holds.includes("declared_withheld_answer_exposure_conflict"));
});
test("conditional explicit disclosure remains an exposure unknown rather than a known leak", () => {
  const pkg = fixture(); plan(pkg).events[1].disclosed_item_ids = ["Q2"]; plan(pkg).items[1].support.answer_exposure = "withheld";
  const row = resolveInstructionalContext(pkg).items[1];
  assert.equal(row.design_context.answer_exposure_conflict, false);
  assert(row.holds.includes("conditional_exposure_unresolved"));
});
test("legacy inputs preserve page boundaries and known students but do not infer purpose from a phase name", () => {
  const pkg = fixture(); delete pkg.request.course_context.instructional_plan;
  const result = resolveInstructionalContext(pkg), second = result.items[1];
  assert.equal(second.assessment_purpose.state, "undetermined");
  assert(second.holds.includes("assessment_purpose_missing"));
  assert.deepEqual(second.learner_context.ordered_teaching.map(event => event.page_ref), ["P1", "P2"]);
  assert.equal(JSON.stringify(second.learner_context).includes("LEGACY_FUTURE_SENTINEL"), false);
});
test("legacy explicit slot purpose is recognized and individualized claims stay held", () => {
  const pkg = fixture(); delete pkg.request.course_context.instructional_plan; pkg.request.sequence_blueprint[0].assessment_purpose = "diagnostic";
  assert.equal(resolveInstructionalContext(pkg).items[0].assessment_purpose.purpose, "diagnostic");
  const individual = fixture(); plan(individual).items[0].scope = "mastery-claim";
  assert(resolveInstructionalContext(individual).items[0].holds.includes("individual_readiness_and_mastery_unverified"));
});
test("unknown and duplicate plan references fail with a typed error", () => {
  fails(pkg => { plan(pkg).items[0].goal_refs = ["MISSING"]; }, "unknown_reference");
  fails(pkg => { plan(pkg).events[1].id = "E1"; }, "duplicate_id");
  fails(pkg => { plan(pkg).sequence.goal_coverage[0].item_ids = ["Q1", "Q1"]; }, "duplicate_reference");
  fails(pkg => { plan(pkg).events[0].source_refs = ["MISSING"]; }, "unknown_reference");
});
test("out-of-order events, future-prior bindings and backward transitions are rejected", () => {
  fails(pkg => { plan(pkg).events[1].order = 1; }, "event_order_invalid");
  fails(pkg => { plan(pkg).events[0].before_item_id = "Q2"; plan(pkg).events[1].before_item_id = "Q1"; }, "event_anchor_reversed");
  fails(pkg => { plan(pkg).items[0].prior_event_refs = ["E3"]; }, "future_event_as_prior");
  fails(pkg => { plan(pkg).items[0].support.event_refs = ["E3"]; }, "future_event_as_support");
  fails(pkg => { plan(pkg).sequence.support_transitions[0].to_item_id = "Q1"; }, "support_transition_order_invalid");
});
test("malformed supplied history cannot be silently ignored", () => {
  fails(pkg => { pkg.request.student_context.response_history = {}; }, "invalid_history");
  fails(pkg => { pkg.request.student_context.response_history = [{ answer: "unbound response" }]; }, "unbound_history_requires_plan_events");
  fails(pkg => { plan(pkg).events[0].kind = "response"; }, "response_requires_observed_or_conditional_status");
});
test("evidence-selection prior tasks do not label candidates as correct and decoys as wrong", () => {
  const pkg = fixture(); pkg.set.items[0].kind = "evidence_select"; pkg.set.items[0].view = { prompt: "Select a line.", candidates: ["The fox crosses."], decoys: ["The hare waits."], strong: ["The fox crosses."] };
  const task = resolveInstructionalContext(pkg).items[1].learner_context.prior_tasks[0].task;
  assert.deepEqual(task.evidence_options, ["The fox crosses.", "The hare waits."]);
  assert.equal(Object.hasOwn(task, "candidates"), false); assert.equal(Object.hasOwn(task, "decoys"), false); assert.equal(Object.hasOwn(task, "strong"), false);
});
test("resolution is pure and supports a context-owned native course without a request copy", () => {
  const pkg = fixture(), before = structuredClone(pkg);
  resolveInstructionalContext(pkg); assert.deepEqual(pkg, before);
  pkg.context.native.course_context = pkg.request.course_context; delete pkg.request.course_context;
  assert.equal(resolveInstructionalContext(pkg).items[0].assessment_purpose.purpose, "assessment");
});

test("empty declared assessment evidence remains a hold rather than a complete contextual claim", () => {
  const pkg = fixture(); plan(pkg).items[0].expected_evidence = []; plan(pkg).items[0].goal_refs = [];
  const row = resolveInstructionalContext(pkg).items[0];
  assert(row.holds.includes("expected_evidence_missing")); assert(row.holds.includes("item_goals_missing"));
});
test("legacy optional teaching is kept conditional and unknown prerequisite graph links are rejected", () => {
  const pkg = fixture(); delete pkg.request.course_context.instructional_plan; pkg.context.native.pages[0].extra = "optional";
  const row = resolveInstructionalContext(pkg).items[1];
  assert(row.holds.includes("conditional_exposure_unresolved"));
  assert.equal(row.learner_context.ordered_teaching.some(event => event.page_ref === "P1"), false);
  fails(pkg => { pkg.request.course_context.knowledge_map.edges[0].to = "MISSING"; }, "unknown_reference");
});
test("prior classification and matching retain visible response structure without assigned answers", () => {
  const classification = fixture(); classification.set.items[0].view = { prompt: "Classify the fox.", items: [{ word: "fox", to: "assigned-secret", kind: "is" }], boxes: { character: { is: "River crosser" } } };
  const task = resolveInstructionalContext(classification).items[1].learner_context.prior_tasks[0].task;
  assert.deepEqual(task.words, ["fox"]); assert.deepEqual(task.destinations, [{ relation: "is", label: "River crosser" }]);
  assert.equal(JSON.stringify(task).includes("assigned-secret"), false);
  const matching = fixture(); matching.set.items[0].view = { prompt: "Match.", entries: [{ id: "a", text: "Fox" }], options: [{ id: "x", text: "crosses" }], mapping: { a: "x" } };
  const match = resolveInstructionalContext(matching).items[1].learner_context.prior_tasks[0].task;
  assert.deepEqual(match.options, [{ id: "O1", text: "crosses" }]); assert.equal(Object.hasOwn(match, "mapping"), false);
});

test("malformed supplied source, procedure and learner descriptors fail before review", () => {
  fails(pkg => { pkg.request.course_context.authorized_procedure = "untyped procedure"; }, "invalid_procedure");
  fails(pkg => { pkg.request.course_context.source_assets[0].time_range = [12, 1]; }, "invalid_media_range");
  fails(pkg => { pkg.request.student_context.language = {}; }, "invalid_text");
  fails(pkg => { pkg.request.course_context.core_knowledge[0].source_refs = ["MISSING"]; }, "unknown_reference");
});

test("prior learner tasks use neutral nested entry and category identifiers", () => {
  const pkg = fixture(); pkg.set.items[0].view = { prompt: "Classify the animal.", entries: [{ id: "PRIVATE_AUTHOR_ENTRY", text: "Fox" }], categories: [{ id: "PRIVATE_AUTHOR_CATEGORY", label: "Crosser", description: "The animal crossing the river." }], mapping: { PRIVATE_AUTHOR_ENTRY: "PRIVATE_AUTHOR_CATEGORY" } };
  const task = resolveInstructionalContext(pkg).items[1].learner_context.prior_tasks[0].task;
  assert.equal(JSON.stringify(task).includes("PRIVATE_AUTHOR"), false);
  assert.equal(task.entries[0].id, "E1"); assert.equal(task.categories[0].id, "C1");
  assert(resolveInstructionalContext(pkg).items[1].learner_context.prior_tasks[0].exposure.includes("not observed"));
});

test("explicit unscored confidence does not need a knowledge target, while a knowledge response does", () => {
  const pkg = fixture();
  pkg.set.items[0].family = "self_report";
  pkg.set.items[0].view = { prompt: "How sure do you feel?", scale: ["Not yet", "Sure"], scoring: "none" };
  plan(pkg).items[0].goal_refs = [];
  plan(pkg).items[0].expected_evidence = [{ id: "CONFIDENCE", goal_refs: [], claim: "An unscored confidence declaration, not knowledge correctness.", source_refs: [] }];
  assert.equal(resolveInstructionalContext(pkg).items[0].holds.includes("item_goals_missing"), false);
  pkg.set.items[0].family = "written_response";
  assert.equal(resolveInstructionalContext(pkg).items[0].holds.includes("item_goals_missing"), true);
});

test("practice also needs an explicit response expectation rather than an empty evidence declaration", () => {
  const pkg = fixture(); plan(pkg).items[0].purpose = "practice"; plan(pkg).items[0].expected_evidence = [];
  assert(resolveInstructionalContext(pkg).items[0].holds.includes("expected_evidence_missing"));
});

test("uninterpreted passive nodes reject both explicit-plan and legacy previews", () => {
  for (const explicit of [true, false]) for (const node of [{ type: "interactive_diagram", text: "An uninterpreted diagram caption." }, { text: "A node without a declared type." }]) {
    const pkg = fixture(); if (!explicit) delete pkg.request.course_context.instructional_plan;
    pkg.context.native.pages[0].nodes.push(node);
    assert.throws(() => resolveInstructionalContext(pkg), error => error instanceof InstructionalContextError
      && error.code === "unsupported_passive_node" && error.field === "context/native/pages/0/nodes/1/type");
  }
});

test("an unavailable or future extra cannot hide an uninterpreted passive node", () => {
  for (const explicit of [true, false]) for (const enabled of [undefined, false, true]) {
    const pkg = fixture(); if (!explicit) delete pkg.request.course_context.instructional_plan;
    pkg.context.native.pages[2].extra = "extension";
    pkg.context.native.pages[2].nodes = [{ type: "media_transcript", text: "Exposure cannot be inferred from this node." }];
    if (enabled !== undefined) pkg.context.native.extras = { extension: enabled };
    assert.throws(() => resolveInstructionalContext(pkg), error => error instanceof InstructionalContextError
      && error.code === "unsupported_passive_node" && error.field === "context/native/pages/2/nodes/0/type");
  }
});

test("known passive types without interpretable learner content cannot disappear from a preview", () => {
  for (const explicit of [true, false]) for (const node of [{ type: "reading", part: 1, source_ref: "S1" }, { type: "instruction", author_key: "AUTHOR_ONLY_UNINTERPRETED" }]) {
    const pkg = fixture(); if (!explicit) delete pkg.request.course_context.instructional_plan;
    pkg.context.native.pages[0].nodes = [node];
    assert.throws(() => resolveInstructionalContext(pkg), error => error instanceof InstructionalContextError
      && error.code === "unsupported_passive_node_content" && error.field === "context/native/pages/0/nodes/0");
  }
});

test("supported passive text formats retain learner text and conditional availability without author fields", () => {
  const pkg = fixture(), suppliedPlan = plan(pkg); delete pkg.request.course_context.instructional_plan;
  pkg.context.native.pages[0].nodes = [
    { type: "reading", blocks: [{ lines: [{ who: "Narrator", line: "A reading line." }, { stage: "A stage direction." }] }, { paragraphs: ["A prose paragraph."] }] },
    { type: "instruction", text: "A learner instruction.", author_key: "AUTHOR_ONLY_PASSIVE" },
    { type: "learning_question", learning_question: "What will we learn?" },
    { type: "key_term", term: "verb", meaning: "An action word." },
    { type: "definition", text: "A learner definition." },
    { type: "worked_instruction", line: "A worked line.", quote: "A worked quote.", steps: [{ stem: "A worked prompt.", sentence: "A worked sentence.", think: "A worked thought." }], sample_answer: "AUTHOR_ONLY_PASSIVE" },
    { type: "worked-teaching", statement: "A teaching statement." },
    { type: "recall-model", text: "A recall model." }
  ];
  const result = resolveInstructionalContext(pkg), teaching = result.items[0].learner_context.ordered_teaching;
  assert.deepEqual(teaching.map(event => event.text), ["Narrator: A reading line.\nA stage direction.\nA prose paragraph.", "A learner instruction.", "What will we learn?", "verb: An action word.", "A learner definition.", "A worked line.\nA worked quote.\nA worked prompt.\nA worked sentence.\nA worked thought.", "A teaching statement.", "A recall model."]);
  assert.equal(JSON.stringify(result.items[0].learner_context).includes("AUTHOR_ONLY_PASSIVE"), false);
  pkg.context.native.pages[0].extra = "optional";
  const conditional = resolveInstructionalContext(pkg).items[0];
  assert.equal(conditional.learner_context.ordered_teaching.length, 0);
  assert(conditional.holds.includes("conditional_exposure_unresolved"));
  pkg.request.course_context.instructional_plan = suppliedPlan;
  assert.deepEqual(resolveInstructionalContext(pkg).items[0].learner_context.ordered_teaching.map(event => event.id), ["E1"]);
});

test("a readable sibling cannot hide an unsupported reading block or malformed reading field", () => {
  const cases = [
    [{ type: "interactive_diagram", caption: "DIAGRAM_CONTENT_SENTINEL" }, "unsupported_passive_node", "/type"],
    [{ type: "interactive_diagram", text: "A caption does not interpret its diagram." }, "unsupported_passive_node", "/type"],
    [{ unsupported_caption: "An uninterpreted block." }, "unsupported_passive_node_content", ""],
    [{ lines: ["A visible line.", null] }, "unsupported_passive_node_content", "/lines/1"],
    [{ lines: ["A visible line.", { line: 4 }] }, "invalid_text", "/lines/1/line"],
    [{ lines: [{ line: "A visible line.", who: {} }] }, "invalid_text", "/lines/0/who"],
    [{ lines: [{ line: "A visible line.", text: {} }] }, "invalid_text", "/lines/0/text"],
    [{ text: "A readable part.", lines: "A malformed line list." }, "invalid_list", "/lines"],
    [{ text: "A readable part.", paragraphs: [] }, "unsupported_passive_node_content", "/paragraphs"],
    [{ parts: [{ text: "A readable part." }, { unknown_part: "An uninterpreted nested part." }] }, "unsupported_passive_node_content", "/parts/1"],
    [{ lines: [" "] }, "invalid_text", "/lines/0"]
  ];
  for (const explicit of [true, false]) for (const available of [true, false]) for (const [block, code, suffix] of cases) {
    const pkg = fixture(); if (!explicit) delete pkg.request.course_context.instructional_plan;
    pkg.context.native.pages[0].extra = "reading-extra"; pkg.context.native.extras = { "reading-extra": available };
    pkg.context.native.pages[0].nodes = [{ type: "reading", blocks: [{ lines: ["Visible sentence."] }, block] }];
    assert.throws(() => resolveInstructionalContext(pkg), error => error instanceof InstructionalContextError
      && error.code === code && error.field === `context/native/pages/0/nodes/0/blocks/1${suffix}`);
  }
});

test("a malformed reading container cannot be replaced by otherwise readable root text", () => {
  for (const explicit of [true, false]) for (const blocks of [null, {}, "Not an array."]) {
    const pkg = fixture(); if (!explicit) delete pkg.request.course_context.instructional_plan;
    pkg.context.native.pages[0].nodes = [{ type: "reading", text: "Readable root text.", blocks }];
    assert.throws(() => resolveInstructionalContext(pkg), error => error instanceof InstructionalContextError
      && error.code === "invalid_list" && error.field === "context/native/pages/0/nodes/0/blocks");
  }
});

test("reference reading block shapes and supported nested text retain their learner text only", () => {
  const pkg = fixture(); delete pkg.request.course_context.instructional_plan;
  pkg.context.native.pages[0].nodes = [{ type: "reading", blocks: [
    { kind: "title", title: "A fictional play", by: "Author metadata", teacher_key: "AUTHOR_ONLY_READING" },
    { kind: "heading", text: "About the play" },
    { kind: "para", text: "A short passage." },
    { metadata: { text: "AUTHOR_ONLY_READING", note: "Nonlearner block metadata." } },
    { kind: "archivist", lines: ["Read the passage."] },
    { kind: "script", lines: [{ who: "Fox", line: "I crossed." }, { who: null, line: "Then I stopped." }, { stage: "[The fox waits.]" }] },
    { parts: [{ paragraph: "A paragraph." }, { paragraphs: ["Another paragraph.", { t: "A final text part." }] }] }
  ] }];
  const learner = resolveInstructionalContext(pkg).items[0].learner_context;
  assert.equal(learner.ordered_teaching[0].text, "A fictional play\nAbout the play\nA short passage.\nRead the passage.\nFox: I crossed.\nThen I stopped.\n[The fox waits.]\nA paragraph.\nAnother paragraph.\nA final text part.");
  assert.equal(JSON.stringify(learner).includes("AUTHOR_ONLY_READING"), false);
  assert.equal(JSON.stringify(learner).includes("Author metadata"), false);
  pkg.context.native.pages[0].nodes = [{ type: "reading", text: "A supported root reading text." }];
  assert.equal(resolveInstructionalContext(pkg).items[0].learner_context.ordered_teaching[0].text, "A supported root reading text.");
});
