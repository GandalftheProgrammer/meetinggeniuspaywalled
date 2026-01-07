
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

// ==================================================================================
// 🧠 PROMPT CONFIGURATION
// ==================================================================================

const PROMPT_SUMMARY_AND_ACTIONS = `
You are an expert meeting analyst. You are provided with the audio of a full meeting (split into chronological parts).
Your task is to analyze the COMPLETE interaction across all audio files and output structured notes.

STRICT OUTPUT FORMAT RULES:
1. Output MUST be in the native language of the speakers.
2. Do NOT use markdown bolding (double asterisks) in headers or lists. Keep text clean.
3. Do NOT make interpretations yourself, stick with interpretations/insights/agreements made by the speakers
4. Use the following specific tags to separate sections:

[SUMMARY]
Provide a summary by describing the relevant things that were discussed. Focus on the content, not on the personal chit chat (unless relevant).

[CONCLUSIONS & INSIGHTS]
List the key conclusions and insights.
- Conclusion/insight 1
- Conclusion/insight 2

[ACTIONS]
List of agreed action items.
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

  // Server logger helper
  const sLog = (step: number, msg: string, meta?: any) => {
     console.log(`[JOB:${jobId}] [STEP ${step}] ${msg}`, meta ? JSON.stringify(meta) : '');
  };

  try {
    const payload = await req.json();
    const { segments, mimeType, mode, model } = payload;
    jobId = payload.jobId;
    if (!jobId) return;

    sLog(9, "Background Process Started", { segmentCount: segments.length, model });

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });

    // Helper to update the UI Pipeline Step
    const setStep = async (stepId: number, status: string, detail: string = "") => {
        const current = await resultStore.get(jobId, { type: "json" }) as any || { status: 'PROCESSING' };
        await resultStore.setJSON(jobId, { 
            ...current, 
            currentStepId: stepId,
            currentStepStatus: status,
            currentStepDetail: detail
        });
    };

    // --- 1. SERVER WAKEUP & REASSEMBLY ---
    await setStep(9, 'processing');
    await new Promise(r => setTimeout(r, 500)); // Fake cold start visual
    await setStep(9, 'completed');

    await setStep(10, 'processing', `Stitching ${segments.length} segments`);
    
    // --- 2. GOOGLE UPLOAD ---
    await setStep(11, 'processing');
    const fileUris: string[] = [];

    for (const seg of segments) {
        const segIdx = seg.index;
        const totalSize = seg.size;
        
        sLog(11, `Initiating Upload for Segment ${segIdx}`, { size: totalSize });

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
                sLog(11, `Flushing Buffer`, { offset, chunkSize: CHUNK_SIZE });
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
                
                // Update granular progress for UI
                const progress = Math.min(99, Math.round((offset / totalSize) * 100));
                await setStep(11, 'processing', `Seg ${segIdx+1} (${progress}%)`);
            }
        }

        sLog(11, `Finalizing Segment ${segIdx}`, { finalSize: buffer.length });
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
        sLog(11, `Segment ${segIdx} Uploaded`, { uri: fileResult.file?.uri });
        fileUris.push(fileResult.file?.uri || fileResult.uri);
    }
    
    await setStep(10, 'completed');
    await setStep(11, 'completed');

    // --- 3. VALIDATION ---
    await setStep(12, 'processing', 'Google Processing...');
    for (const uri of fileUris) {
        sLog(12, `Waiting for file activation`, { uri });
        await waitForFileActive(uri, encodedKey);
    }
    sLog(12, "All files active");
    await setStep(12, 'completed');

    // --- 4. EXECUTE AI TASKS ---
    await setStep(13, 'processing', 'Loading Context...');
    await new Promise(r => setTimeout(r, 800));
    await setStep(13, 'completed');

    const swarmTasks: Promise<any>[] = [];

    // TASK A: SUMMARY
    if (mode !== 'TRANSCRIPT_ONLY') {
        await setStep(14, 'processing', 'Reasoning...');
        swarmTasks.push((async () => {
            const tStart = Date.now();
            sLog(14, "Starting Summary Task");
            const res = await callGeminiWithFiles(
                fileUris, 
                mimeType, 
                model, 
                encodedKey, 
                PROMPT_SUMMARY_AND_ACTIONS
            );
            sLog(14, "Summary Task Complete", { duration: Date.now() - tStart, outputLen: res.text.length });
            return { type: 'NOTES', data: res.text };
        })());
    } else {
        await setStep(14, 'completed', 'Skipped');
    }

    // TASK B: TRANSCRIPTION
    if (mode !== 'NOTES_ONLY') {
        await setStep(15, 'processing', `Transcribing ${fileUris.length} segments...`);
        fileUris.forEach((uri, idx) => {
            swarmTasks.push((async () => {
                const tStart = Date.now();
                sLog(15, `Starting Transcript Task Seg ${idx}`);
                const prompt = `${PROMPT_VERBATIM_TRANSCRIPT}\n(This is segment ${idx+1} of the meeting)`;
                const res = await callGeminiWithFiles(
                    [uri],
                    mimeType, 
                    model, 
                    encodedKey, 
                    prompt
                );
                sLog(15, `Transcript Task Seg ${idx} Complete`, { duration: Date.now() - tStart, outputLen: res.text.length });
                return { type: 'TRANSCRIPT', index: idx, data: res.text };
            })());
        });
    } else {
         await setStep(15, 'completed', 'Skipped');
    }

    // WAIT FOR RESULTS
    const swarmResults = await Promise.all(swarmTasks);
    await setStep(14, 'completed');
    await setStep(15, 'completed');
    
    await setStep(16, 'processing', 'Generating Tokens...');
    
    // --- 5. RECONSTRUCT ---
    const transcriptParts = swarmResults.filter(r => r.type === 'TRANSCRIPT').sort((a, b) => a.index - b.index);
    const notesPart = swarmResults.find(r => r.type === 'NOTES');

    const finalTranscript = transcriptParts.map(p => p.data.trim()).join("\n\n");
    const finalNotes = notesPart ? notesPart.data : "";
    
    await setStep(16, 'completed');

    await setStep(17, 'processing');
    const resultText = `${finalNotes}\n\n[TRANSCRIPTION]\n${finalTranscript}`;
    sLog(17, "Final Result Assembled", { totalLength: resultText.length });
    await setStep(17, 'completed');

    await setStep(18, 'processing', 'Saving...');
    await resultStore.setJSON(jobId, { 
        status: 'COMPLETED', 
        result: resultText
    });
    sLog(18, "Job Completed Successfully");

  } catch (err: any) {
    console.error(`[Background Error] ${err.message}`);
    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    await resultStore.setJSON(jobId, { status: 'ERROR', error: err.message });
  }
};

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

async function callGeminiWithFiles(fileUris: string[], mimeType: string, model: string, encodedKey: string, promptText: string): Promise<{text: string}> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;
    
    const parts: any[] = fileUris.map(uri => ({ file_data: { file_uri: uri, mime_type: mimeType } }));
    parts.push({ text: promptText });

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts }],
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
