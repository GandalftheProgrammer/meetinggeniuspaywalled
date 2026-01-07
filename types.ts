
export enum AppState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED', // Has data, can resume or process
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export type ProcessingMode = 'ALL' | 'NOTES_ONLY' | 'TRANSCRIPT_ONLY';

// Use recommended model names and aliases from Gemini API guidelines
export type GeminiModel = 
  | 'gemini-3-pro-preview'
  | 'gemini-3-flash-preview'
  | 'gemini-flash-lite-latest'
  | 'gemini-flash-latest'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite-latest';

// 5 hours in seconds (5 * 60 * 60)
export const FREE_LIMIT_SECONDS = 18000;

export interface TokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  finishReason?: string; // Added finishReason
  details?: {
    step: string;
    input: number;
    output: number;
    finishReason?: string;
  }[];
}

export interface MeetingData {
  transcription: string;
  summary: string;
  conclusions: string[];
  actionItems: string[];
  usage?: TokenUsage;
}

export interface UserProfile {
  uid: string;
  email: string;
  isPro: boolean;
  secondsUsed: number;
  lastReset: string;
}

export interface GoogleUser {
  access_token: string;
  expires_in: number;
}

// --- NEW LOGGING TYPES ---
export type PipelineStatus = 'pending' | 'processing' | 'completed' | 'error';

export interface PipelineStep {
  id: number;
  label: string;
  detail?: string; // e.g., "45 MB", "12s latency"
  status: PipelineStatus;
}

export interface PipelineUpdate {
  stepId: number;
  status: PipelineStatus;
  detail?: string;
}

// Event Log Pattern
export interface PipelineEvent {
  timestamp: number;
  stepId: number;
  status: PipelineStatus;
  detail?: string;
}
