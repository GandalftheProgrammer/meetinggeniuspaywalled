
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// 5 hours in seconds
const FREE_LIMIT_SECONDS = 18000;

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

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    const updateStatus = async (msg: string) => { 
        console.log(`[Background] ${msg}`); 
        const currentData = await resultStore.get(jobId, { type: "json" }) || { status: 'PROCESSING' };
        await resultStore.setJSON(jobId, { ...currentData, lastLog: msg });
    };

    // --- 1. PREPARATION ---
    // Log for step 1 already triggered by frontend service
    
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

    const fileMetadata = await waitForFileActive(fileUri, encodedKey);
    const durationStr = fileMetadata.videoMetadata?.duration || "0s";
    const totalDurationSeconds = parseFloat(durationStr.replace('s', '')) || (fileSize / 16000);
    const estimatedDurationMinutes = Math.ceil(totalDurationSeconds / 60);

    // --- 2. NOTES GENERATION ---
    await updateStatus("Step 2/3: Analyzing meeting insights & summary.");
    
    let summaryData: any = { summary: "", conclusions: [], actionItems: [] };
    if (mode !== 'TRANSCRIPT_ONLY') {
        const notesJsonRaw = await callGeminiWithRetry(fileUri, mimeType, "NOTES_ONLY", model, encodedKey);
        const parsed = extractJson(notesJsonRaw);
        if (parsed) {
            summaryData = parsed;
        } else {
            summaryData.summary = "Analysis complete, but details were unexpectedly formatted. Check transcript.";
        }
    }

    // --- 3. TRANSCRIPTION ---
    await updateStatus("Step 3/3: Generating verbatim transcription.");
    
    let finalTranscription = "";
    if (mode !== 'NOTES_ONLY') {
        const segmentSizeMinutes = 20;
        const totalSegments = Math.ceil(estimatedDurationMinutes / segmentSizeMinutes);
        
        for (let s = 0; s < totalSegments; s++) {
            const startMin = s * segmentSizeMinutes;
            const endMin = Math.min((s + 1) * segmentSizeMinutes, estimatedDurationMinutes);
            
            // Per-segment retry wrapper to "keep listening"
            try {
                const segmentPrompt = `Transcribe verbatim: ${startMin}-${endMin} minutes. RAW TEXT ONLY. NO COMMENTARY.`;
                const segmentText = await callGeminiWithRetry(fileUri, mimeType, "SEGMENT", model, encodedKey, segmentPrompt);
                finalTranscription += (s > 0 ? "\n\n" : "") + segmentText.trim();
            } catch (segErr) {
                console.error(`Segment ${s} failed after retries:`, segErr);
                finalTranscription += (s > 0 ? "\n\n" : "") + `[Segment ${startMin}-${endMin}m: Transcription unavailable due to processing error]`;
            }
        }
    }

    const finalResult = {
        transcription: finalTranscription,
        summary: summaryData.summary || "",
        conclusions: summaryData.conclusions || [],
        actionItems: summaryData.actionItems || []
    };

    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: JSON.stringify(finalResult) });

    if (uid) {
        const profile = await userStore.get(uid, { type: "json" }) as any;
        if (profile && !profile.isPro) {
            profile.secondsUsed += Math.round(totalDurationSeconds);
            await userStore.setJSON(uid, profile);
        }
    }

  } catch (err: any) {
    console.error(`[Background] FATAL ERROR: ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
};

async function waitForFileActive(fileUri: string, encodedKey: string): Promise<any> {
    const pollUrl = `${fileUri}?key=${encodedKey}`;
    for (let i = 0; i < 60; i++) {
        const r = await fetch(pollUrl);
        if (r.ok) {
            const d = await r.json();
            const state = d.state || d.file?.state;
            if (state === 'ACTIVE') return d.file || d;
            if (state === 'FAILED') throw new Error("File processing failed state: FAILED");
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Timeout waiting for ACTIVE");
}

function extractJson(text: string): any {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try {
        return JSON.parse(text.substring(start, end + 1));
    } catch (e) {
        return null;
    }
}

async function callGeminiWithRetry(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string, retries = 3): Promise<string> {
    for (let i = 0; i <= retries; i++) {
        try {
            return await callGemini(fileUri, mimeType, mode, model, encodedKey, customPrompt);
        } catch (e) {
            if (i === retries) throw e;
            console.log(`Retry ${i+1}/${retries} after error:`, e);
            await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        }
    }
    throw new Error("Unexpected retry failure");
}

async function callGemini(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are a professional meeting minutes specialist.
    MANDATORY LANGUAGE RULE: 
    1. Identify the primary spoken language in the audio.
    2. Provide the summary, conclusions, and actionItems in that EXACT SAME language.
    3. Do NOT translate into English unless the audio itself is in English.
    
    Transcription must be strictly verbatim.`;

    let taskInstruction = "";
    let responseMimeType = "text/plain";

    if (mode === 'NOTES_ONLY') {
        responseMimeType = "application/json";
        taskInstruction = `Create structured meeting notes. 
        MANDATORY: Return a raw JSON object with keys: "summary" (string), "conclusions" (array of strings), "actionItems" (array of strings).
        All values must be in the detected audio language.`;
    } else {
        taskInstruction = customPrompt || "Transcribe the audio verbatim.";
    }

    const payload = {
        contents: [{
            parts: [
                { file_data: { file_uri: fileUri, mime_type: mimeType } },
                { text: taskInstruction }
            ]
        }],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generation_config: {
            response_mime_type: responseMimeType,
            max_output_tokens: 8192
        }
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) throw new Error(`Gemini Call Failed (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
