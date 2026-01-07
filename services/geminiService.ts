
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

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

  log("Initializing multi-pass processing pipeline...");
  try {
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; 
    const totalChunks = Math.ceil(totalBytes / UPLOAD_CHUNK_SIZE);
    let offset = 0;
    let chunkIndex = 0;

    log(`Total Audio Size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const base64Data = await blobToBase64(chunkBlob);

        log(`Uploading chunk ${chunkIndex + 1}/${totalChunks}...`);

        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload_chunk', jobId, chunkIndex, data: base64Data })
        });

        if (!uploadResp.ok) throw new Error(`Upload failed at chunk ${chunkIndex}`);
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    log("Cloud upload complete. Handshaking with Gemini Worker...");
    const triggerResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode, model, fileSize: totalBytes, uid })
    });

    if (!triggerResp.ok) throw new Error("Worker handshake failed.");

    log("Background analysis started. Waiting for Gemini response...");
    let attempts = 0;
    let lastKnownLog = "";

    while (attempts < 1200) { // Extended to 1 hour for long 3h files
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.ok) {
            const data = await pollResp.json();
            
            // Handle intermediate progress logs from background function
            if (data.lastLog && data.lastLog !== lastKnownLog) {
                log(data.lastLog);
                lastKnownLog = data.lastLog;
            }

            if (data.status === 'COMPLETED') {
                log("Processing SUCCESS! Building results...");
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

/**
 * Defensive utility to ensure array elements are strings.
 * If an element is an object, attempts to extract text-like properties or strings it.
 */
function sanitizeArray(arr: any): string[] {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
        if (typeof item === 'string') return item;
        if (item === null || item === undefined) return '';
        if (typeof item === 'object') {
            return item.text || item.task || item.description || item.content || JSON.stringify(item);
        }
        return String(item);
    }).filter(s => s !== '');
}

function parseResponse(jsonText: string, mode: ProcessingMode): MeetingData {
    try {
        const rawData = JSON.parse(jsonText);
        return {
            transcription: rawData.transcription || "",
            summary: rawData.summary || "",
            conclusions: sanitizeArray(rawData.conclusions),
            actionItems: sanitizeArray(rawData.actionItems)
        };
    } catch (e) {
        console.error("Parse failed for final result:", jsonText);
        return { 
          transcription: "Error parsing result.", 
          summary: "The AI response could not be parsed. Please try again.", 
          conclusions: [], 
          actionItems: [] 
        };
    }
}
