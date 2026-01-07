
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

/**
 * Robustly extracts the JSON block or relevant content from a string. 
 */
function extractJson(text: string): any {
    if (!text) return null;

    // 1. Try direct JSON parse
    try {
        return JSON.parse(text);
    } catch (e) {}

    // 2. Look for markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        try {
            return JSON.parse(codeBlockMatch[1]);
        } catch (e) {}
    }

    // 3. Find first { and last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        const potentialJson = text.substring(start, end + 1);
        try {
            return JSON.parse(potentialJson.replace(/,\s*([\]}])/g, '$1'));
        } catch (e) {}
    }

    return null;
}

/**
 * Heuristically extracts data if JSON is not present.
 */
function heuristicParse(text: string): MeetingData | null {
    if (!text || text.length < 50) return null;

    const sections = {
        summary: '',
        conclusions: [] as string[],
        actionItems: [] as string[]
    };

    // Very rough heuristic parsing by looking for typical headers
    const findSection = (headers: string[], content: string) => {
        for (const header of headers) {
            const regex = new RegExp(`${header}[:\\s]*([\\s\\S]*?)(?=\\n\\s*\\n|\\n#|\\n\\d\\.|Summary|Conclusion|Action|$)`, 'i');
            const match = content.match(regex);
            if (match && match[1].trim()) return match[1].trim();
        }
        return null;
    };

    sections.summary = findSection(['Summary', 'Samenvatting', 'Inleiding', 'Focus'], text) || '';
    
    const conclusionText = findSection(['Conclusions', 'Conclusies', 'Belangrijkste punten', 'Insights'], text);
    if (conclusionText) {
        sections.conclusions = conclusionText.split(/\n-|\n\*|\n\d\./).map(s => s.trim()).filter(s => s.length > 2);
    }

    const actionText = findSection(['Action Items', 'Actiepunten', 'Taken', 'Volgende stappen'], text);
    if (actionText) {
        sections.actionItems = actionText.split(/\n-|\n\*|\n\d\./).map(s => s.trim()).filter(s => s.length > 2);
    }

    // If we found at least something, treat it as success
    if (sections.summary || sections.conclusions.length > 0) return { ...sections, transcription: '' };
    
    return null;
}

/**
 * Recursively flattens an object or array to ensure only strings are returned.
 */
function smartUnwrap(item: any): string {
    if (typeof item === 'string') return item;
    if (item === null || item === undefined) return '';
    
    if (Array.isArray(item)) {
        return item.map(i => smartUnwrap(i)).join('\n');
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
    if (!Array.isArray(arr)) {
        if (typeof arr === 'string') return [arr];
        return [];
    }
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

    log("Step 1/3: Storing audio in cloud storage...");

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

    if (!triggerResp.ok) throw new Error("Processing initialization failed.");

    let attempts = 0;
    let lastKnownLog = "";

    while (attempts < 1800) { 
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
    throw new Error("Timeout: The meeting is taking longer than expected.");
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
        // Hammer Fallback: Try heuristic parsing of plain text
        const heuristic = heuristicParse(jsonText);
        if (heuristic) {
            return {
                ...heuristic,
                transcription: jsonText // Assume whole text might be transcription if everything else failed
            };
        }

        return { 
          transcription: jsonText || "No transcription found.", 
          summary: "Analysis finished, but content was not in the expected format.", 
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
