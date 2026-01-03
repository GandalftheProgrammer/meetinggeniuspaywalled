
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// 5 hours in seconds
const FREE_LIMIT_SECONDS = 18000;

// Define smart fallback sequences for models to handle 503 Overloads
const FALLBACK_CHAINS: Record<string, string[]> = {
    'gemini-3-pro-preview': ['gemini-3-pro-preview', 'gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-2.5-pro': ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash'],
    'gemini-2.5-flash': ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'],
    'gemini-2.5-flash-lite': ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash'],
    'gemini-2.0-flash': ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    'gemini-2.0-flash-lite': ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
};

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  let apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  if (apiKey.startsWith('"') && apiKey.endsWith('"')) {
      apiKey = apiKey.slice(1, -1);
  }
  
  if (!apiKey) {
      console.error("API_KEY missing");
      return;
  }

  const encodedKey = encodeURIComponent(apiKey);
  let jobId: string = "";

  try {
    const payload = await req.json();
    const { totalChunks, mimeType, mode, model, fileSize, uid } = payload;
    jobId = payload.jobId;

    if (!jobId) return;

    console.log(`[Background] Starting job ${jobId}. Chunks: ${totalChunks}. Size: ${fileSize}`);

    // Results Store
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    // Usage Limit Check
    const profile = uid ? await userStore.get(uid, { type: "json" }) as any : null;
    const estimatedDuration = Math.round(fileSize / 8000); // Rough estimate for limit checking
    
    if (profile && !profile.isPro && (profile.secondsUsed + estimatedDuration) > FREE_LIMIT_SECONDS) {
        throw new Error("Free monthly usage limit reached. Please upgrade.");
    }

    const updateStatus = async (msg: string) => { console.log(`[Background] ${msg}`); };

    // --- 0. PRE-FLIGHT ---
    await updateStatus("Checkpoint 0: Validating API Key...");
    try {
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodedKey}`;
        const testResp = await fetch(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] })
        });
        if (!testResp.ok) throw new Error(`Test Failed (${testResp.status})`);
    } catch (testErr: any) {
        throw new Error(`API Key Rejected in Server Environment. Check restrictions.`);
    }

    // --- 1. INITIALIZE ---
    await updateStatus("Checkpoint 1: Initializing Resumable Upload...");
    const handshakeUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodedKey}`;
    const initResp = await fetch(handshakeUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: `Meeting_${jobId}` } })
    });

    if (!initResp.ok) throw new Error(`Init Handshake Failed: ${await initResp.text()}`);
    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("No upload URL returned");
    if (!uploadUrl.includes('key=')) {
        uploadUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}key=${encodedKey}`;
    }

    // --- 2. STITCH & UPLOAD ---
    await updateStatus("Checkpoint 2: Stitching and Uploading...");
    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        const chunkBase64 = await uploadStore.get(`${jobId}/${i}`, { type: 'text' });
        if (!chunkBase64) throw new Error(`Missing chunk ${i}`);
        
        const chunkBuffer = Buffer.from(chunkBase64, 'base64');
        buffer = Buffer.concat([buffer, chunkBuffer]);
        await uploadStore.delete(`${jobId}/${i}`);

        while (buffer.length >= GEMINI_CHUNK_SIZE) {
            const chunkToSend = buffer.subarray(0, GEMINI_CHUNK_SIZE);
            buffer = buffer.subarray(GEMINI_CHUNK_SIZE);
            const up = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Content-Length': String(GEMINI_CHUNK_SIZE),
                    'X-Goog-Upload-Command': 'upload',
                    'X-Goog-Upload-Offset': String(uploadOffset),
                    'Content-Type': 'application/octet-stream'
                },
                body: chunkToSend
            });
            if (!up.ok) throw new Error(`Chunk Upload Failed (${up.status})`);
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    // --- 3. FINALIZE ---
    await updateStatus("Checkpoint 3: Finalizing Upload...");
    const finalResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(buffer.length),
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': String(uploadOffset),
            'Content-Type': 'application/octet-stream'
        },
        body: buffer
    });
    if (!finalResp.ok) throw new Error(`Finalize Failed (${finalResp.status})`);
    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;

    // --- 4. WAIT FOR ACTIVE ---
    await updateStatus("Checkpoint 4: Waiting for ACTIVE state...");
    await waitForFileActive(fileUri, encodedKey);

    // --- 5. GENERATE ---
    await updateStatus("Checkpoint 5: Generating Content...");
    const modelsToTry = FALLBACK_CHAINS[model] || [model];
    let resultText = "";
    let generationSuccess = false;

    for (const currentModel of modelsToTry) {
        try {
            resultText = await generateContentREST(fileUri, mimeType, mode, currentModel, encodedKey);
            generationSuccess = true;
            break;
        } catch (e: any) {
            if (e.message.includes('503') || e.message.includes('429')) continue;
            throw e;
        }
    }

    if (!generationSuccess) throw new Error(`Generation failed with all fallbacks.`);

    // Save Result
    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

    // Update Usage
    if (profile && !profile.isPro) {
      profile.secondsUsed += estimatedDuration;
      await userStore.setJSON(uid, profile);
    }

    console.log(`[Background] Job ${jobId} Completed.`);

  } catch (err: any) {
    console.error(`[Background] FATAL ERROR: ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
};

async function waitForFileActive(fileUri: string, encodedKey: string) {
    const pollUrl = `${fileUri}?key=${encodedKey}`;
    for (let i = 0; i < 60; i++) {
        const r = await fetch(pollUrl);
        if (r.ok) {
            const d = await r.json();
            const state = d.state || d.file?.state;
            if (state === 'ACTIVE') return;
            if (state === 'FAILED') throw new Error(`File processing failed.`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Polling timeout");
}

async function generateContentREST(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are an expert meeting secretary.
    1. CRITICAL: Analyze the audio to detect the primary spoken language.
    2. CRITICAL: All output (transcription, summary, conclusions, action items) MUST be written in the DETECTED LANGUAGE. Do not translate to English unless the audio is in English.
    3. If the audio is silent or contains only noise, return a valid JSON with empty fields.
    4. Action items must be EXPLICIT tasks only assigned to specific people if mentioned.
    5. The Summary must be DETAILED and COMPREHENSIVE. Do not over-summarize; capture the nuance of the discussion, key arguments, and context.
    6. Conclusions & Insights should be extensive, capturing all decisions, agreed points, and important observations made during the meeting.
    
    STRICT OUTPUT FORMAT:
    You MUST return a raw JSON object (no markdown code blocks) with the following schema:
    {
      "transcription": "The full verbatim transcript...",
      "summary": "A detailed and comprehensive summary of the meeting...",
      "conclusions": ["Detailed conclusion 1", "Detailed insight 2", "Decision 3"],
      "actionItems": ["Task 1", "Task 2"]
    }
    `;

    let taskInstruction = "";
    if (mode === 'TRANSCRIPT_ONLY') taskInstruction = "Transcribe the audio verbatim in the spoken language. Leave summary/conclusions/actionItems empty.";
    else if (mode === 'NOTES_ONLY') taskInstruction = "Create detailed structured notes (summary, conclusions, actionItems) in the spoken language. Leave transcription empty.";
    else taskInstruction = "Transcribe the audio verbatim AND create detailed structured notes in the spoken language.";

    const payload = {
        contents: [{
            parts: [
                { file_data: { file_uri: fileUri, mime_type: mimeType } },
                { text: taskInstruction + "\n\nReturn strict JSON." }
            ]
        }],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generation_config: { response_mime_type: "application/json", max_output_tokens: 8192 },
        safety_settings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    for (let attempts = 0; attempts <= 2; attempts++) {
        try {
            const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (resp.ok) {
                const data = await resp.json();
                return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
            }
            if (resp.status === 503 || resp.status === 429) {
                await new Promise(r => setTimeout(r, 1000 * (attempts + 1)));
                continue;
            }
            throw new Error(`Generation Failed (${resp.status})`);
        } catch (e: any) {
            if (attempts === 2) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error("Unexpected end");
}
