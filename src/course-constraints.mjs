// Declared course policy belongs in editorial review, never in independent solving.
const array = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function text(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`unsupported declared course ${field}`);
  return value;
}
function texts(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(entry => typeof entry === "string"))
    throw new Error(`unsupported declared course ${field}`);
  return [...value];
}
function rows(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(object)) throw new Error(`unsupported declared course ${field}`);
  return value;
}
function select(row, fields, lists = []) {
  return Object.fromEntries([...fields.map(field => [field, text(row[field], field)]),
    ...lists.map(field => [field, texts(row[field], field)])]);
}

export function declaredCourseConstraints(request, item) {
  const course = request.course_context ?? {}, targets = new Set(array(item.alignment?.target_refs));
  const procedure = course.authorized_procedure;
  if (procedure !== undefined && procedure !== null && !object(procedure))
    throw new Error("unsupported declared course authorized_procedure");
  const map = course.knowledge_map;
  if (map !== undefined && map !== null && !object(map)) throw new Error("unsupported declared course knowledge_map");
  const edges = rows(map?.edges, "knowledge_map.edges").map(row => select(row, ["from", "to", "relation", "warrant", "status"]));
  const selectedEdges = edges.filter(edge => targets.has(edge.from) || targets.has(edge.to));
  const nodeIds = new Set([...targets, ...selectedEdges.flatMap(edge => [edge.from, edge.to])].filter(Boolean));
  const selectedNodes = rows(map?.nodes, "knowledge_map.nodes").filter(row => nodeIds.has(row.id))
    .map(row => select(row, ["id", "role", "claim", "performance", "status"], ["source_refs"]));
  const pairIds = new Set(array(item.alignment?.pair_refs));
  const pairings = rows(course.pairing_tables, "pairing_tables").flatMap(table => rows(table.pairs, "pairing_tables.pairs"))
    .filter(row => pairIds.has(row.id)).map(row => select(row,
      ["id", "target_ref", "source_ref", "content_key_ref", "phase_ref", "rationale", "status"]));
  const projectedFields = new Set(["core_knowledge", "prior_exposure", "authorized_procedure", "knowledge_map", "pairing_tables", "known_constraints"]);
  return {
    authorized_procedure: procedure ? { ...select(procedure, ["source", "status"]), steps: texts(procedure.steps, "authorized_procedure.steps") } : null,
    prior_exposure: rows(course.prior_exposure, "prior_exposure").map(row => select(row,
      ["role", "content", "timing", "status"], ["source_refs"])),
    known_constraints: [...texts(request.known_constraints, "known_constraints"), ...texts(course.known_constraints, "course_context.known_constraints")],
    knowledge_relationships: map ? { revision: text(map.revision, "knowledge_map.revision"), nodes: selectedNodes, edges: selectedEdges } : null,
    selected_pairings: pairings,
    interpretation: "Declared policy and relationships, not observed learner events, calibrated prerequisite gates, mastery or course approval. Timing prose is not automatically resolved into exposure.",
    unprojected_editorial_course_fields: Object.keys(course).filter(field => !projectedFields.has(field)).sort(),
    missing: [!procedure && "authorized_procedure", !array(course.prior_exposure).length && "prior_exposure",
      !map && "knowledge_map", !pairings.length && "selected_pairings"].filter(Boolean)
  };
}
