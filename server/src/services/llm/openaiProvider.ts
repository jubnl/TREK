import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMChatOptions, LLMContentPart } from './types';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  supportsVision(): boolean {
    return true;
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<string> {
    // OpenAI: system messages must have string content; user messages can have arrays
    const mapped = messages.map((m) => {
      if (m.role === 'system') {
        const text = typeof m.content === 'string'
          ? m.content
          : (m.content as LLMContentPart[]).filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
        return { role: 'system' as const, content: text };
      }
      if (typeof m.content === 'string') {
        return { role: 'user' as const, content: m.content };
      }
      // Map content parts — OpenAI uses image_url format
      const parts = (m.content as LLMContentPart[]).map((p) => {
        if (p.type === 'text') return { type: 'text' as const, text: p.text };
        if (p.type === 'image_url') return { type: 'image_url' as const, image_url: p.image_url };
        // Anthropic-style image_source — convert to OpenAI format
        if (p.type === 'image') {
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` },
          };
        }
        return { type: 'text' as const, text: '' };
      });
      return { role: 'user' as const, content: parts };
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: mapped,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 2048,
    });

    return response.choices[0]?.message?.content ?? '';
  }
}
