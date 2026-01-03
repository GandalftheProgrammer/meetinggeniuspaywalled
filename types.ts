
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

export interface MeetingData {
  transcription: string;
  summary: string;
  conclusions: string[];
  actionItems: string[];
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
