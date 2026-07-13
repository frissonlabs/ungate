-- Migration 0007: add GPT-5.6 Sol / Terra / Luna model mappings
WITH candidates(id, label, provider, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('ug-gpt-5.6', 'GPT-5.6 Sol', 'openai', 'gpt-5.6-sol', NULL, 1),
		('ug-gpt-5.6-low', 'GPT-5.6 Sol Low', 'openai', 'gpt-5.6-sol', 'low', 2),
		('ug-gpt-5.6-medium', 'GPT-5.6 Sol Medium', 'openai', 'gpt-5.6-sol', 'medium', 3),
		('ug-gpt-5.6-high', 'GPT-5.6 Sol High', 'openai', 'gpt-5.6-sol', 'high', 4),
		('ug-gpt-5.6-xhigh', 'GPT-5.6 Sol XHigh', 'openai', 'gpt-5.6-sol', 'xhigh', 5),
		('ug-gpt-5.6-max', 'GPT-5.6 Sol Max', 'openai', 'gpt-5.6-sol', 'max', 6),
		('ug-gpt-5.6-terra', 'GPT-5.6 Terra', 'openai', 'gpt-5.6-terra', NULL, 7),
		('ug-gpt-5.6-terra-low', 'GPT-5.6 Terra Low', 'openai', 'gpt-5.6-terra', 'low', 8),
		('ug-gpt-5.6-terra-medium', 'GPT-5.6 Terra Medium', 'openai', 'gpt-5.6-terra', 'medium', 9),
		('ug-gpt-5.6-terra-high', 'GPT-5.6 Terra High', 'openai', 'gpt-5.6-terra', 'high', 10),
		('ug-gpt-5.6-terra-xhigh', 'GPT-5.6 Terra XHigh', 'openai', 'gpt-5.6-terra', 'xhigh', 11),
		('ug-gpt-5.6-terra-max', 'GPT-5.6 Terra Max', 'openai', 'gpt-5.6-terra', 'max', 12),
		('ug-gpt-5.6-luna', 'GPT-5.6 Luna', 'openai', 'gpt-5.6-luna', NULL, 13),
		('ug-gpt-5.6-luna-low', 'GPT-5.6 Luna Low', 'openai', 'gpt-5.6-luna', 'low', 14),
		('ug-gpt-5.6-luna-medium', 'GPT-5.6 Luna Medium', 'openai', 'gpt-5.6-luna', 'medium', 15),
		('ug-gpt-5.6-luna-high', 'GPT-5.6 Luna High', 'openai', 'gpt-5.6-luna', 'high', 16),
		('ug-gpt-5.6-luna-xhigh', 'GPT-5.6 Luna XHigh', 'openai', 'gpt-5.6-luna', 'xhigh', 17),
		('ug-gpt-5.6-luna-max', 'GPT-5.6 Luna Max', 'openai', 'gpt-5.6-luna', 'max', 18)
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
