/**
 * Harness-only adapter used to test evaluation/scoring itself. It is not valid
 * product evidence; release CI uses core-adapter.mjs.
 */
export async function createEvaluationAdapter({ fixtures }) {
  const knowledge = new Map(fixtures.knowledge.map((memory) => [memory.id, memory]));
  return {
    evidence_kind: "HARNESS_SELF_TEST",
    async setup() {},
    async prepare({ scenario }) {
      const ids = scenario.expected.required_memory_ids;
      const conflicts = scenario.expected.required_conflict_ids ?? [];
      return {
        retrieved_memory_ids: [...ids, ...conflicts],
        injected_constraint_ids: ids.filter((id) => knowledge.get(id)?.authority === "canonical"),
        conflict_memory_ids: conflicts,
        estimated_tokens: ids.length * 24 + conflicts.length * 12,
        guidance_item_count: ids.length + conflicts.length,
        degraded: scenario.provider_mode === "unavailable",
      };
    },
    async commitAndComplete() {},
    async seedBenchmarkMemories() {},
    async prepareBenchmark({ iteration }) {
      return 8 + (iteration % 7);
    },
    async close() {},
  };
}
