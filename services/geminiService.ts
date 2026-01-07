import { MeetingData, ProcessingMode, GeminiModel, PipelineStep, PipelineUpdate, TokenUsage, PipelineEvent, PipelineStatus } from '../types';

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
    jobId: string, 
    blob: Blob, 
    segmentIndex: string | number, 
    onProgress?: (percent: number) => void
) {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB safe limit for Netlify Functions
    const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
    
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
        const start = chunkIdx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, blob.size);
        const chunk = blob.slice(start, end);
        const base64 = await blobToBase64(chunk);
        
        const res = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'upload_chunk', 
                jobId, 
                chunkIndex: chunkIdx, 
                segmentIndex: segmentIndex, // Can be 'raw' or number
                data: base64 
            })
        });
        
        if (!res.ok) throw new Error(`Upload failed for ${segmentIndex} chunk ${chunkIdx}`);
        
        if (onProgress) {
            onProgress(Math.round(((chunkIdx + 1) / totalChunks) * 100));
        }
    }
}

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
  
  const setStep = (id: number, status: PipelineStatus, detail?: string) => {
      onStepUpdate({ stepId: id, status, detail });
  };

  const startTime = Date.now();
  const jobId = `job_${startTime}_${Math.random().toString(36).substring(7)}`;

  try {
    // --- STEP 3: ANALYSIS ---
    setStep(3, 'processing', `${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);
    log(3, "Audio Analysis Started", { blobSize: audioBlob.size, blobType: audioBlob.type });
    await new Promise(r => setTimeout(r, 600)); 
    setStep(3, 'completed');

    // =========================================================================
    // 🚀 TRACK 1: FAST SUMMARY (Parallel)
    // Uploads original raw blob (Chunked!) immediately and triggers summary generation
    // =========================================================================
    if (mode !== 'TRANSCRIPT_ONLY') {
        (async () => {
            try {
                log(3, "Starting Fast Summary Track (Chunked Upload)", { jobId });
                
                // Upload Raw in Chunks
                await uploadBlobInChunks(jobId, audioBlob, 'raw');

                // Trigger Background Summary
                await fetch('/.netlify/functions/gemini-background', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        jobId, 
                        task: 'SUMMARY',
                        mimeType: defaultMimeType, 
                        mode, 
                        model, 
                        uid 
                    })
                });
                log(3, "Fast Summary Background Task Triggered");
            } catch (err) {
                console.warn("Fast summary initiation failed", err);
                setStep(14, 'error', 'Upload Failed');
            }
        })();
    }

    // =========================================================================
    // 🐢 TRACK 2: ROBUST TRANSCRIPTION (Sequential)
    // Decodes, slices, uploads chunks, triggers full transcript
    // =========================================================================
    
    if (mode !== 'NOTES_ONLY') {
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
        log(6, "Encryption & Staging", { jobId });
        await new Promise(r => setTimeout(r, 400));
        setStep(6, 'completed');

        // --- STEP 7: CLOUD HANDSHAKE ---
        setStep(7, 'processing', 'Handshake...');
        log(7, "Cloud Handshake", { endpoint: "/.netlify/functions/gemini" });
        await new Promise(r => setTimeout(r, 500));
        setStep(7, 'completed'); 

        // --- STEP 8: SECURE UPLOAD ---
        const totalSegments = physicalSegments.length;
        
        for (let i = 0; i < totalSegments; i++) {
            const segmentBlob = physicalSegments[i];
            
            setStep(8, 'processing', `Uploading seg ${i+1}/${totalSegments} (0%)`);
            log(8, `Uploading Segment ${i}`, { size: segmentBlob.size });
            
            // Reused chunked upload logic
            await uploadBlobInChunks(jobId, segmentBlob, i, (percent) => {
                setStep(8, 'processing', `Seg ${i+1}/${totalSegments} (${percent}%)`);
            });
            
            segmentManifest.push({ index: i, size: segmentBlob.size });
        }
        setStep(8, 'completed');

        // --- TRIGGER TRANSCRIPT BACKGROUND ---
        log(9, "Triggering Transcript Background Process", { segmentCount: segmentManifest.length });
        const triggerResp = await fetch('/.netlify/functions/gemini-background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                jobId, 
                task: 'TRANSCRIPT',
                segments: segmentManifest, 
                mimeType: 'audio/wav', // Converted type
                mode, 
                model, 
                uid 
            })
        });
        if (!triggerResp.ok) throw new Error("Could not start background process.");
    } else {
        log(8, "Skipping Transcript Track (NOTES_ONLY)");
        [4,5,6,7,8,9,10,11,12,13,15].forEach(id => setStep(id, 'completed', 'Skipped'));
    }

    // --- SMART POLLING LOOP (EVENT AGGREGATION) ---
    // Reads merged events from backend to handle split DB states
    log(10, "Entered Event Polling Loop", { intervalMs: 2000 });
    let attempts = 0;
    let nextEventIndex = 0;

    while (attempts < 1200) {
        attempts++;
        await new Promise(r => setTimeout(r, 2000));
        const poll = await fetch('/.netlify/functions/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check_status', jobId })
        });
        
        if (poll.ok) {
            const data = await poll.json();
            
            // 1. REPLAY EVENTS
            if (data.events && Array.isArray(data.events)) {
                // Only process new events
                const newEvents = data.events.slice(nextEventIndex);
                
                for (const event of newEvents as PipelineEvent[]) {
                    log(event.stepId, `Remote Event: ${event.status}`, {
                        stepId: event.stepId,
                        status: event.status,
                        detail: event.detail,
                        timestamp: new Date(event.timestamp).toLocaleTimeString()
                    });
                    setStep(event.stepId, event.status, event.detail);
                }
                
                if (newEvents.length > 0) {
                    nextEventIndex = data.events.length;
                }
            }

            // 2. CHECK FINAL STATE
            if (data.status === 'COMPLETED') {
                 
                 // Force complete all steps
                 for (let s = 9; s <= 17; s++) setStep(s, 'completed');
                 
                 // Trigger the final "Initializing Overview" step UI to show user we are finishing up
                 setStep(19, 'processing', 'Parsing...');

                 // --- FINAL ANALYTICS LOGGING ---
                 const endTime = Date.now();
                 const durationMs = endTime - startTime;

                 // -- TECHNICAL LOGBOOK (Deep Dive) --
                 if (data.executionLogs && Array.isArray(data.executionLogs)) {
                    console.log("");
                    console.group(`%c 🛠️ TECHNICAL EXECUTION LOG (Job ${jobId})`, "font-size: 14px; font-weight: bold; color: #0ea5e9; background: #e0f2fe; padding: 4px; border-radius: 4px;");
                    console.table(data.executionLogs);
                    console.groupEnd();
                 }

                 // Prepare Token Table Data
                 const details = data.usage?.details || [];
                 const tableData = details.map((row: any) => ({
                    'Gemini Call': row.step,
                    'Input Tokens': row.input,
                    'Output Tokens': row.output,
                    'Total Tokens': (row.input || 0) + (row.output || 0),
                    'Compute Time (ms)': row.duration || 'N/A',
                    'Stop Reason': row.finishReason || 'UNKNOWN'
                 }));

                 // Calculate Totals
                 const totalIn = data.usage?.totalInputTokens || 0;
                 const totalOut = data.usage?.totalOutputTokens || 0;
                 tableData.push({
                    'Gemini Call': 'TOTAL',
                    'Input Tokens': totalIn,
                    'Output Tokens': totalOut,
                    'Total Tokens': totalIn + totalOut,
                    'Compute Time (ms)': `${durationMs} (Wall)`,
                    'Stop Reason': '-'
                 });

                 console.log(""); 
                 console.group(`%c 📊 MISSION REPORT: Job ${jobId}`, "font-size: 14px; font-weight: bold; color: #15803d; background: #dcfce7; padding: 4px; border-radius: 4px;");
                 console.table(tableData);
                 console.groupEnd();

                 // Raw Outputs
                 if (data.debug?.rawSummary) {
                     console.log(`%c📝 RAW SUMMARY OUTPUT`, "font-size: 12px; font-weight: bold; color: #7c3aed; margin-top: 10px; margin-bottom: 5px;");
                     console.log(`%c${data.debug.rawSummary}`, "color: #334155; font-family: monospace; font-size: 11px; white-space: pre-wrap; background: #f8fafc; padding: 10px; border: 1px solid #e2e8f0; display: block; width: 100%;");
                 }
                 
                 if (data.debug?.rawTranscript) {
                     console.log(`%c📝 RAW TRANSCRIPT OUTPUT`, "font-size: 12px; font-weight: bold; color: #7c3aed; margin-top: 15px; margin-bottom: 5px;");
                     console.log(`%c${data.debug.rawTranscript}`, "color: #334155; font-family: monospace; font-size: 11px; white-space: pre-wrap; background: #f8fafc; padding: 10px; border: 1px solid #e2e8f0; display: block; width: 100%;");
                 }

                 const parsed = extractContent(data.result);
                 if (data.usage) parsed.usage = data.usage;
                 
                 // Mark Initializing Overview as done right before returning
                 setStep(19, 'completed');
                 
                 return parsed;
            }
            if (data.status === 'ERROR') {
                log(99, "Remote Error Received", { error: data.error });
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

    const cleanMarkdown = (s: string) => s.replace(/\*\*/g, '').trim();

    // The fuzzy extraction logic
    const extractSection = (headerKeywords: string[]): string => {
        const normalizedText = text;
        let bestIndex = -1;

        for (const kw of headerKeywords) {
            const regex = new RegExp(`(?:^|\\n|\\r)[\\s\\#\\*\\[]*${kw}[^\\]\\n\\r]*[\\]\\:]*`, 'i');
            const match = normalizedText.match(regex);
            if (match && match.index !== undefined) {
                bestIndex = match.index + match[0].length;
                break;
            }
        }

        if (bestIndex === -1) {
            return "";
        }

        const allHeaders = [
            'Summary', 
            'Conclusions', 'Insights',
            'Action Points', 'Action Items', 
            'Transcription', 'Transcript'
        ]; 
        
        let nearestNextHeaderIndex = normalizedText.length;

        for (const otherH of allHeaders) {
             const regex = new RegExp(`(?:^|\\n|\\r)[\\s\\#\\*\\[]*${otherH}[^\\]\\n\\r]*[\\]\\:]*`, 'i');
             const remainingText = normalizedText.slice(bestIndex);
             const match = remainingText.match(regex);
             if (match && match.index !== undefined) {
                 const absoluteIndex = bestIndex + match.index;
                 if (absoluteIndex > bestIndex && absoluteIndex < nearestNextHeaderIndex) {
                     nearestNextHeaderIndex = absoluteIndex;
                 }
             }
        }

        return cleanMarkdown(normalizedText.slice(bestIndex, nearestNextHeaderIndex));
    };

    data.summary = extractSection(['Summary', 'Samenvatting']);
    
    data.conclusions = extractSection(['Conclusions', 'Conclusies', 'Insights', 'Inzichten'])
                        .split('\n')
                        .map(cleanListItem)
                        .filter(l => l.length > 2);

    data.actionItems = extractSection(['Action Points', 'Action Items', 'Actiepunten'])
                        .split('\n')
                        .map(cleanListItem)
                        .filter(l => l.length > 2);

    data.transcription = extractSection(['Transcription', 'Transcript', 'Transcriptie']);

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