
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// ==================================================================================
// 🧠 PROMPT CONFIGURATION
// Adjust these prompts to fine-tune the AI's behavior.
// ==================================================================================

const PROMPT_SUMMARY_AND_ACTIONS = `
You are an expert meeting analyst. You are provided with the audio of a full meeting (split into chronological parts).
Your task is to analyze the COMPLETE interaction across all audio files and output structured notes.

STRICT OUTPUT FORMAT RULES:
1. Output MUST be in the native language of the speakers (e.g., Dutch if they speak Dutch, English if they speak English).
2. Do NOT use markdown bolding (double asterisks) in headers or lists. Keep text clean.
3. Use the following specific tags to separate sections:

[SUMMARY]
Provide a comprehensive narrative summary of the meeting. Focus on the core topics, debates, and insights.

[CONCLUSIONS]
List the key decisions and agreements made.
- Conclusion 1
- Conclusion 2

[ACTIONS]
List concrete action items with assignees if mentioned.
- [ ] Person: Task description
- [ ] Person: Task description

DO NOT output a transcription in this step. ONLY the notes.
`;

const PROMPT_VERBATIM_TRANSCRIPT = `
You are a professional transcriber. You are provided with a specific segment of a meeting.
Your task is to transcribe this audio segment VERBATIM (word-for-word).

RULES:
1. Do not summarize. Do not leave out "uhms" or stutters if they change meaning, but generally keep it readable.
2. If the audio is silent or just noise, output nothing.
3. Output strictly the transcript text, no intro or outro.
`;

// ==================================================================================

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response("OK");

  let apiKey = process.env.API_KEY ? process.env.API_KEY.trim() : "";
  if (apiKey.startsWith('"') && apiKey.endsWith('"')) apiKey = apiKey.slice(1, -1);
  if (!apiKey) return;

  const encodedKey = encodeURIComponent(apiKey);
  let jobId: string = "";

  try {
    const payload = await req.json();
    const { segments, mimeType, mode, model, uid } = payload;
    jobId = payload.jobId;
    if (!jobId) return;

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    const updateStatus = async (msg: string) => { 
        console.log(`[Job ${jobId}] ${msg}`); 
        const current = await resultStore.get(jobId, { type: "json" }) as any || { status: 'PROCESSING' };
        await resultStore.setJSON(jobId, { ...current, lastLog: msg });
    };

    // --- 1. UPLOAD PHYSICAL SEGMENTS TO GOOGLE FILE API ---
    // We strictly use the Google File API (resumable upload) for robustness with large files.
    await updateStatus(`Step 1/3: Moving ${segments.length} audio segments to AI Cloud...`);
    const fileUris: string[] = [];

    for (const seg of segments) {
        const segIdx = seg.index;
        const totalSize = seg.size;
        
        // Start Resumable Upload Session
        const handshakeUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodedKey}`;
        const initResp = await fetch(handshakeUrl, {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': String(totalSize),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ file: { display_name: `Segment_${jobId}_${segIdx}` } })
        });

        if (!initResp.ok) throw new Error(`Handshake failed for segment ${segIdx}`);
        let uploadUrl = initResp.headers.get('x-goog-upload-url');
        if (!uploadUrl) throw new Error("Missing upload URL");
        // Ensure API key is attached to the upload URL if missing
        if (!uploadUrl.includes('key=')) uploadUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}key=${encodedKey}`;

        // Stream chunks from Netlify Blob -> Google File API
        let offset = 0;
        const CHUNK_SIZE = 8 * 1024 * 1024;
        let chunkIdx = 0;
        let buffer = Buffer.alloc(0);

        while (true) {
            const chunkKey = `${jobId}/${segIdx}/${chunkIdx}`;
            const chunkBase64 = await uploadStore.get(chunkKey, { type: 'text' });
            if (!chunkBase64) break;
            
            const chunkBuf = Buffer.from(chunkBase64, 'base64');
            buffer = Buffer.concat([buffer, chunkBuf]);
            await uploadStore.delete(chunkKey); // Cleanup blob to save space
            chunkIdx++;

            // Upload in 8MB chunks to Google
            while (buffer.length >= CHUNK_SIZE) {
                const toSend = buffer.subarray(0, CHUNK_SIZE);
                buffer = buffer.subarray(CHUNK_SIZE);
                await fetch(uploadUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Length': String(CHUNK_SIZE),
                        'X-Goog-Upload-Command': 'upload',
                        'X-Goog-Upload-Offset': String(offset),
                        'Content-Type': 'application/octet-stream'
                    },
                    body: toSend
                });
                offset += CHUNK_SIZE;
            }
        }

        // Finalize upload with remaining buffer
        const finalResp = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Content-Length': String(buffer.length),
                'X-Goog-Upload-Command': 'upload, finalize',
                'X-Goog-Upload-Offset': String(offset),
                'Content-Type': 'application/octet-stream'
            },
            body: buffer
        });
        const fileResult = await finalResp.json();
        const uri = fileResult.file?.uri || fileResult.uri;
        fileUris.push(uri);
        await updateStatus(`Segment ${segIdx+1}/${segments.length} uploaded.`);
    }

    // Wait for all files to be processed by Google (State: ACTIVE)
    await updateStatus("Waiting for file activation...");
    for (const uri of fileUris) {
        await waitForFileActive(uri, encodedKey);
    }

    // --- 2. EXECUTE AI TASKS ---
    await updateStatus("Step 2/3: Generating Summary and Transcripts...");
    const swarmTasks: Promise<any>[] = [];

    // TASK A: SUMMARY (Context = ALL Files)
    // We send ALL file URIs to the model in a single request. 
    // Gemini treats this as one long sequence, enabling a full meeting summary.
    if (mode !== 'TRANSCRIPT_ONLY') {
        swarmTasks.push((async () => {
            const res = await callGeminiWithFiles(
                fileUris, // <--- ALL FILES
                mimeType, 
                model, 
                encodedKey, 
                PROMPT_SUMMARY_AND_ACTIONS
            );
            return { type: 'NOTES', data: res.text };
        })());
    }

    // TASK B: TRANSCRIPTION (Context = Per File)
    // We treat each segment individually to speed up processing (parallel) and ensure verbatim accuracy.
    if (mode !== 'NOTES_ONLY') {
        fileUris.forEach((uri, idx) => {
            swarmTasks.push((async () => {
                const prompt = `${PROMPT_VERBATIM_TRANSCRIPT}\n(This is segment ${idx+1} of the meeting)`;
                const res = await callGeminiWithFiles(
                    [uri], // <--- SINGLE FILE
                    mimeType, 
                    model, 
                    encodedKey, 
                    prompt
                );
                return { type: 'TRANSCRIPT', index: idx, data: res.text };
            })());
        });
    }

    const swarmResults = await Promise.all(swarmTasks);
    
    // --- 3. RECONSTRUCT ---
    await updateStatus("Step 3/3: Finalizing report...");
    const transcriptParts = swarmResults.filter(r => r.type === 'TRANSCRIPT').sort((a, b) => a.index - b.index);
    const notesPart = swarmResults.find(r => r.type === 'NOTES');

    const finalTranscript = transcriptParts.map(p => p.data.trim()).join("\n\n");
    const finalNotes = notesPart ? notesPart.data : "";

    await resultStore.setJSON(jobId, { 
        status: 'COMPLETED', 
        result: `${finalNotes}\n\n[TRANSCRIPTION]\n${finalTranscript}` 
    });

  } catch (err: any) {
    console.error(`[Background Error] ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
};

async function waitForFileActive(fileUri: string, encodedKey: string) {
    const pollUrl = `${fileUri}?key=${encodedKey}`;
    for (let i = 0; i < 60; i++) { // Increased polling to 2 mins for large files
        const r = await fetch(pollUrl);
        const d = await r.json();
        if ((d.state || d.file?.state) === 'ACTIVE') return;
        if ((d.state || d.file?.state) === 'FAILED') throw new Error("Google File Processing Failed");
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function callGeminiWithFiles(fileUris: string[], mimeType: string, model: string, encodedKey: string, promptText: string): Promise<{text: string}> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;
    
    const parts: any[] = fileUris.map(uri => ({ file_data: { file_uri: uri, mime_type: mimeType } }));
    parts.push({ text: promptText });

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
            // System instruction helps keep the model purely analytical and non-conversational
            system_instruction: { parts: [{ text: "You are a precise data processing engine. Do not output conversational filler." }] },
            generation_config: { max_output_tokens: 8192, temperature: 0.2 }
        })
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API Error ${resp.status}: ${errText}`);
    }
    const data = await resp.json();
    return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || "" };
}
