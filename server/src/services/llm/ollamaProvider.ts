import type { LLMProvider, LLMMessage, LLMChatOptions } from './types';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaResponse {
  message?: { content: string };
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl = 'http://localhost:11434') {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  supportsVision(): boolean {
    return false;
  }

  async chat(messages: LLMMessage[], _options: LLMChatOptions = {}): Promise<string> {
    // Ollama only receives text; fileProcessor already extracted text for non-vision providers
    const ollamaMessages: OllamaMessage[] = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n'),
    }));

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: ollamaMessages,
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Ollama request failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as OllamaResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    return data.message?.content ?? '';
  }
}
