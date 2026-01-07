
import { MeetingData, ProcessingMode, GeminiModel, PipelineStep, PipelineUpdate, TokenUsage, PipelineEvent, PipelineStatus } from '../types';

const SEGMENT_DURATION_SECONDS = 1800; // 30 minutes (Reverted as requested)
const TARGET_SAMPLE_RATE = 16000; // 16kHz Mono

export const INITIAL_PIPELINE_STEPS: PipelineStep[] = [
    { id: 1, label: "Input Received", status: 'pending', detail: "Memory Check" },
    { id: 2, label: "Secure Drive Backup", status: 'pending' },
    { id: 3, label: "Audio Analysis", status: 'pending' },
    { id: 4, label: "Optimization", status: 'pending', detail: "16kHz Conv" },
    { id: 5, label: "Segmentation", status: 'pending' },
    { id: 6, label: "Encryption & Staging", status: 'pending' },
    { id: 7, label: "Cloud Handshake", status: 'pending' },
    { id: 8, label: "Secure Upload", status: 'pending' },
    { id: 9, label: "Server Wakeup", status: 'pending' },
    { id: 10, label: "Reassembly", status: 'pending' },
    { id: 11, label: "Google Bridge", status: 'pending', detail: "API Handshake" },
    { id: 12, label: "Validation", status: 'pending' },
    { id: 13, label: "Context Loading", status: 'pending' },
    { id: 14, label: "Summary Analysis", status: 'pending' },
    { id: 15, label: "Transcription", status: 'pending' },
    { id: 16, label: "Token Generation", status: 'pending' },
    { id: 17, label: "Formatting", status: 'pending' },
    { id: 18, label: "Sync", status: 'pending' },
    { id: 19, label: "Initializing Overview", status: 'pending' }
];

// --- HIGH RES LOGGER (Exported for App.tsx) ---
export const log = (stepId: number, title: string, data?: any) => {
    const time = new Date().toISOString().split('T')[1].slice(0, -1); // HH:mm:ss.SSS
    const stepLabel = `STEP ${stepId.toString().padStart(2, '0')}`;
    
    // CSS styling for Chrome DevTools
    console.groupCollapsed(`%c${stepLabel}%c ${title} %c@ ${time}`, 
        'background: #2563eb; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;',
        'color: #1e293b; font-weight: bold;',
        'color: #94a3b8; font-family: monospace;'
    );
    
    if (data) {
        if (typeof data === 'object') {
            console.table(data); 
        } else {
            console.log(data);
        }
    }
    console.groupEnd();
};

// --- HELPER: CHUNKED UPLOAD ---
async function uploadBlobInChunks(
    blob: Blob, 
    jobId: string, 
    segmentId: string | number,
    onProgress?: (progress: number) => void
) {
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks (Standard Netlify limit friendly)
    const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
    
    log(8, `Uploading Segment ${segmentId}`, { size: blob.size, chunks: totalChunks });

    const requests = [];

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(blob.size, start + CHUNK_SIZE);
        const chunk = blob.slice(start, end);
        
        // Convert blob to base64
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
            reader.onloadend = () => {
                const res = reader.result as string;
                // Remove prefix data:audio/...;base64,
                const base64 = res.split(',')[1]; 
                resolve(base64);
            };
        });
        reader.readAsDataURL(chunk);
        const base64Data = await base64Promise;

        // Upload Chunk
        const p = fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'upload_chunk',
                jobId,
                segmentIndex: segmentId,
                chunkIndex: i,
                data: base64Data
            })
        });
        requests.push(p);

        if (onProgress) onProgress(((i + 1) / totalChunks) * 100);
    }
    
    await Promise.all(requests);
}

// --- MAIN FUNCTION: PROCESS MEETING ---
export const processMeetingAudio = async (
    audioBlob: Blob,
    mimeType: string,
    mode: ProcessingMode,
    model: GeminiModel,
    onStepUpdate: (update: PipelineUpdate) => void,
    userId: string
): Promise<MeetingData> => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    log(3, "Starting Process", { jobId, mode, model, blobSize: audioBlob.size });

    // Step 3: Analysis
    onStepUpdate({ stepId: 3, status: 'processing', detail: `${(audioBlob.size / 1024 / 1024).toFixed(1)} MB` });
    
    // Optimize audio (downsample to 16kHz mono) for stability
    onStepUpdate({ stepId: 4, status: 'processing' });
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: TARGET_SAMPLE_RATE });
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    // Extract single channel data
    const offlineCtx = new OfflineAudioContext(1, audioBuffer.length, TARGET_SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start();
    const renderedBuffer = await offlineCtx.startRendering();
    
    // Convert back to WAV Blob
    const wavBlob = bufferToWave(renderedBuffer, renderedBuffer.length);
    onStepUpdate({ stepId: 4, status: 'completed' });
    
    // Step 5: Segmentation (Fixed 30m)
    onStepUpdate({ stepId: 5, status: 'processing' });
    const duration = renderedBuffer.duration;
    const segmentCount = Math.ceil(duration / SEGMENT_DURATION_SECONDS);
    const segments: { index: number, start: number, end: number }[] = [];
    
    log(5, "Segmentation", { duration, segmentCount, segmentSize: SEGMENT_DURATION_SECONDS });

    // We split logic here:
    // 1. Upload the FULL raw file for Summary (Gemini 1.5 Pro can handle huge context)
    // 2. Upload CHUNKS for Transcript (to ensure we don't hit output token limits of 8k per request)
    
    // Helper to extract blob slice
    const getSlice = (startSec: number, endSec: number) => {
        // Calculate byte range roughly (WAV is predictable)
        // 16kHz * 16bit (2 bytes) = 32000 bytes/sec
        // Header is small (44 bytes), ignore for rough slicing or use strict time if re-encoding
        // Since we have a WAV blob, we can slice it, but WAV headers would be missing in slices.
        // Better: Encode slices from the AudioBuffer
        const startFrame = Math.floor(startSec * TARGET_SAMPLE_RATE);
        const endFrame = Math.min(renderedBuffer.length, Math.floor(endSec * TARGET_SAMPLE_RATE));
        
        // Create new buffer for this slice
        const length = endFrame - startFrame;
        const sliceBuffer = audioCtx.createBuffer(1, length, TARGET_SAMPLE_RATE);
        sliceBuffer.copyToChannel(renderedBuffer.getChannelData(0).subarray(startFrame, endFrame), 0);
        return bufferToWave(sliceBuffer, length);
    };

    onStepUpdate({ stepId: 5, status: 'completed', detail: `${segmentCount} Segments` });

    // Step 6-8: Uploading
    // We upload:
    // A) The full 'raw' file (for summary)
    // B) The 30m segments (for transcript)
    
    onStepUpdate({ stepId: 6, status: 'processing' });
    onStepUpdate({ stepId: 7, status: 'processing' });
    
    const uploadPromises = [];

    // A) Upload Full File (Raw)
    uploadPromises.push(uploadBlobInChunks(wavBlob, jobId, 'raw'));

    // B) Upload Segments
    for (let i = 0; i < segmentCount; i++) {
        const start = i * SEGMENT_DURATION_SECONDS;
        const end = Math.min(duration, start + SEGMENT_DURATION_SECONDS);
        const segmentBlob = getSlice(start, end);
        segments.push({ index: i, start, end });
        uploadPromises.push(uploadBlobInChunks(segmentBlob, jobId, i));
    }
    
    onStepUpdate({ stepId: 7, status: 'completed' });
    onStepUpdate({ stepId: 8, status: 'processing', detail: 'Uploading...' });
    
    await Promise.all(uploadPromises);
    onStepUpdate({ stepId: 8, status: 'completed' });

    // Step 9: Server Handshake (Trigger Background Processing)
    onStepUpdate({ stepId: 9, status: 'processing' });
    
    // Trigger SUMMARY
    if (mode === 'ALL' || mode === 'NOTES_ONLY') {
        fetch('/.netlify/functions/gemini-background', {
            method: 'POST',
            body: JSON.stringify({ 
                jobId, 
                task: 'SUMMARY', 
                mode, 
                model, 
                mimeType: 'audio/wav',
                segments: [] // Summary uses 'raw'
            })
        }).catch(e => console.error("Summary Trigger Failed", e));
    }

    // Trigger TRANSCRIPT
    if (mode === 'ALL' || mode === 'TRANSCRIPT_ONLY') {
        fetch('/.netlify/functions/gemini-background', {
            method: 'POST',
            body: JSON.stringify({ 
                jobId, 
                task: 'TRANSCRIPT', 
                mode, 
                model, 
                mimeType: 'audio/wav',
                segments 
            })
        }).catch(e => console.error("Transcript Trigger Failed", e));
    }
    
    onStepUpdate({ stepId: 9, status: 'completed' });
    onStepUpdate({ stepId: 10, status: 'processing', detail: 'Waiting for Server...' });

    // Step 10-18: Polling for Results
    return new Promise((resolve, reject) => {
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
            pollCount++;
            try {
                const r = await fetch('/.netlify/functions/gemini', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'check_status', jobId })
                });
                
                if (!r.ok) return; // Silent retry
                
                const data = await r.json();
                
                // Update Events in UI
                if (data.events && data.events.length > 0) {
                    data.events.forEach((ev: PipelineEvent) => {
                         onStepUpdate({ stepId: ev.stepId, status: ev.status, detail: ev.detail });
                    });
                }
                
                // Check Final Status
                if (data.status === 'COMPLETED') {
                    clearInterval(pollInterval);
                    resolve({
                        transcription: data.result ? (data.result.split('[TRANSCRIPT]')[1] || data.result) : "", // Basic parsing, refined below
                        summary: extractSection(data.result, 'Summary'),
                        conclusions: extractList(data.result, 'Conclusions & Insights'),
                        actionItems: extractList(data.result, 'Action Points'),
                        usage: data.usage
                    });
                } else if (data.status === 'ERROR') {
                    clearInterval(pollInterval);
                    onStepUpdate({ stepId: 19, status: 'error', detail: data.error });
                    reject(new Error(data.error || "Processing failed"));
                }
                
            } catch (e) {
                console.warn("Poll error", e);
            }
            
            // Timeout after 10 minutes (server timeout fallback)
            if (pollCount > 600) { // 600 * 1s = 10m
                clearInterval(pollInterval);
                reject(new Error("Request timed out"));
            }
        }, 1000);
    });
};

// --- WAV CONVERSION HELPER ---
function bufferToWave(abuffer: AudioBuffer, len: number) {
  const numOfChan = 1;
  const length = len * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // write WAVE header
  setUint32(0x46464952);                         // "RIFF"
  setUint32(length - 8);                         // file length - 8
  setUint32(0x45564157);                         // "WAVE"

  setUint32(0x20746d66);                         // "fmt " chunk
  setUint32(16);                                 // length = 16
  setUint16(1);                                  // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(abuffer.sampleRate);
  setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2);                      // block-align
  setUint16(16);                                 // 16-bit (hardcoded in this parser)

  setUint32(0x61746164);                         // "data" - chunk
  setUint32(length - pos - 4);                   // chunk length

  // write interleaved data
  for(i = 0; i < abuffer.numberOfChannels; i++)
    channels.push(abuffer.getChannelData(i));

  while(pos < len) {
    for(i = 0; i < numOfChan; i++) {             // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0; // scale to 16-bit signed int
      view.setInt16(44 + offset * 2, sample, true); // write 16-bit sample
    }
    offset++;
    pos++;
  }

  // create Blob
  return new Blob([buffer], {type: "audio/wav"});

  function setUint16(data: any) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: any) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

// --- PARSING HELPERS ---
function extractSection(text: string, header: string): string {
    if (!text) return "";
    // Regex to find [Header] ... content ... [Next Header]
    // The previous prompt used [Summary], [Conclusions], etc.
    const regex = new RegExp(`\\[${header}\\]([\\s\\S]*?)(?=\\[|$)`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : "";
}

function extractList(text: string, header: string): string[] {
    const section = extractSection(text, header);
    if (!section) return [];
    return section
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('-'))
        .map(line => line.replace(/^-\s*(\[ \]\s*)?/, '').trim());
}
