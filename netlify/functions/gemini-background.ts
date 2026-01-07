
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

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
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    const updateStatus = async (msg: string) => { 
        console.log(`[Job ${jobId}] ${msg}`); 
        const current = await resultStore.get(jobId, { type: "json" }) as any || { status: 'PROCESSING' };
        await resultStore.setJSON(jobId, { ...current, lastLog: msg });
    };

    // --- 1. UPLOAD PHYSICAL SEGMENTS TO GOOGLE ---
    await updateStatus(`Step 1/3: Moving ${segments.length} physical audio segments to AI Cloud...`);
    const fileUris: string[] = [];

    for (const seg of segments) {
        const segIdx = seg.index;
        const totalSize = seg.size;
        
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
        if (!uploadUrl.includes('key=')) uploadUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}key=${encodedKey}`;

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
            await uploadStore.delete(chunkKey);
            chunkIdx++;

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

    // Wait for all to be ACTIVE
    await updateStatus("Waiting for file activation...");
    for (const uri of fileUris) {
        await waitForFileActive(uri, encodedKey);
    }

    // --- 2. PARALLEL SWARM ---
    await updateStatus("Step 2/3: Launching parallel precision analysis...");
    const swarmTasks: Promise<any>[] = [];

    // Summary Task (receives ALL segments for full context)
    if (mode !== 'TRANSCRIPT_ONLY') {
        swarmTasks.push((async () => {
            const res = await callGeminiWithFiles(fileUris, mimeType, "NOTES_ONLY", model, encodedKey);
            return { type: 'NOTES', data: res.text };
        })());
    }

    // Transcription Tasks (EACH segment task is SANDBOXED to its own file)
    if (mode !== 'NOTES_ONLY') {
        fileUris.forEach((uri, idx) => {
            swarmTasks.push((async () => {
                const prompt = `You are a dedicated transcriber for Segment ${idx+1}. 
                Transcribe ONLY the audio provided in this specific file. 
                Verbatim, no summaries, no intro. Start immediately.`;
                const res = await callGeminiWithFiles([uri], mimeType, "SEGMENT", model, encodedKey, prompt);
                return { type: 'TRANSCRIPT', index: idx, data: res.text };
            })());
        });
    }

    const swarmResults = await Promise.all(swarmTasks);
    
    // --- 3. RECONSTRUCT ---
    await updateStatus("Step 3/3: Reconstructing chronologically...");
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
    for (let i = 0; i < 30; i++) {
        const r = await fetch(pollUrl);
        const d = await r.json();
        if ((d.state || d.file?.state) === 'ACTIVE') return;
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function callGeminiWithFiles(fileUris: string[], mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<{text: string}> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;
    
    const parts: any[] = fileUris.map(uri => ({ file_data: { file_uri: uri, mime_type: mimeType } }));
    
    let taskText = customPrompt || "";
    if (mode === 'NOTES_ONLY') {
        taskText = `Analyze all provided segments. Output strictly using tags: [SUMMARY], [CONCLUSIONS], [ACTIONS]. Use the speakers' native language.`;
    }
    parts.push({ text: taskText });

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
            system_instruction: { parts: [{ text: "High-precision robotic processor. No filler. No conversation. Precise output." }] },
            generation_config: { max_output_tokens: 8192 }
        })
    });

    if (!resp.ok) throw new Error(`Gemini error: ${resp.status}`);
    const data = await resp.json();
    return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || "" };
}
