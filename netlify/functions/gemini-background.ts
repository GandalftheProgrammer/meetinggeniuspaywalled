
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
    console.error("Gemini Background: API_KEY is missing.");
    return new Response("API_KEY missing", { status: 500 });
  }

  const encodedKey = encodeURIComponent(apiKey);
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
    
    const estimatedDuration = Math.round(fileSize / 8000);
    
    if (profile && !profile.isPro && (profile.secondsUsed + estimatedDuration) > FREE_LIMIT_SECONDS) {
        throw new Error("Free monthly usage limit reached. Please upgrade.");
    }

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // 1. INITIALIZE UPLOAD
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

    if (!initResp.ok) throw new Error(`Handshake failed: ${await initResp.text()}`);

    let uploadUrl = initResp.headers.get('x-goog-upload-url') || "";
    if (!uploadUrl.includes('key=')) {
        const sep = uploadUrl.includes('?') ? '&' : '?';
        uploadUrl = `${uploadUrl}${sep}key=${encodedKey}`;
    }

    // 2. STITCH & UPLOAD
    const GEMINI_CHUNK_SIZE = 4 * 1024 * 1024; 
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
                    'X-Goog-Upload-Command': 'upload',
                    'X-Goog-Upload-Offset': String(uploadOffset),
                    'Content-Type': 'application/octet-stream'
                },
                body: chunkToSend
            });
            uploadOffset += GEMINI_CHUNK_SIZE;
        }
    }

    const finalResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': String(uploadOffset),
            'Content-Type': 'application/octet-stream'
        },
        body: buffer
    });
    if (!finalResp.ok) throw new Error("Finalize failed");

    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;
    
    // 3. POLL FOR ACTIVE
    let isReady = false;
    for (let i = 0; i < 60; i++) {
        const poll = await fetch(`${fileUri}?key=${encodedKey}`);
        const d = await poll.json();
        const state = d.state || d.file?.state;
        if (state === 'ACTIVE') { isReady = true; break; }
        await new Promise(r => setTimeout(r, 2000));
    }
    if (!isReady) throw new Error("File polling timeout");

    // 4. GENERATE CONTENT (with robust instructions and explicit schema)
    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3-flash-preview'}:generateContent?key=${encodedKey}`;
    
    const systemInstructionText = `You are an expert meeting secretary.
    1. CRITICAL: Analyze the audio to detect the primary language.
    2. CRITICAL: All output (transcription, summary, conclusions, action items) MUST be in the DETECTED LANGUAGE.
    3. Transcription must be verbatim. Summary must be detailed and capture nuances.
    4. Conclusions must be an array of key insights. Action items must be an array of explicit tasks.`;

    const generateResp = await fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { file_data: { file_uri: fileUri, mime_type: mimeType } },
                    { text: "Generate the meeting minutes now. Ensure the summary is comprehensive and the transcription is full." }
                ]
            }],
            system_instruction: {
                parts: [{ text: systemInstructionText }]
            },
            generation_config: {
                response_mime_type: "application/json",
                max_output_tokens: 8192,
                response_schema: {
                  type: "object",
                  properties: {
                    transcription: { type: "string" },
                    summary: { type: "string" },
                    conclusions: { type: "array", items: { type: "string" } },
                    actionItems: { type: "array", items: { type: "string" } }
                  },
                  required: ["transcription", "summary", "conclusions", "actionItems"]
                }
            },
            safety_settings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        })
    });

    if (!generateResp.ok) throw new Error(`Generation error: ${generateResp.status}`);

    const genData = await generateResp.json();
    const resultText = genData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: resultText });

    if (profile && !profile.isPro) {
      profile.secondsUsed += estimatedDuration;
      await userStore.setJSON(profile.uid, profile);
    }

  } catch (err: any) {
    console.error(`Gemini Background Job Failed:`, err);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
  
  return new Response("Processing initiated");
};
