
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// ==================================================================================
// 🧠 PROMPT CONFIGURATION
// ==================================================================================

const PROMPT_SUMMARY_AND_ACTIONS = `
You are an expert meeting analyst. You are provided with the audio of a full meeting.
Your task is to analyze the interaction and output structured notes.

STRICT OUTPUT FORMAT RULES:
1. Output MUST be in the native language of the speakers (headers must be in English).
2. Do NOT use markdown bolding (double asterisks) in headers or lists.
3. Do NOT make interpretations yourself, stick with interpretations/insights/agreements made by the speakers.
4. Use the following specific (English) headers to separate sections:

[Summary]
Provide a summary by describing the relevant things that were discussed.

[Conclusions & Insights]
List the key conclusions and insights.
- Conclusion/insight 1

[Action Points]
List of agreed action items.
- [ ] Person: Task description

DO NOT output a transcription in this step. ONLY the notes.
`;

const PROMPT_VERBATIM_TRANSCRIPT = `
You are a professional transcriber. You are provided with a specific segment of a meeting.
Your task is to transcribe this audio segment VERBATIM (word-for-word).

CRITICAL RULES:
1. TRANSCRIPT ONLY: Do not summarize.
2. NO HALLUCINATIONS: If the audio is silent or unintelligible, output NOTHING.
3. NO LOOPS: Do NOT repeat words in a loop.
4. Output strictly the transcript text.
`;

// ==================================================================================

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  let apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  if (apiKey.startsWith('"') && apiKey.endsWith('"')) apiKey = apiKey.slice(1, -1);
  if (!apiKey) return;

  const encodedKey = encodeURIComponent(apiKey);
  
  try {
    const payload = await req.json();
    const { jobId, task, mode, model, mimeType, segments } = payload;
    
    // Initialize Stores
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // --- HELPER: EVENT LOGGING ---
    // We fetch the latest state before pushing to minimize overwrites
    const pushEvent = async (stepId: number, status: string, detail: string = "") => {
        const currentState = await resultStore.get(jobId, { type: "json" }) as any || { events: [] };
        // De-duplication check: if last event for this step is same, skip
        const existing = currentState.events.filter((e: any) => e.stepId === stepId);
        if (existing.length > 0) {
            const last = existing[existing.length - 1];
            if (last.status === status && last.detail === detail) return;
        }
        
        currentState.events.push({ timestamp: Date.now(), stepId, status, detail });
        // Preserve other fields
        if (!currentState.status) currentState.status = 'PROCESSING';
        await resultStore.setJSON(jobId, currentState);
    };

    // --- TASK 1: FAST SUMMARY (Runs on Raw Audio) ---
    if (task === 'SUMMARY') {
        // Step 14 (Summary)
        await pushEvent(14, 'processing', 'Analyzing...');

        // 1. Get Raw File
        const rawKey = `${jobId}/raw`;
        const rawBase64 = await uploadStore.get(rawKey, { type: 'text' });
        
        if (!rawBase64) {
            throw new Error("Raw audio file missing for summary task");
        }

        // 2. Upload to Google (Single File)
        const buffer = Buffer.from(rawBase64, 'base64');
        const uri = await uploadToGoogle(buffer, `Raw_${jobId}`, mimeType, encodedKey);
        await waitForFileActive(uri, encodedKey);

        // 3. Generate Summary
        const tStart = Date.now();
        const res = await callGeminiWithFiles(
            [uri], 
            mimeType, 
            model, 
            encodedKey, 
            PROMPT_SUMMARY_AND_ACTIONS
        );

        // 4. Save Partial Result
        let currentState = await resultStore.get(jobId, { type: "json" }) as any || { events: [] };
        currentState.partialSummary = {
            text: res.text,
            usage: { step: 'Summary', input: res.usageMetadata.promptTokenCount, output: res.usageMetadata.candidatesTokenCount }
        };
        await resultStore.setJSON(jobId, currentState);
        
        await pushEvent(14, 'completed');
        
        // Clean up raw file from blob store to save space
        await uploadStore.delete(rawKey);

        // Check if we are done
        await checkFinalize(jobId, resultStore, mode);
    }

    // --- TASK 2: FULL TRANSCRIPT (Runs on Chunks) ---
    else if (task === 'TRANSCRIPT') {
        // Steps 9-13 (Technical Pipeline) & 15 (Transcript)
        await pushEvent(9, 'completed'); 
        await pushEvent(10, 'completed'); // Reassembly assumed handled by manifest

        // 1. Upload Segments
        await pushEvent(11, 'processing', `Uploading ${segments.length} segments`);
        const fileUris: string[] = [];
        
        for (const seg of segments) {
            const segIdx = seg.index;
            // Assemble chunked segment
            let segmentBuffer = Buffer.alloc(0);
            let chunkIdx = 0;
            while(true) {
                const chunkKey = `${jobId}/${segIdx}/${chunkIdx}`;
                const chunkBase64 = await uploadStore.get(chunkKey, { type: 'text' });
                if (!chunkBase64) break;
                segmentBuffer = Buffer.concat([segmentBuffer, Buffer.from(chunkBase64, 'base64')]);
                await uploadStore.delete(chunkKey); // Cleanup
                chunkIdx++;
            }
            
            if (segmentBuffer.length === 0) throw new Error(`Segment ${segIdx} empty`);

            const uri = await uploadToGoogle(segmentBuffer, `Seg_${jobId}_${segIdx}`, mimeType, encodedKey);
            fileUris.push(uri);
        }
        await pushEvent(11, 'completed');

        // 2. Validation
        await pushEvent(12, 'processing');
        for (const uri of fileUris) await waitForFileActive(uri, encodedKey);
        await pushEvent(12, 'completed');

        // 3. Transcript Generation
        await pushEvent(13, 'completed');
        await pushEvent(15, 'processing', `Transcribing ${fileUris.length} parts...`);
        
        const transcriptParts = [];
        let totalUsage = { input: 0, output: 0 };
        
        // Run sequentially to be safe or parallel with Promise.all
        const tasks = fileUris.map(async (uri, idx) => {
            const prompt = `${PROMPT_VERBATIM_TRANSCRIPT}\n(Part ${idx+1})`;
            const res = await callGeminiWithFiles([uri], mimeType, model, encodedKey, prompt);
            return {
                index: idx,
                text: res.text,
                usage: res.usageMetadata
            };
        });
        
        const results = await Promise.all(tasks);
        
        // Sort and Aggregate
        results.sort((a,b) => a.index - b.index);
        const fullTranscript = results.map(r => r.text).join("\n\n");
        results.forEach(r => {
             totalUsage.input += r.usage.promptTokenCount;
             totalUsage.output += r.usage.candidatesTokenCount;
        });

        // 4. Save Partial Result
        let currentState = await resultStore.get(jobId, { type: "json" }) as any || { events: [] };
        currentState.partialTranscript = {
            text: fullTranscript,
            usage: { step: 'Transcript', input: totalUsage.input, output: totalUsage.output }
        };
        await resultStore.setJSON(jobId, currentState);

        await pushEvent(15, 'completed');
        
        await checkFinalize(jobId, resultStore, mode);
    }

  } catch (err: any) {
    console.error(`[Background Error] ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const payload = await req.json().catch(() => ({ jobId: 'unknown' }));
    const currentState = await resultStore.get(payload.jobId, { type: "json" }) as any || { events: [] };
    currentState.status = 'ERROR';
    currentState.error = err.message;
    await resultStore.setJSON(payload.jobId, currentState);
  }
};

// --- HELPER: CHECK IF JOB IS COMPLETE ---
async function checkFinalize(jobId: string, store: any, mode: string) {
    const state = await store.get(jobId, { type: "json" }) as any;
    
    const needsSummary = mode !== 'TRANSCRIPT_ONLY';
    const needsTranscript = mode !== 'NOTES_ONLY';
    
    const hasSummary = !!state.partialSummary;
    const hasTranscript = !!state.partialTranscript;

    // Check conditions
    if ((needsSummary && !hasSummary) || (needsTranscript && !hasTranscript)) {
        return; // Not done yet
    }

    // FINALIZE
    state.events.push({ timestamp: Date.now(), stepId: 16, status: 'completed' });
    state.events.push({ timestamp: Date.now(), stepId: 17, status: 'completed' });
    
    const summaryText = state.partialSummary?.text || "";
    const transcriptText = state.partialTranscript?.text || "";
    
    // Usage Stats
    const usageDetails = [];
    let totalInput = 0; 
    let totalOutput = 0;
    
    if (state.partialSummary?.usage) {
        usageDetails.push(state.partialSummary.usage);
        totalInput += state.partialSummary.usage.input;
        totalOutput += state.partialSummary.usage.output;
    }
    if (state.partialTranscript?.usage) {
        usageDetails.push(state.partialTranscript.usage);
        totalInput += state.partialTranscript.usage.input;
        totalOutput += state.partialTranscript.usage.output;
    }

    state.result = `${summaryText}\n\n[TRANSCRIPT]\n${transcriptText}`;
    state.usage = {
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
        details: usageDetails
    };
    
    state.events.push({ timestamp: Date.now(), stepId: 18, status: 'completed' });
    state.status = 'COMPLETED';
    
    await store.setJSON(jobId, state);
}

// --- HELPER: UPLOAD TO GOOGLE ---
async function uploadToGoogle(buffer: Buffer, displayName: string, mimeType: string, apiKey: string): Promise<string> {
    const initResp = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(buffer.length),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: displayName } })
    });
    
    if (!initResp.ok) throw new Error("Google Upload Handshake failed");
    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("Missing upload URL");
    if (!uploadUrl.includes('key=')) uploadUrl += `?key=${apiKey}`; // append key if needed, though usually in header for upload? No, URL often has it.

    const finalResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(buffer.length),
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
            'Content-Type': 'application/octet-stream'
        },
        body: buffer
    });
    
    const fileResult = await finalResp.json();
    return fileResult.file?.uri || fileResult.uri;
}

async function waitForFileActive(fileUri: string, encodedKey: string) {
    const pollUrl = `${fileUri}?key=${encodedKey}`;
    for (let i = 0; i < 60; i++) {
        const r = await fetch(pollUrl);
        const d = await r.json();
        if ((d.state || d.file?.state) === 'ACTIVE') return;
        if ((d.state || d.file?.state) === 'FAILED') throw new Error("Google File Processing Failed");
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function callGeminiWithFiles(fileUris: string[], mimeType: string, model: string, encodedKey: string, promptText: string) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;
    const parts: any[] = fileUris.map(uri => ({ file_data: { file_uri: uri, mime_type: mimeType } }));
    parts.push({ text: promptText });

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
            system_instruction: { parts: [{ text: "You are a precise transcriber/analyst. Do not hallucinate." }] },
            generationConfig: { maxOutputTokens: 8192, temperature: 0.2 }
        })
    });

    if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`Gemini API Error: ${t}`);
    }
    const data = await resp.json();
    return {
        text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
        usageMetadata: data.usageMetadata || { promptTokenCount: 0, candidatesTokenCount: 0 }
    };
}
