
import { MeetingData, ProcessingMode, GeminiModel } from '../types';

const SEGMENT_DURATION_SECONDS = 1800; // 30 minutes
const TARGET_SAMPLE_RATE = 16000; // 16kHz Mono

/**
 * Physically slices an audio blob into multiple segments using the Web Audio API.
 * Downsamples to 16kHz Mono to minimize file size/upload time while preserving speech quality.
 */
async function sliceAudioIntoSegments(blob: Blob): Promise<Blob[]> {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    const segments: Blob[] = [];
    const totalDuration = audioBuffer.duration;
    const numSegments = Math.ceil(totalDuration / SEGMENT_DURATION_SECONDS);

    for (let i = 0; i < numSegments; i++) {
        const startOffset = i * SEGMENT_DURATION_SECONDS;
        const endOffset = Math.min((i + 1) * SEGMENT_DURATION_SECONDS, totalDuration);
        const duration = endOffset - startOffset;
        
        // Optimize: Force Mono (1 channel) and 16kHz Sample Rate
        const offlineCtx = new OfflineAudioContext(
            1, // Mono
            duration * TARGET_SAMPLE_RATE,
            TARGET_SAMPLE_RATE
        );
        
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0, startOffset, duration);
        
        const renderedBuffer = await offlineCtx.startRendering();
        segments.push(audioBufferToWav(renderedBuffer));
    }
    
    await audioCtx.close();
    return segments;
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const outBuffer = new ArrayBuffer(length);
    const view = new DataView(outBuffer);
    const channels = [];
    let i, sample, offset = 0, pos = 0;

    setUint32(0x46464952);                         
    setUint32(length - 8);                         
    setUint32(0x45564157);                         
    setUint32(0x20746d66);                         
    setUint32(16);                                 
    setUint16(1);                                  
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan);  
    setUint16(numOfChan * 2);                      
    setUint16(16);                                 
    setUint32(0x61746164);                         
    setUint32(length - pos - 4);                   

    for (i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));

    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset++;
    }

    return new Blob([outBuffer], { type: 'audio/wav' });

    function setUint16(data: number) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data: number) { view.setUint32(pos, data, true); pos += 4; }
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
      console.log(`[GeminiService] ${msg}`);
      if (onLog) onLog(msg);
  };

  try {
    log("Step 1/4: Optimizing audio (16kHz Mono) for fast upload...");
    const physicalSegments = await sliceAudioIntoSegments(audioBlob);
    log(`Audio prepared: ${physicalSegments.length} segment(s).`);

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const segmentManifest: {index: number, size: number}[] = [];

    log("Step 2/4: Uploading optimized segments to cloud...");
    for (let i = 0; i < physicalSegments.length; i++) {
        const segmentBlob = physicalSegments[i];
        const totalBytes = segmentBlob.size;
        const CHUNK_SIZE = 4 * 1024 * 1024;
        const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
        
        log(`Uploading Segment ${i+1}/${physicalSegments.length} (${(totalBytes/1024/1024).toFixed(2)} MB)...`);
        
        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
            const start = chunkIdx * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, totalBytes);
            const chunk = segmentBlob.slice(start, end);
            const base64 = await blobToBase64(chunk);
            
            const up = await fetch('/.netlify/functions/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    action: 'upload_chunk', 
                    jobId, 
                    chunkIndex: chunkIdx, 
                    segmentIndex: i, 
                    data: base64 
                })
            });
            if (!up.ok) throw new Error(`Upload failed for segment ${i} chunk ${chunkIdx}`);
        }
        segmentManifest.push({ index: i, size: totalBytes });
    }

    log("Step 3/4: Initializing AI swarm analysis...");
    const triggerResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            jobId, 
            segments: segmentManifest, 
            // We force audio/wav here because sliceAudioIntoSegments always returns wav
            mimeType: 'audio/wav', 
            mode, 
            model, 
            uid 
        })
    });
    if (!triggerResp.ok) throw new Error("Could not start background process.");

    log("Step 4/4: Waiting for results...");
    let attempts = 0;
    while (attempts < 1200) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        const poll = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });
        
        if (poll.ok) {
            const data = await poll.json();
            if (data.lastLog) log(data.lastLog);
            if (data.status === 'COMPLETED') return extractContent(data.result);
            if (data.status === 'ERROR') throw new Error(data.error);
        }
    }
    throw new Error("Analysis timed out.");
  } catch (error) {
    log(`FATAL ERROR: ${error instanceof Error ? error.message : 'Unknown'}`);
    throw error;
  }
};

/**
 * Robustly extracts content from a string using JSON or Tag-based logic.
 * CLEANS UP MARKDOWN ARTIFACTS (like double asterisks) to ensure clean display.
 */
function extractContent(text: string): MeetingData {
    const data: MeetingData = { transcription: '', summary: '', conclusions: [], actionItems: [] };
    if (!text) return data;

    // Helper to remove double asterisks (**Bold**) often returned by Gemini
    const cleanMarkdown = (s: string) => s.replace(/\*\*/g, '').trim();

    const findSection = (tags: string[]) => {
        for (const tag of tags) {
            const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)(?=\\[|$)`, 'i');
            const match = text.match(regex);
            if (match) {
                return cleanMarkdown(match[1]);
            }
        }
        return null;
    };

    data.summary = findSection(['SUMMARY']) || '';
    const rawConclusions = findSection(['CONCLUSIONS']) || '';
    const rawActions = findSection(['ACTIONS']) || '';
    
    // For transcription, we usually prefer to keep some formatting, but user requested clean output
    data.transcription = findSection(['TRANSCRIPTION']) || '';

    // Clean up list items by removing bullets, numbers, and leftover markdown symbols
    const cleanListItem = (line: string) => {
        let cleaned = line.replace(/^[\s\-\*•\d\.\)]+/, ''); // remove bullets/numbers
        return cleanMarkdown(cleaned);
    };

    data.conclusions = rawConclusions.split('\n').map(cleanListItem).filter(l => l.length > 2);
    data.actionItems = rawActions.split('\n').map(cleanListItem).filter(l => l.length > 2);

    return data;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
