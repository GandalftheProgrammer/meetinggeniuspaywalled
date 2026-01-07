
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// 5 hours in seconds
const FREE_LIMIT_SECONDS = 18000;

// Define smart fallback sequences for models
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

    console.log(`[Background] Starting job ${jobId}. Mode: ${mode}. Size: ${fileSize}`);

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    const updateStatus = async (msg: string) => { 
        console.log(`[Background] ${msg}`); 
        // We'll update the blob status to communicate back to the UI which step we are on
        const currentData = await resultStore.get(jobId, { type: "json" }) || { status: 'PROCESSING' };
        await resultStore.setJSON(jobId, { ...currentData, lastLog: msg });
    };

    // --- 1. INITIALIZE GEMINI UPLOAD ---
    await updateStatus("Step 1/5: Initializing Cloud Storage...");
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
    await updateStatus("Step 2/5: Uploading audio bytes...");
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

    // --- 3. WAIT FOR ACTIVE & GET DURATION ---
    await updateStatus("Step 3/5: AI listening to file...");
    const fileMetadata = await waitForFileActive(fileUri, encodedKey);
    
    // Duration is in seconds. Extract from videoMetadata.duration (often "123.45s")
    const durationStr = fileMetadata.videoMetadata?.duration || "0s";
    const totalDurationSeconds = parseFloat(durationStr.replace('s', '')) || (fileSize / 16000); // Rough fallback
    const estimatedDurationMinutes = Math.ceil(totalDurationSeconds / 60);

    // --- 4. MULTI-PASS GENERATION ---
    await updateStatus("Step 4/5: Generating high-density notes...");
    
    let summaryData: any = { summary: "", conclusions: [], actionItems: [] };
    if (mode !== 'TRANSCRIPT_ONLY') {
        const notesJson = await callGemini(fileUri, mimeType, "NOTES_ONLY", model, encodedKey);
        try {
            const parsed = JSON.parse(notesJson.replace(/```json/g, '').replace(/```/g, '').trim());
            summaryData = parsed;
        } catch (e) {
            console.error("Notes parse error:", e);
            summaryData.summary = "Summary generated, but parsing failed.";
        }
    }

    let finalTranscription = "";
    if (mode !== 'NOTES_ONLY') {
        // SEGMENTED TRANSCRIPTION FOR LONG FILES
        // We chunk the transcription into 20-minute segments to stay under token limits
        const segmentSizeMinutes = 20;
        const totalSegments = Math.ceil(estimatedDurationMinutes / segmentSizeMinutes);
        
        for (let s = 0; s < totalSegments; s++) {
            const startMin = s * segmentSizeMinutes;
            const endMin = Math.min((s + 1) * segmentSizeMinutes, estimatedDurationMinutes);
            await updateStatus(`Step 5/5: Transcribing segment ${s + 1}/${totalSegments} (${startMin}-${endMin}m)...`);
            
            const segmentPrompt = `Transcribe the audio verbatim from minute ${startMin} to minute ${endMin}. Output raw text only. No summary.`;
            const segmentText = await callGemini(fileUri, mimeType, "SEGMENT", model, encodedKey, segmentPrompt);
            
            finalTranscription += (s > 0 ? "\n\n" : "") + segmentText.trim();
        }
    }

    // --- 5. FINALIZE ---
    const finalResult = {
        transcription: finalTranscription,
        summary: summaryData.summary || "",
        conclusions: summaryData.conclusions || [],
        actionItems: summaryData.actionItems || []
    };

    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: JSON.stringify(finalResult) });

    // Update usage
    if (uid) {
        const profile = await userStore.get(uid, { type: "json" }) as any;
        if (profile && !profile.isPro) {
            profile.secondsUsed += Math.round(totalDurationSeconds);
            await userStore.setJSON(uid, profile);
        }
    }

    console.log(`[Background] Job ${jobId} Completed Successfully.`);

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

async function callGemini(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are an expert meeting secretary.
    1. Detect the primary language and output everything in that language.
    2. Focus on accuracy and verbatim results for transcription.
    3. Use the following instructions based on the request.`;

    let taskInstruction = "";
    let responseMimeType = "text/plain";

    if (mode === 'NOTES_ONLY') {
        responseMimeType = "application/json";
        taskInstruction = `Create detailed structured notes (summary, conclusions, actionItems). 
        Return raw JSON with keys: "summary", "conclusions" (array), "actionItems" (array). 
        Ignore transcription for this call.`;
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
