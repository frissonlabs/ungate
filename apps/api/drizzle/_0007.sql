-- Migration 0007: add Fable-5 model mappings
WITH candidates(id, label, provider, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('fable-5', 'Fable 5', 'claude', 'claude-fable-5', NULL, 1),
		('fable-5-low', 'Fable 5 Low', 'claude', 'claude-fable-5', 'low', 2),
		('fable-5-medium', 'Fable 5 Medium', 'claude', 'claude-fable-5', 'medium', 3),
		('fable-5-high', 'Fable 5 High', 'claude', 'claude-fable-5', 'high', 4),
		('fable-5-xhigh', 'Fable 5 XHigh', 'claude', 'claude-fable-5', 'xhigh', 5)
),
base_sort_order(value) AS (
	SELECT COALESCE(MAX(sort_order), -1)
	FROM model_mappings
),
resolved_candidates AS (
	SELECT
		candidate.id,
		candidate.label,
		candidate.provider,
		candidate.upstream_model,
		(SELECT value FROM base_sort_order) + candidate.sort_offset AS sort_order,
		candidate.reasoning_budget
	FROM candidates AS candidate
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget)
SELECT candidate.id, candidate.label, candidate.provider, candidate.upstream_model, candidate.sort_order, candidate.reasoning_budget
FROM resolved_candidates AS candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = candidate.provider
		AND existing.upstream_model = candidate.upstream_model
		AND (
			existing.reasoning_budget = candidate.reasoning_budget
			OR (existing.reasoning_budget IS NULL AND candidate.reasoning_budget IS NULL)
		)
);
