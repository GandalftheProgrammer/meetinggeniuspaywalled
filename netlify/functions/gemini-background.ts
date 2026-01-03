
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";
import { GoogleGenAI, Type } from "@google/genai";

// 5 hours in seconds
const FREE_LIMIT_SECONDS = 18000;

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error("Gemini Background: API_KEY is missing in environment.");
    return new Response("API_KEY missing", { status: 500 });
  }

  const ai = new GoogleGenAI({ apiKey });
  let jobId: string = "";

  try {
    const payload = await req.json();
    const { totalChunks, mimeType, mode, model, fileSize, uid } = payload;
    jobId = payload.jobId;

    if (!jobId) return new Response("Missing jobId", { status: 400 });

    // --- USAGE CHECK ---
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });
    const profile = uid ? await userStore.get(uid, { type: "json" }) as any : null;

    if (!profile && uid) {
      console.error(`Gemini Background: Profile not found for UID: ${uid}`);
      throw new Error("User account profile not found. Please logout and login again.");
    }
    
    // Estimate duration from fileSize (roughly 64kbps audio = 8KB/s)
    const estimatedDuration = Math.round(fileSize / 8000);
    
    if (profile && !profile.isPro && (profile.secondsUsed + estimatedDuration) > FREE_LIMIT_SECONDS) {
        throw new Error("Free monthly usage limit reached. Please upgrade to Pro.");
    }

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // Handshake
    const encodedKey = encodeURIComponent(apiKey);
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

    if (!initResp.ok) {
      const err = await initResp.text();
      throw new Error(`Gemini File Handshake failed: ${err}`);
    }

    let uploadUrl = initResp.headers.get('x-goog-upload-url') || "";
    if (!uploadUrl.includes('key=')) uploadUrl += (uploadUrl.includes('?') ? '&' : '?') + `key=${encodedKey}`;

    // Upload Loop
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
            await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Content-Length': String(GEMINI_CHUNK_SIZE),
                    'X-Goog-Upload-Command': 'upload',
                    'X-Goog-Upload-Offset': String(uploadOffset),
                    'Content-Type': 'application/octet-stream'
                },
                body: chunkToSend
            });
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    // Finalize
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

    if (!finalResp.ok) {
      const err = await finalResp.text();
      throw new Error(`Gemini File Finalize failed: ${err}`);
    }

    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;
    
    // Polling ACTIVE
    let activeAttempts = 0;
    while (activeAttempts < 60) {
        const poll = await fetch(`${fileUri}?key=${encodedKey}`);
        const d = await poll.json();
        const state = d.state || d.file?.state;
        if (state === 'ACTIVE') break;
        if (state === 'FAILED') throw new Error("Gemini file processing failed (state: FAILED).");
        await new Promise(r => setTimeout(r, 2000));
        activeAttempts++;
    }

    // Generate using Gemini SDK
    const response = await ai.models.generateContent({
      model: model || 'gemini-3-flash-preview',
      contents: {
        parts: [
          { fileData: { fileUri: fileUri, mimeType: mimeType } },
          { text: "Transcribe and summarize this meeting recording." }
        ]
      },
      config: {
        systemInstruction: "You are an expert meeting secretary. Analyze audio to detect the primary language. All output MUST be in the DETECTED LANGUAGE.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcription: { type: Type.STRING, description: "Full transcript of the meeting." },
            summary: { type: Type.STRING, description: "Executive summary of the meeting." },
            conclusions: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Key insights and conclusions." },
            actionItems: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of actionable items and owners if identified." }
          },
          required: ["transcription", "summary", "conclusions", "actionItems"]
        }
      }
    });

    const resultText = response.text || "{}";

    // Save Result
    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

    // Update Usage after successful generation
    if (profile && !profile.isPro) {
      profile.secondsUsed += estimatedDuration;
      await userStore.setJSON(profile.uid, profile);
    }

  } catch (err: any) {
    console.error(`Gemini Background Job ${jobId} Failed:`, err);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
  
  return new Response("Processing started");
};
