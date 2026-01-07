
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

/**
 * Robustly extracts the JSON block from a string. 
 * Strips markdown code blocks and leading/trailing chatter.
 */
function extractJson(text: string): any {
    // Look for markdown code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const contentToParse = codeBlockMatch ? codeBlockMatch[1] : text;

    const start = contentToParse.indexOf('{');
    const end = contentToParse.lastIndexOf('}');
    
    if (start === -1 || end === -1 || end < start) return null;
    
    const jsonStr = contentToParse.substring(start, end + 1);
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("Failed to parse extracted JSON block:", e);
        // Fallback: try to clean common AI mistakes like trailing commas before closing braces
        try {
            const cleaned = jsonStr.replace(/,\s*([\]}])/g, '$1');
            return JSON.parse(cleaned);
        } catch (e2) {
            return null;
        }
    }
}

/**
 * Recursively flattens an object or array to ensure only strings are returned.
 */
function smartUnwrap(item: any): string {
    if (typeof item === 'string') return item;
    if (item === null || item === undefined) return '';
    
    if (Array.isArray(item)) {
        return item.map(i => smartUnwrap(i)).join(', ');
    }

    if (typeof item === 'object') {
        const textKeys = ['text', 'task', 'point', 'note', 'description', 'content', 'value', 'summary'];
        for (const key of textKeys) {
            if (item[key] && (typeof item[key] === 'string' || typeof item[key] === 'number')) {
                return String(item[key]);
            }
        }
        return JSON.stringify(item);
    }
    
    return String(item);
}

function sanitizeArray(arr: any): string[] {
    if (!Array.isArray(arr)) return [];
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

    log("Step 1/3: Securing audio in Cloud (Drive & Analysis Server).");

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const base64Data = await blobToBase64(chunkBlob);

        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload_chunk', jobId, chunkIndex, data: base64Data })
        });

        if (!uploadResp.ok) throw new Error(`Upload failed at chunk ${chunkIndex}`);
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    const triggerResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode, model, fileSize: totalBytes, uid })
    });

    if (!triggerResp.ok) throw new Error("Worker handshake failed.");

    let attempts = 0;
    let lastKnownLog = "";

    while (attempts < 1800) { // 2 hours timeout for long sessions
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
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

            if (data.status === 'COMPLETED') {
                return parseResponse(data.result, mode);
            }
            if (data.status === 'ERROR') throw new Error(data.error);
        }
    }
    throw new Error("Timeout: Gemini is taking too long for this meeting.");
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

function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    const rawData = extractJson(jsonText);
    
    if (!rawData) {
        console.error("Extraction failed for:", jsonText);
        return { 
          transcription: "Error parsing result. Raw response was not a valid JSON structure.", 
          summary: "The AI response was malformed. This can happen with very long or noisy recordings.", 
          conclusions: [], 
          actionItems: [] 
        };
    }

    return {
        transcription: String(rawData.transcription || ""),
        summary: smartUnwrap(rawData.summary || ""),
        conclusions: sanitizeArray(rawData.conclusions),
        actionItems: sanitizeArray(rawData.actionItems)
    };
}
