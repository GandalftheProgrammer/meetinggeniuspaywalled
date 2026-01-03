
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

const SYSTEM_INSTRUCTION = `You are an expert meeting secretary.
1. Analyze audio to detect the primary language.
2. All output MUST be in the DETECTED LANGUAGE.
3. Return a raw JSON object with: transcription, summary, conclusions (array), actionItems (array).`;

export const processMeetingAudio = async (
  audioBlob: Blob, 
  defaultMimeType: string, 
  mode: ProcessingMode = 'ALL',
  model: GeminiModel,
  onLog?: (msg: string) => void
): Promise<MeetingData> => {
  const log = (msg: string) => {
      console.log(msg);
      if (onLog) onLog(msg);
  };

  const mimeType = getMimeTypeFromBlob(audioBlob, defaultMimeType);

  log("Initializing production-ready processing pipeline...");
  try {
    const totalBytes = audioBlob.size;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // Step 1: Divide into 4MB chunks
    const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; 
    const totalChunks = Math.ceil(totalBytes / UPLOAD_CHUNK_SIZE);
    let offset = 0;
    let chunkIndex = 0;

    log(`Total Audio Size: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
    log(`Slicing file into ${totalChunks} secure chunks...`);

    while (offset < totalBytes) {
        const chunkEnd = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunkBlob = audioBlob.slice(offset, chunkEnd);
        const base64Data = await blobToBase64(chunkBlob);

        const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        log(`Uploading chunk ${chunkIndex + 1}/${totalChunks} to cloud storage...`);
        log(`>> Progress: ${progress}% (${(chunkEnd / (1024 * 1024)).toFixed(2)} MB uploaded)`);

        const uploadResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload_chunk', jobId, chunkIndex, data: base64Data })
        });

        if (!uploadResp.ok) {
            log(`ERROR: Chunk ${chunkIndex} upload failed.`);
            throw new Error(`Upload failed at chunk ${chunkIndex}`);
        }
        offset += UPLOAD_CHUNK_SIZE;
        chunkIndex++;
    }
    
    log("Cloud upload complete. Handshaking with Gemini Worker...");
    const triggerResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, totalChunks: chunkIndex, mimeType, mode: 'ALL', model, fileSize: totalBytes })
    });

    if (!triggerResp.ok) {
        log("ERROR: Failed to trigger background worker.");
        throw new Error("Worker handshake failed.");
    }

    log("Background analysis started. Waiting for Gemini response...");
    let attempts = 0;
    while (attempts < 600) {
        attempts++;
        if (attempts % 3 === 0) log(`Gemini is still processing... (Ping ${attempts})`);
        
        await new Promise(r => setTimeout(r, 3000));
        const pollResp = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });

        if (pollResp.status === 200) {
            const data = await pollResp.json();
            if (data.status === 'COMPLETED') {
                log("Processing SUCCESS! Building results...");
                return parseResponse(data.result, mode);
            }
            if (data.status === 'ERROR') {
                log(`CRITICAL AI ERROR: ${data.error}`);
                throw new Error(data.error);
            }
        }
    }
    throw new Error("Timeout: Gemini is taking too long.");
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
    const cleanText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
        const rawData = JSON.parse(cleanText);
        return {
            transcription: rawData.transcription || "No transcript returned.",
            summary: rawData.summary || "No summary returned.",
            conclusions: rawData.conclusions || [],
            actionItems: rawData.actionItems || []
        };
    } catch (e) {
        return { transcription: "", summary: "Data corrupted. Try again.", conclusions: [], actionItems: [] };
    }
}
