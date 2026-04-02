import { db } from '../../db/database';
import { decrypt_api_key } from '../apiKeyCrypto';
import type { LLMProvider, LLMProviderConfig, LLMProviderName } from './types';
import { OpenAIProvider } from './openaiProvider';
import { AnthropicProvider } from './anthropicProvider';
import { OllamaProvider } from './ollamaProvider';

const CLOUD_PROVIDERS: LLMProviderName[] = ['openai', 'anthropic'];

export function isCloudProvider(provider: string): boolean {
  return CLOUD_PROVIDERS.includes(provider as LLMProviderName);
}

/** Read a value from app_settings (admin-level config) */
function getAppSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Read a value from the per-user settings table */
function getUserSetting(userId: number, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Resolve the effective LLM config for a given user.
 * Priority: user settings > admin app_settings > addon config defaults.
 */
export function resolveUserConfig(userId: number): LLMProviderConfig | null {
  // Attempt user override first, then fall back to admin settings
  const provider =
    (getUserSetting(userId, 'llm_provider') ?? getAppSetting('llm_provider')) as LLMProviderName | null;
  const encryptedKey =
    getUserSetting(userId, 'llm_api_key') ?? getAppSetting('llm_api_key');
  const model =
    getUserSetting(userId, 'llm_model') ?? getAppSetting('llm_model');
  const baseUrl =
    getUserSetting(userId, 'llm_base_url') ?? getAppSetting('llm_base_url');

  if (!provider) return null;

  const apiKey = encryptedKey ? decrypt_api_key(encryptedKey) ?? undefined : undefined;

  return {
    provider,
    apiKey,
    model: model ?? defaultModel(provider),
    baseUrl: baseUrl ?? undefined,
  };
}

function defaultModel(provider: LLMProviderName): string {
  switch (provider) {
    case 'openai': return 'gpt-4o';
    case 'anthropic': return 'claude-3-5-sonnet-20241022';
    case 'ollama': return 'llama3';
  }
}

/** Instantiate the correct LLMProvider from a config object. */
export function createProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI requires an API key');
      return new OpenAIProvider(config.apiKey, config.model);
    case 'anthropic':
      if (!config.apiKey) throw new Error('Anthropic requires an API key');
      return new AnthropicProvider(config.apiKey, config.model);
    case 'ollama':
      return new OllamaProvider(config.model, config.baseUrl);
    default:
      throw new Error(`Unknown LLM provider: ${(config as LLMProviderConfig).provider}`);
  }
}
