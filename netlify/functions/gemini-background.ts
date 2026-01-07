
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// ==================================================================================
// 🧠 PROMPT CONFIGURATION
// ==================================================================================

const PROMPT_SUMMARY_AND_ACTIONS = `
You are an expert meeting analyst. You are provided with the audio of a full meeting.
Your task is to analyze the interaction and output structured notes.

CRITICAL INSTRUCTION:
You have a HUGE context window. 
DO NOT SUMMARIZE BRIEFLY. BE EXTREMELY DETAILED.
PROCESS THE ENTIRE AUDIO FILE FROM START TO FINISH.

STRICT OUTPUT FORMAT RULES:
1. Output MUST be in the native language of the speakers (headers must be in English).
2. Do NOT use markdown bolding (double asterisks) in headers or lists.
3. Do NOT make interpretations yourself, stick with interpretations/insights/agreements made by the speakers.
4. Use the following specific (English) headers to separate sections:

[Summary]
Provide a VERY EXTENSIVE, CHRONOLOGICAL summary of the discussion. 
- Capture all main topics, nuances, and arguments.
- Do not leave out details for brevity.

[Conclusions & Insights]
List ALL key conclusions and insights.
- Conclusion/insight 1

[Action Points]
List ALL agreed action items.
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
// 📏 TOKEN DEFINITIONS
// ==================================================================================
const MAX_OUTPUT_TOKENS = 8192;   // Strict Limit for Gemini Flash/Pro Output
const MAX_INPUT_TOKENS = 1048576; // 1M Token Context Window
const MAX_TOTAL_TOKENS = MAX_INPUT_TOKENS + MAX_OUTPUT_TOKENS;

// Thinking Budget Strategy:
// Summary: ~1500 output needed. 8192 - 1500 = ~6600. We set 6000 for thinking to maximize quality.
// Transcript: We do NOT define a thinking budget.
const SUMMARY_THINKING_BUDGET = 6000; 

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  let apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  if (apiKey.startsWith('"') && apiKey.endsWith('"')) apiKey = apiKey.slice(1, -1);
  if (!apiKey) return;

  const encodedKey = encodeURIComponent(apiKey);
  
  // Execution Logbook (Local to this function run)
  const executionLogs: any[] = [];
  const logTechnical = (step: string, action: string, detail: any) => {
      executionLogs.push({ step, action, detail, timestamp: new Date().toISOString() });
  };
  
  try {
    const payload = await req.json();
    const { jobId, task, mode, model, mimeType, segments } = payload;
    
    // Initialize Stores
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // Determine target key based on task to prevent overwrites
    const resultKey = task === 'SUMMARY' ? `${jobId}_summary` : `${jobId}_transcript`;

    // --- HELPER: LOCAL STATE MANAGEMENT ---
    const updateState = async (updater: (s: any) => void) => {
        const state = await resultStore.get(resultKey, { type: "json" }) as any || { events: [], status: 'PROCESSING', executionLogs: [] };
        // Merge local execution logs into state
        if (executionLogs.length > 0) {
             state.executionLogs = [...(state.executionLogs || []), ...executionLogs];
             // Clear local buffer so we don't duplicate if we update state multiple times
             executionLogs.length = 0; 
        }
        updater(state);
        await resultStore.setJSON(resultKey, state);
    };

    const pushEvent = async (stepId: number, status: string, detail: string = "") => {
        await updateState((s) => {
            s.events.push({ timestamp: Date.now(), stepId, status, detail });
        });
    };

    // --- HELPER: ASSEMBLE CHUNKS ---
    const assembleFile = async (segmentId: string | number) => {
        let buffer = Buffer.alloc(0);
        let chunkIdx = 0;
        while(true) {
            const key = `${jobId}/${segmentId}/${chunkIdx}`;
            const b64 = await uploadStore.get(key, { type: 'text' });
            if (!b64) break;
            buffer = Buffer.concat([buffer, Buffer.from(b64, 'base64')]);
            await uploadStore.delete(key); // Cleanup as we go
            chunkIdx++;
        }
        if (buffer.length === 0) throw new Error(`No data found for ${segmentId}`);
        return buffer;
    };

    // --- HELPER: WRAPPED GOOGLE UPLOAD ---
    const wrappedUpload = async (buffer: Buffer, displayName: string) => {
        const start = Date.now();
        const uri = await uploadToGoogle(buffer, displayName, mimeType, encodedKey);
        const duration = Date.now() - start;
        
        // Extract Extension from mimeType for logging
        const ext = mimeType.split('/')[1] || 'bin';
        
        logTechnical('Upload', displayName, { 
            uri, 
            sizeBytes: buffer.length, 
            durationMs: duration,
            fileType: ext
        });
        return uri;
    };

    // --- HELPER: WRAPPED GEMINI CALL ---
    const wrappedGeminiCall = async (fileUris: string[], prompt: string, context: string, thinkingBudget?: number) => {
        const start = Date.now();
        
        // We use the strict constants defined at the top
        const outputLimit = MAX_OUTPUT_TOKENS; 
        
        const res = await callGeminiWithFiles(fileUris, mimeType, model, encodedKey, prompt, outputLimit, thinkingBudget);
        const duration = Date.now() - start;
        
        logTechnical('Gemini', context, {
            files: fileUris,
            model,
            tokenLimits: {
                maxOutput: MAX_OUTPUT_TOKENS,
                maxInput: MAX_INPUT_TOKENS,
                maxTotal: MAX_TOTAL_TOKENS,
                thinkingBudget: thinkingBudget ?? 'NONE'
            },
            promptLen: prompt.length,
            durationMs: duration,
            finishReason: res.finishReason,
            inputTokens: res.usageMetadata.promptTokenCount,
            outputTokens: res.usageMetadata.candidatesTokenCount
        });
        return { ...res, duration };
    };

    // --- TASK 1: FAST SUMMARY (Runs on Raw Audio) ---
    if (task === 'SUMMARY') {
        await pushEvent(14, 'processing', 'Analyzing...');

        // 1. Assemble Raw File from Chunks
        const buffer = await assembleFile('raw');

        // 2. Upload to Google
        const uri = await wrappedUpload(buffer, `Raw_${jobId}`);
        await waitForFileActive(uri, encodedKey);

        // 3. Generate Summary
        const res = await wrappedGeminiCall(
            [uri], 
            PROMPT_SUMMARY_AND_ACTIONS,
            'Summary Generation',
            SUMMARY_THINKING_BUDGET // <--- 6000 Tokens for Thinking
        );

        // 4. Save Result
        await updateState((s) => {
            s.result = res.text;
            s.usage = { 
                totalInputTokens: res.usageMetadata.promptTokenCount,
                totalOutputTokens: res.usageMetadata.candidatesTokenCount,
                details: [{ 
                    step: 'Summary Analysis', 
                    input: res.usageMetadata.promptTokenCount, 
                    output: res.usageMetadata.candidatesTokenCount,
                    finishReason: res.finishReason,
                    duration: res.duration
                }]
            };
            s.status = 'COMPLETED';
            s.events.push({ timestamp: Date.now(), stepId: 14, status: 'completed' });
            
            // If Notes Only mode, we simulate end steps
            if (mode === 'NOTES_ONLY') {
                s.events.push({ timestamp: Date.now(), stepId: 18, status: 'completed' });
            }
        });
    }

    // --- TASK 2: FULL TRANSCRIPT (Runs on Chunks) ---
    else if (task === 'TRANSCRIPT') {
        // Init events for this parallel track
        await pushEvent(9, 'completed'); 
        await pushEvent(10, 'completed'); 
        await pushEvent(11, 'processing', `Uploading segments...`);

        // 1. Upload Segments
        const fileUris: string[] = [];
        
        for (const seg of segments) {
            const buffer = await assembleFile(seg.index);
            const uri = await wrappedUpload(buffer, `Seg_${jobId}_${seg.index}`);
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
        
        const tasks = fileUris.map(async (uri, idx) => {
            const prompt = `${PROMPT_VERBATIM_TRANSCRIPT}\n(Part ${idx+1})`;
            // DO NOT PASS THINKING BUDGET FOR TRANSCRIPTS
            const res = await wrappedGeminiCall([uri], prompt, `Transcript Part ${idx+1}`);
            return { 
                index: idx, 
                text: res.text, 
                usage: res.usageMetadata, 
                finishReason: res.finishReason,
                duration: res.duration
            };
        });
        
        const results = await Promise.all(tasks);
        
        // Sort and Aggregate
        results.sort((a,b) => a.index - b.index);
        const fullTranscript = results.map(r => r.text).join("\n\n");
        
        let totalInput = 0;
        let totalOutput = 0;
        
        // Create granular details for every segment
        const transcriptDetails = results.map(r => {
             totalInput += r.usage.promptTokenCount;
             totalOutput += r.usage.candidatesTokenCount;
             return {
                 step: `Transcript Part ${r.index + 1}`,
                 input: r.usage.promptTokenCount,
                 output: r.usage.candidatesTokenCount,
                 finishReason: r.finishReason,
                 duration: r.duration
             };
        });

        // 4. Save Result
        await updateState((s) => {
            s.result = fullTranscript;
            s.usage = { 
                totalInputTokens: totalInput,
                totalOutputTokens: totalOutput,
                details: transcriptDetails // Granular list instead of merged
            };
            s.status = 'COMPLETED';
            s.events.push({ timestamp: Date.now(), stepId: 15, status: 'completed' });
            // Add final steps
            s.events.push({ timestamp: Date.now(), stepId: 16, status: 'completed' });
            s.events.push({ timestamp: Date.now(), stepId: 17, status: 'completed' });
            s.events.push({ timestamp: Date.now(), stepId: 18, status: 'completed' });
        });
    }

  } catch (err: any) {
    console.error(`[Background Error] ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const payload = await req.json().catch(() => ({ jobId: 'unknown', task: 'unknown' }));
    
    // Fallback error logging to specific key
    const resultKey = payload.task === 'SUMMARY' ? `${payload.jobId}_summary` : `${payload.jobId}_transcript`;
    const currentState = await resultStore.get(resultKey, { type: "json" }) as any || { events: [] };
    
    currentState.status = 'ERROR';
    currentState.error = err.message;
    currentState.events.push({ 
        timestamp: Date.now(), 
        stepId: payload.task === 'SUMMARY' ? 14 : 15, 
        status: 'error', 
        detail: 'Failed' 
    });
    
    await resultStore.setJSON(resultKey, currentState);
  }
};

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
    if (!uploadUrl.includes('key=')) uploadUrl += `?key=${apiKey}`; 

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

async function callGeminiWithFiles(fileUris: string[], mimeType: string, model: string, encodedKey: string, promptText: string, maxOutputTokens: number, thinkingBudget?: number) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;
    const parts: any[] = fileUris.map(uri => ({ file_data: { file_uri: uri, mime_type: mimeType } }));
    parts.push({ text: promptText });

    const config: any = { 
        maxOutputTokens: maxOutputTokens, 
        maxInputTokens: MAX_INPUT_TOKENS, // 1M explicit
        maxTotalTokens: MAX_TOTAL_TOKENS, // 1M + 8192 explicit
        temperature: 0.2,
        topP: 0.95, 
        topK: 40    
    };

    // Apply Thinking Budget if provided (6000 for summary, undefined for transcript)
    // Note: If undefined, thinkingConfig is not sent, disabling the feature or using default model behavior.
    if (thinkingBudget !== undefined) {
        config.thinkingConfig = { thinkingBudget: thinkingBudget };
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
            system_instruction: { parts: [{ text: "You are a precise transcriber/analyst. Do not hallucinate." }] },
            generationConfig: config
        })
    });

    if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`Gemini API Error: ${t}`);
    }
    const data = await resp.json();
    return {
        text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
        usageMetadata: data.usageMetadata || { promptTokenCount: 0, candidatesTokenCount: 0 },
        finishReason: data.candidates?.[0]?.finishReason || 'UNKNOWN'
    };
}
