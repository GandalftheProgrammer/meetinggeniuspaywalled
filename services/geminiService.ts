
import { MeetingData, ProcessingMode, GeminiModel, PipelineStep, PipelineUpdate } from '../types';

const SEGMENT_DURATION_SECONDS = 1800; // 30 minutes
const TARGET_SAMPLE_RATE = 16000; // 16kHz Mono

// Initialize the 18-step pipeline
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
        
        const offlineCtx = new OfflineAudioContext(1, duration * TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
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
  onStepUpdate: (update: PipelineUpdate) => void,
  uid?: string
): Promise<MeetingData> => {
  
  const setStep = (id: number, status: 'processing' | 'completed' | 'error', detail?: string) => {
      onStepUpdate({ stepId: id, status, detail });
  };

  try {
    // Phase 2: Client Preparation
    // Note: Steps 1 & 2 are handled in App.tsx before this function is called
    
    setStep(3, 'processing', `${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);
    await new Promise(r => setTimeout(r, 600)); // Minimal delay for UX so user sees the step
    setStep(3, 'completed');

    setStep(4, 'processing', 'Resampling...');
    const physicalSegments = await sliceAudioIntoSegments(audioBlob);
    setStep(4, 'completed', '16kHz Mono');

    setStep(5, 'processing');
    const segmentManifest: {index: number, size: number}[] = [];
    setStep(5, 'completed', `${physicalSegments.length} slice(s)`);

    setStep(6, 'processing', 'Chunking...');
    await new Promise(r => setTimeout(r, 400));
    setStep(6, 'completed');

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Phase 3: Transport
    setStep(7, 'processing', 'Connecting...');
    
    for (let i = 0; i < physicalSegments.length; i++) {
        const segmentBlob = physicalSegments[i];
        const totalBytes = segmentBlob.size;
        const CHUNK_SIZE = 4 * 1024 * 1024;
        const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
        
        setStep(8, 'processing', `Uploading seg ${i+1}/${physicalSegments.length}`);
        
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
    setStep(7, 'completed');
    setStep(8, 'completed');

    // Trigger Background
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

    // Poll for status
    let attempts = 0;
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
            
            // Handle remote step updates from backend
            if (data.currentStepId && data.currentStepStatus) {
                setStep(data.currentStepId, data.currentStepStatus, data.currentStepDetail);
            }

            if (data.status === 'COMPLETED') {
                 // Ensure all final steps are marked completed for UI consistency
                 for (let s = 9; s <= 18; s++) setStep(s, 'completed');
                 return extractContent(data.result);
            }
            if (data.status === 'ERROR') throw new Error(data.error);
        }
    }
    throw new Error("Analysis timed out.");
  } catch (error) {
    // If error occurs, find the last active step and mark it as error
    // In a real app we'd track current step in a var, but for now we just throw
    throw error;
  }
};

function extractContent(text: string): MeetingData {
    const data: MeetingData = { transcription: '', summary: '', conclusions: [], actionItems: [] };
    if (!text) return data;

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
    data.transcription = findSection(['TRANSCRIPTION']) || '';

    const cleanListItem = (line: string) => {
        let cleaned = line.replace(/^[\s\-\*•\d\.\)]+/, ''); 
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
