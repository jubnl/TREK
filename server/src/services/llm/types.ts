export type LLMProviderName = 'openai' | 'anthropic' | 'ollama';

export interface LLMProviderConfig {
  provider: LLMProviderName;
  apiKey?: string;      // decrypted plaintext; not needed for Ollama
  model: string;
  baseUrl?: string;     // for Ollama or custom endpoints
}

export type LLMTextPart = { type: 'text'; text: string };

// OpenAI vision format
export type LLMImageUrlPart = {
  type: 'image_url';
  image_url: { url: string }; // base64 data URI: "data:image/jpeg;base64,..."
};

// Anthropic vision format
export type LLMImageSourcePart = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};

export type LLMContentPart = LLMTextPart | LLMImageUrlPart | LLMImageSourcePart;

export interface LLMMessage {
  role: 'system' | 'user';
  content: string | LLMContentPart[];
}

export interface LLMChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<string>;
  supportsVision(): boolean;
}

export interface ExtractedReservation {
  title: string;
  type: 'hotel' | 'flight' | 'train' | 'car' | 'cruise' | 'event' | 'tour' | 'activity' | 'restaurant' | 'other';
  reservation_time?: string;       // ISO 8601 datetime
  reservation_end_time?: string;   // ISO 8601 datetime
  location?: string;
  confirmation_number?: string;
  notes?: string;
  metadata?: Record<string, string>;
}
