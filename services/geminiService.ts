
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

/**
 * Robustly extracts content from a string using JSON or Tag-based logic.
 */
function extractContent(text: string): MeetingData {
    const data: MeetingData = {
        transcription: '',
        summary: '',
        conclusions: [],
        actionItems: []
    };

    if (!text) return data;

    // 1. Try JSON extraction
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0].replace(/,\s*([\]}])/g, '$1'));
            if (parsed.summary || parsed.conclusions) {
                data.summary = smartUnwrap(parsed.summary);
                data.conclusions = sanitizeArray(parsed.conclusions);
                data.actionItems = sanitizeArray(parsed.actionItems);
                data.transcription = smartUnwrap(parsed.transcription);
                return data;
            }
        }
    } catch (e) {}

    // 2. Tag-based extraction (Markdown-First)
    const findSection = (tags: string[]) => {
        for (const tag of tags) {
            const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)(?=\\[|$)`, 'i');
            const match = text.match(regex);
            if (match) return match[1].trim();
        }
        return null;
    };

    const rawSummary = findSection(['SUMMARY', 'SAMENVATTING', 'OVERZICHT']);
    const rawConclusions = findSection(['CONCLUSIONS', 'CONCLUSIES', 'INSIGHTS']);
    const rawActions = findSection(['ACTIONS', 'ACTIES', 'TAKEN', 'ACTION_ITEMS']);
    const rawTranscript = findSection(['TRANSCRIPTION', 'TRANSCRIPT', 'TEKST']);

    if (rawSummary) data.summary = rawSummary;
    if (rawConclusions) data.conclusions = rawConclusions.split(/\n-|\n\*|\n\d\./).map(s => s.trim()).filter(s => s.length > 2);
    if (rawActions) data.actionItems = rawActions.split(/\n-|\n\*|\n\d\./).map(s => s.trim()).filter(s => s.length > 2);
    if (rawTranscript) data.transcription = rawTranscript;

    // 3. Last Resort: Heuristic block search
    if (!data.summary && text.length > 100) {
        const parts = text.split(/\n#{1,3}\s+/);
        if (parts.length > 1) {
            data.summary = parts[1].trim();
            if (parts[2]) data.conclusions = parts[2].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-/, '').trim());
        } else {
            data.summary = text.substring(0, 1000);
        }
    }

    return data;
}

function smartUnwrap(item: any): string {
    if (typeof item === 'string') return item;
    if (item === null || item === undefined) return '';
    if (Array.isArray(item)) return item.map(i => smartUnwrap(i)).join('\n');
    if (typeof item === 'object') {
        const keys = ['text', 'task', 'point', 'note', 'summary', 'value'];
        for (const k of keys) if (item[k]) return String(item[k]);
        return JSON.stringify(item);
    }
    return String(item);
}

function sanitizeArray(arr: any): string[] {
    if (!Array.isArray(arr)) return typeof arr === 'string' ? [arr] : [];
    return arr.map(item => smartUnwrap(item)).filter(s => s.trim() !== '');
}

export const processMeetingAudio = async (
  audioBlob: Blob, 
  defaultMimeType: string, 
  mode: ProcessingMode = 'ALL',
  model: GeminiModel,
  onLog?: (msg: string) => void,
  uid?: string
): Promise<MeetingData> => {
  const log = (msg: string) => {
      console.log(msg);
      if (onLog) onLog(msg);
  };

  const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);

  try {
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; 
    const totalChunks = Math.ceil(totalBytes / UPLOAD_CHUNK_SIZE);
    let offset = 0;
    let chunkIndex = 0;

    log("Step 1/3: Storing audio fragments in cloud storage...");

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const base64Data = await blobToBase64(chunkBlob);
        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload_chunk', jobId, chunkIndex, data: base64Data })
        });
        if (!uploadResp.ok) throw new Error(`Upload failed at segment ${chunkIndex}`);
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    const triggerResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode, model, fileSize: totalBytes, uid })
    });
    if (!triggerResp.ok) throw new Error("Could not initialize parallel processing.");

    let attempts = 0;
    let lastKnownLog = "";

    while (attempts < 1800) { 
        attempts++;
        await new Promise(r => setTimeout(r, 3000));
        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.ok) {
            const data = await pollResp.json();
            if (data.lastLog && data.lastLog !== lastKnownLog) {
                log(data.lastLog);
                lastKnownLog = data.lastLog;
            }
            if (data.status === 'COMPLETED') return extractContent(data.result);
            if (data.status === 'ERROR') throw new Error(data.error);
        }
    }
    throw new Error("Processing timeout reached.");
  } catch (error) {
    log(`FATAL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
};

function getMimeTypeFromBlob(blob: Blob, defaultType: string): string {
    if ('name' in blob) {
        const name = (blob as File).name.toLowerCase();
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.m4a')) return 'audio/mp4';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.webm')) return 'audio/webm';
    }
    return blob.type || defaultType;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
