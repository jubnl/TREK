import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMChatOptions, LLMContentPart } from './types';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  supportsVision(): boolean {
    return true;
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<string> {
    // Anthropic separates system messages from user/assistant messages
    let systemPrompt: string | undefined;
    const userMessages: Anthropic.MessageParam[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        systemPrompt = typeof m.content === 'string' ? m.content : '';
        continue;
      }
      if (typeof m.content === 'string') {
        userMessages.push({ role: 'user', content: m.content });
        continue;
      }
      // Map content parts to Anthropic format
      const parts: Anthropic.ContentBlockParam[] = (m.content as LLMContentPart[]).map((p) => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: p.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: p.source.data,
            },
          };
        }
        if (p.type === 'image_url') {
          // Convert OpenAI data URI to Anthropic format
          const match = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: match[2],
              },
            };
          }
        }
        return { type: 'text', text: '' };
      });
      userMessages.push({ role: 'user', content: parts });
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      system: systemPrompt,
      messages: userMessages,
    });

    const block = response.content[0];
    return block?.type === 'text' ? block.text : '';
  }
}
