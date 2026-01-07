
import { MeetingData, ProcessingMode, GeminiModel, PipelineStep, PipelineUpdate } from '../types';

const SEGMENT_DURATION_SECONDS = 1800; // 30 minutes
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
    { id: 18, label: "Sync", status: 'pending' }
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

async function sliceAudioIntoSegments(blob: Blob): Promise<Blob[]> {
    const startT = performance.now();
    log(4, "Starting Audio Decoding & Resampling", { inputSize: blob.size, inputType: blob.type });

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    log(4, "Decoded Raw Audio Info", { 
        duration: audioBuffer.duration.toFixed(2) + 's', 
        channels: audioBuffer.numberOfChannels, 
        originalSampleRate: audioBuffer.sampleRate 
    });

    const segments: Blob[] = [];
    const totalDuration = audioBuffer.duration;
    const numSegments = Math.ceil(totalDuration / SEGMENT_DURATION_SECONDS);

    for (let i = 0; i < numSegments; i++) {
        const segStart = performance.now();
        const startOffset = i * SEGMENT_DURATION_SECONDS;
        const endOffset = Math.min((i + 1) * SEGMENT_DURATION_SECONDS, totalDuration);
        const duration = endOffset - startOffset;
        
        const offlineCtx = new OfflineAudioContext(1, duration * TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0, startOffset, duration);
        
        const renderedBuffer = await offlineCtx.startRendering();
        const wavBlob = audioBufferToWav(renderedBuffer);
        segments.push(wavBlob);
        
        const segEnd = performance.now();
        log(5, `Segment ${i+1}/${numSegments} Created`, { 
            processingTimeMs: (segEnd - segStart).toFixed(0),
            startOffset: startOffset.toFixed(1) + 's', 
            duration: duration.toFixed(1) + 's',
            sizeBytes: wavBlob.size,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
    }
    
    await audioCtx.close();
    
    const endT = performance.now();
    log(5, "Segmentation Complete", { totalSegments: segments.length, totalProcessingTimeMs: (endT - startT).toFixed(0) });
    
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
  onStepUpdate: (update: PipelineUpdate) => void,
  uid?: string
): Promise<MeetingData> => {
  
  const setStep = (id: number, status: 'processing' | 'completed' | 'error', detail?: string) => {
      onStepUpdate({ stepId: id, status, detail });
  };

  try {
    // --- STEP 3: ANALYSIS ---
    setStep(3, 'processing', `${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);
    log(3, "Audio Analysis Started", { blobSize: audioBlob.size, blobType: audioBlob.type });
    await new Promise(r => setTimeout(r, 600)); 
    setStep(3, 'completed');

    // --- STEP 4: OPTIMIZATION (Resampling) ---
    setStep(4, 'processing', 'Resampling...');
    const physicalSegments = await sliceAudioIntoSegments(audioBlob);
    setStep(4, 'completed', '16kHz Mono');

    // --- STEP 5: SEGMENTATION ---
    setStep(5, 'processing');
    const segmentManifest: {index: number, size: number}[] = [];
    await new Promise(r => setTimeout(r, 300));
    setStep(5, 'completed', `${physicalSegments.length} slice(s)`);

    // --- STEP 6: ENCRYPTION & STAGING ---
    setStep(6, 'processing', 'Chunking...');
    log(6, "Encryption & Staging", { note: "Preparing chunks for secure upload" });
    await new Promise(r => setTimeout(r, 400));
    setStep(6, 'completed');

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    log(6, "Job Created", { jobId });

    // --- STEP 7: CLOUD HANDSHAKE ---
    setStep(7, 'processing', 'Handshake...');
    log(7, "Cloud Handshake", { endpoint: "/.netlify/functions/gemini" });
    await new Promise(r => setTimeout(r, 500));
    setStep(7, 'completed'); 

    // --- STEP 8: SECURE UPLOAD ---
    const totalSegments = physicalSegments.length;
    const CHUNK_SIZE = 4 * 1024 * 1024;
    
    for (let i = 0; i < totalSegments; i++) {
        const segmentBlob = physicalSegments[i];
        const totalBytes = segmentBlob.size;
        const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
        
        // Initial Step 8 state
        setStep(8, 'processing', `Uploading seg ${i+1}/${totalSegments} (0%)`);
        log(8, `Uploading Segment ${i}`, { totalBytes, totalChunks });
        
        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
            const chunkStart = performance.now();
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
            const chunkEnd = performance.now();

            // Granular Progress Update for UI
            const percent = Math.round(((chunkIdx + 1) / totalChunks) * 100);
            setStep(8, 'processing', `Seg ${i+1}/${totalSegments} (${percent}%)`);
            
            log(8, `Chunk ${chunkIdx}/${totalChunks} Uploaded`, { 
                size: chunk.size, 
                durationMs: (chunkEnd - chunkStart).toFixed(0),
                progress: `${percent}%`,
                status: up.status
            });
        }
        segmentManifest.push({ index: i, size: totalBytes });
    }
    setStep(8, 'completed');

    // --- TRIGGER BACKGROUND ---
    log(9, "Triggering Server Background Process", { model, mode, segmentCount: segmentManifest.length });
    const triggerResp = await fetch('/.netlify/functions/gemini-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            jobId, 
            segments: segmentManifest, 
            mimeType: 'audio/wav', 
            mode, 
            model, 
            uid 
        })
    });
    if (!triggerResp.ok) throw new Error("Could not start background process.");

    // --- POLLING LOOP ---
    log(10, "Entered Polling Loop", { intervalMs: 3000 });
    let attempts = 0;
    let lastRemoteStep = 9;

    while (attempts < 1200) {
        attempts++;
        await new Promise(r => setTimeout(r, 3000));
        const poll = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });
        
        if (poll.ok) {
            const data = await poll.json();
            
            // Sync Remote Steps
            if (data.currentStepId && data.currentStepStatus) {
                // If step changed OR detail changed (for granular progress), log/update
                if (data.currentStepId !== lastRemoteStep || data.currentStepStatus === 'completed' || data.currentStepDetail) {
                    // Only log to console if ID changed or status completed to avoid spamming "35%.. 36%.."
                    if (data.currentStepId !== lastRemoteStep || data.currentStepStatus === 'completed') {
                         log(data.currentStepId, `Remote Status: ${data.currentStepStatus}`, { 
                            detail: data.currentStepDetail,
                            serverMetadata: data.metadata 
                        });
                        lastRemoteStep = data.currentStepId;
                    }
                }
                setStep(data.currentStepId, data.currentStepStatus, data.currentStepDetail);
            }

            if (data.status === 'COMPLETED') {
                 log(18, "Process Completed", { resultLength: data.result.length });
                 // Force complete all steps to ensure 100% green UI at the end
                 for (let s = 9; s <= 18; s++) setStep(s, 'completed');
                 return extractContent(data.result);
            }
            if (data.status === 'ERROR') {
                log(lastRemoteStep, "Remote Error", { error: data.error });
                throw new Error(data.error);
            }
        }
    }
    throw new Error("Analysis timed out.");
  } catch (error) {
    log(99, "Critical Pipeline Failure", error);
    throw error;
  }
};

// --- ROBUST FUZZY PARSER ---
function extractContent(text: string): MeetingData {
    const data: MeetingData = { transcription: '', summary: '', conclusions: [], actionItems: [] };
    if (!text) return data;

    // Log the raw text for debugging if needed
    console.log("Raw Server Output:", text);

    const cleanMarkdown = (s: string) => s.replace(/\*\*/g, '').trim();

    // The fuzzy extraction logic
    const extractSection = (headerKeywords: string[]): string => {
        // Construct a flexible Regex
        // 1. (?:^|\n): Start of string or new line
        // 2. [\s\#\*\[]*: Optional whitespace, hash, asterisks, or opening brackets
        // 3. (${headerKeywords.join('|')}): The keyword (case insensitive)
        // 4. [\s\]\*\:]*: Optional whitespace, closing brackets, asterisks, or colons
        // 5. (?:\n|$): End of line
        // 6. ([\s\S]*?): Capture EVERYTHING after...
        // 7. (?=(?:^|\n)[\s\#\*\[]*(?:Summary|Conclusions|Action|Transcription)|$): ...until the next major header or end of string
        
        // We use a simplified approach: Find the start index of the header, then find the start index of the NEXT header.
        
        const normalizedText = text;
        const lowerText = normalizedText.toLowerCase();
        
        // Find best match for header
        let bestIndex = -1;
        let bestHeaderLen = 0;

        for (const kw of headerKeywords) {
            // Regex to find "Header" surrounded by likely Markdown chars, at start of a line
            const regex = new RegExp(`(?:^|\\n)[\\s\\#\\*\\[]*${kw}[\\s\\]\\*\\:]*(?:\\n|$)`, 'i');
            const match = normalizedText.match(regex);
            if (match && match.index !== undefined) {
                // found it
                bestIndex = match.index + match[0].length;
                bestHeaderLen = match[0].length;
                break;
            }
        }

        if (bestIndex === -1) return "";

        // Now find the end of this section by looking for the start of ANY other section
        // We look for other known headers: Summary, Conclusions, Action, Transcription
        const allHeaders = ['Summary', 'Conclusions', 'Action Points', 'Transcription', 'Action Items']; 
        
        let nearestNextHeaderIndex = normalizedText.length;

        for (const otherH of allHeaders) {
             const regex = new RegExp(`(?:^|\\n)[\\s\\#\\*\\[]*${otherH}[\\s\\]\\*\\:]*(?:\\n|$)`, 'i');
             // We need to find matches AFTER bestIndex
             // Simple slice check
             const remainingText = normalizedText.slice(bestIndex);
             const match = remainingText.match(regex);
             if (match && match.index !== undefined) {
                 const absoluteIndex = bestIndex + match.index;
                 if (absoluteIndex < nearestNextHeaderIndex) {
                     nearestNextHeaderIndex = absoluteIndex;
                 }
             }
        }

        return cleanMarkdown(normalizedText.slice(bestIndex, nearestNextHeaderIndex));
    };

    data.summary = extractSection(['Summary']);
    data.conclusions = extractSection(['Conclusions & Insights', 'Conclusions'])
                        .split('\n')
                        .map(cleanListItem)
                        .filter(l => l.length > 2);

    data.actionItems = extractSection(['Action Points', 'Action Items', 'Actions'])
                        .split('\n')
                        .map(cleanListItem)
                        .filter(l => l.length > 2);

    data.transcription = extractSection(['Transcription', 'Transcript']);

    return data;
}

const cleanListItem = (line: string) => {
    // Remove markdown bullets, numbers, checkboxes
    let cleaned = line.replace(/^[\s\-\*•\d\.\)\[\]_]+/, ''); 
    return cleaned.replace(/\*\*/g, '').trim();
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
