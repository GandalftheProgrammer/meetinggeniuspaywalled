
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

  // Ensure Gemini SDK uses the key as named parameter as per guidelines
  const ai = new GoogleGenAI({ apiKey: apiKey });
  let jobId: string = "";

  try {
    const payload = await req.json();
    const { totalChunks, mimeType, mode, model, fileSize, uid } = payload;
    jobId = payload.jobId;

    if (!jobId) return new Response("Missing jobId", { status: 400 });

    const userStore = getStore({ name: "user-profiles", consistency: "strong" });
    const profile = uid ? await userStore.get(uid, { type: "json" }) as any : null;

    if (!profile && uid) {
      console.error(`Gemini Background: Profile not found for UID: ${uid}`);
      throw new Error("User profile missing. Please log out and back in.");
    }
    
    // Estimate duration: ~8KB/sec for common opus/compressed audio
    const estimatedDuration = Math.round(fileSize / 8000);
    
    if (profile && !profile.isPro && (profile.secondsUsed + estimatedDuration) > FREE_LIMIT_SECONDS) {
        throw new Error("Free monthly usage limit reached. Please upgrade.");
    }

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // Resumable Handshake - appending key to initial request is standard
    const handshakeUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
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
      const err = await initResp.json();
      throw new Error(`Gemini Handshake failed: ${JSON.stringify(err)}`);
    }

    let uploadUrl = initResp.headers.get('x-goog-upload-url') || "";
    // If the returned uploadUrl doesn't have the key, add it for the subsequent requests
    if (!uploadUrl.includes('key=')) {
        uploadUrl += (uploadUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
    }

    // Upload Loop
    const GEMINI_CHUNK_SIZE = 4 * 1024 * 1024; // Smaller chunks for more reliability
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        const chunkBase64 = await uploadStore.get(`${jobId}/${i}`, { type: 'text' });
        if (!chunkBase64) throw new Error(`Missing chunk data at index ${i}`);
        
        const chunkBuffer = Buffer.from(chunkBase64, 'base64');
        buffer = Buffer.concat([buffer, chunkBuffer]);
        await uploadStore.delete(`${jobId}/${i}`); // Clean up as we go

        while (buffer.length >= GEMINI_CHUNK_SIZE) {
            const chunkToSend = buffer.subarray(0, GEMINI_CHUNK_SIZE);
            buffer = buffer.subarray(GEMINI_CHUNK_SIZE);
            
            const up = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'X-Goog-Upload-Command': 'upload',
                    'X-Goog-Upload-Offset': String(uploadOffset),
                    'Content-Type': 'application/octet-stream'
                },
                body: chunkToSend
            });
            if (!up.ok) throw new Error("Chunk upload failed to Google Storage.");
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    // Finalize upload
    const finalResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': String(uploadOffset),
            'Content-Type': 'application/octet-stream'
        },
        body: buffer
    });

    if (!finalResp.ok) throw new Error("File finalization failed.");

    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;
    
    // Polling for file to become ACTIVE
    let isReady = false;
    for (let i = 0; i < 30; i++) {
        const poll = await fetch(`${fileUri}?key=${apiKey}`);
        const d = await poll.json();
        const state = d.state || d.file?.state;
        if (state === 'ACTIVE') {
            isReady = true;
            break;
        }
        if (state === 'FAILED') throw new Error("File processing state: FAILED.");
        await new Promise(r => setTimeout(r, 2000));
    }

    if (!isReady) throw new Error("File timed out while becoming ACTIVE.");

    // Final AI Generation
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
            transcription: { type: Type.STRING },
            summary: { type: Type.STRING },
            conclusions: { type: Type.ARRAY, items: { type: Type.STRING } },
            actionItems: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["transcription", "summary", "conclusions", "actionItems"]
        }
      }
    });

    const resultText = response.text || "{}";
    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

    if (profile && !profile.isPro) {
      profile.secondsUsed += estimatedDuration;
      await userStore.setJSON(profile.uid, profile);
    }

  } catch (err: any) {
    console.error(`Gemini Background Job ${jobId} Failed:`, err);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    // Stringify error object if it's a raw object from an API response
    const errMsg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
    await resultStore.setJSON(jobId, { status: 'ERROR', error: errMsg });
  }
  
  return new Response("Processing initiated");
};
