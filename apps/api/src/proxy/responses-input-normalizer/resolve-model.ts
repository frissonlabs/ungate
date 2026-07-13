import type { CodexReasoningEffort, ResolvedChatGptModel } from './types';

const LEGACY_MODEL_REASONING_DEFAULTS: Record<string, CodexReasoningEffort> = {
	'gpt-5.3-codex': 'medium',
	'gpt-5.1-codex-mini': 'medium'
};

const LEGACY_MODEL_PREFIX_ALIASES: Record<string, ResolvedChatGptModel> = {
	'gpt-5.3': { model: 'gpt-5.3-codex', reasoningEffort: 'medium' },
	'gpt-5.1': { model: 'gpt-5.1-codex-mini', reasoningEffort: 'medium' }
};

export class ResponsesModelResolver {
	public static resolveModel(model: string): ResolvedChatGptModel {
		if (!model) {
			return { model: 'gpt-5.6-sol' };
		}

		const suffixResolved = this.resolveReasoningSuffix(model);

		if (suffixResolved) {
			return suffixResolved;
		}

		if (model === 'gpt-5.6' || model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra' || model === 'gpt-5.6-luna') {
			return { model: model === 'gpt-5.6' ? 'gpt-5.6-sol' : model };
		}

		if (model === 'gpt-5.4' || model === 'gpt-5.4-mini') {
			return { model };
		}

		const defaultReasoning = LEGACY_MODEL_REASONING_DEFAULTS[model];

		if (defaultReasoning) {
			return { model, reasoningEffort: defaultReasoning };
		}

		if (model.includes('codex')) {
			return { model };
		}

		if (model.startsWith('gpt-')) {
			const prefixAlias = this.resolveLegacyPrefixAlias(model);

			if (prefixAlias) {
				return prefixAlias;
			}

			return { model };
		}

		return { model: 'gpt-5.6-sol' };
	}

	private static resolveReasoningSuffix(model: string): ResolvedChatGptModel | null {
		const effortLevels: CodexReasoningEffort[] = ['none', 'low', 'medium', 'xhigh', 'high', 'max'];

		for (const effort of effortLevels) {
			if (model.endsWith(`-${effort}`)) {
				const baseModel = model.slice(0, -`-${effort}`.length);

				return {
					model: baseModel === 'gpt-5.6' ? 'gpt-5.6-sol' : baseModel,
					reasoningEffort: effort
				};
			}
		}

		return null;
	}

	private static resolveLegacyPrefixAlias(model: string): ResolvedChatGptModel | null {
		for (const [prefix, resolved] of Object.entries(LEGACY_MODEL_PREFIX_ALIASES)) {
			if (model.startsWith(prefix)) {
				return resolved;
			}
		}

		return null;
	}
}
