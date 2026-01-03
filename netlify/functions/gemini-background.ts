
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";
// Always use import {GoogleGenAI} from "@google/genai";
import { GoogleGenAI } from "@google/genai";

// 5 hours in seconds (5 * 60 * 60 = 18000)
const FREE_LIMIT_SECONDS = 18000;

// Define smart fallback sequences for models using recommended names from guidelines
const FALLBACK_CHAINS: Record<string, string[]> = {
    'gemini-3-pro-preview': ['gemini-3-pro-preview', 'gemini-flash-latest'],
    'gemini-3-flash-preview': ['gemini-3-flash-preview', 'gemini-flash-latest'],
    'gemini-2.5-pro': ['gemini-2.5-pro', 'gemini-flash-latest'],
    'gemini-2.5-flash': ['gemini-2.5-flash', 'gemini-flash-latest'],
    'gemini-flash-lite-latest': ['gemini-flash-lite-latest', 'gemini-flash-latest'],
    'gemini-flash-latest': ['gemini-flash-latest', 'gemini-flash-lite-latest']
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

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    // Usage check
    const profile = uid ? await userStore.get(uid, { type: "json" }) as any : null;
    const estimatedDuration = Math.round(fileSize / 8000);
    if (profile && !profile.isPro && (profile.secondsUsed + estimatedDuration) > FREE_LIMIT_SECONDS) {
        throw new Error("Free monthly usage limit reached. Please upgrade.");
    }

    const updateStatus = async (msg: string) => { console.log(`[Background] ${msg}`); };

    // --- 1. INITIALIZE GEMINI UPLOAD ---
    // Resumable upload is best for large media processing in background workers
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

    if (!initResp.ok) throw new Error(`Handshake Failed: ${await initResp.text()}`);
    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("No upload URL returned from Google");
    if (!uploadUrl.includes('key=')) {
        uploadUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}key=${encodedKey}`;
    }

    // --- 2. STITCH & UPLOAD ---
    await updateStatus("Checkpoint 2: Stitching and Uploading...");
    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        const chunkKey = `${jobId}/${i}`;
        const chunkBase64 = await uploadStore.get(chunkKey, { type: 'text' });
        if (!chunkBase64) throw new Error(`Missing chunk ${i}`);
        
        const chunkBuffer = Buffer.from(chunkBase64, 'base64');
        buffer = Buffer.concat([buffer, chunkBuffer]);
        await uploadStore.delete(chunkKey);

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
            if (!up.ok) throw new Error(`Chunk Upload Failed: ${up.status}`);
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
    if (!finalResp.ok) throw new Error("Finalize Failed");
    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;

    // --- 4. WAIT FOR ACTIVE ---
    await updateStatus("Checkpoint 4: Waiting for ACTIVE state...");
    await waitForFileActive(fileUri, encodedKey);

    // --- 5. GENERATE CONTENT (SDK REFACTOR) ---
    await updateStatus("Checkpoint 5: Generating Content...");
    const modelsToTry = FALLBACK_CHAINS[model] || [model];
    let resultText = "";
    let generationSuccess = false;

    for (const currentModel of modelsToTry) {
        try {
            // Refactor: Use @google/genai SDK for generation logic as per instructions
            resultText = await generateContentSDK(fileUri, mimeType, mode, currentModel, apiKey);
            generationSuccess = true;
            break;
        } catch (e: any) {
            console.warn(`[Background] Model ${currentModel} failed: ${e.message}`);
            if (e.message.includes('503') || e.message.includes('429')) continue;
            throw e;
        }
    }

    if (!generationSuccess) throw new Error(`Generation failed with all fallbacks.`);

    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

    if (profile && !profile.isPro) {
      profile.secondsUsed += estimatedDuration;
      await userStore.setJSON(uid, profile);
    }

    console.log(`[Background] Job ${jobId} Completed Successfully.`);

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
            if (state === 'FAILED') throw new Error("File processing failed state: FAILED");
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Timeout waiting for ACTIVE");
}

// SDK implementation of generateContent following guideline rules
async function generateContentSDK(fileUri: string, mimeType: string, mode: string, model: string, apiKey: string): Promise<string> {
    const ai = new GoogleGenAI({ apiKey });

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

    const response = await ai.models.generateContent({
        model: model,
        contents: [
            {
                parts: [
                    { fileData: { fileUri: fileUri, mimeType: mimeType } },
                    { text: taskInstruction + "\n\nReturn strict JSON." }
                ]
            }
        ],
        config: {
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            maxOutputTokens: 8192
        }
    });

    // Directly access .text property from GenerateContentResponse
    return response.text || "{}";
}
