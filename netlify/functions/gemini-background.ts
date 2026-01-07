
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
    const { totalChunks, mimeType, mode, model, fileSize, uid } = payload;
    jobId = payload.jobId;
    if (!jobId) return;

    const resultStore = getStore({ name: "meeting-results", consistency: "strong" });
    const uploadStore = getStore({ name: "meeting-uploads", consistency: "strong" });
    const userStore = getStore({ name: "user-profiles", consistency: "strong" });

    const updateStatus = async (msg: string) => { 
        console.log(`[Background] ${msg}`); 
        const currentData = await resultStore.get(jobId, { type: "json" }) as any || { status: 'PROCESSING' };
        await resultStore.setJSON(jobId, { ...currentData, lastLog: msg });
    };

    // --- 1. UPLOAD TO GOOGLE STORAGE ---
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

    if (!initResp.ok) throw new Error(`Storage handshake failed`);
    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("Missing upload URL");
    if (!uploadUrl.includes('key=')) uploadUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}key=${encodedKey}`;

    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        const chunkKey = `${jobId}/${i}`;
        const chunkBase64 = await uploadStore.get(chunkKey, { type: 'text' });
        if (!chunkBase64) throw new Error(`Missing audio chunk ${i}`);
        
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
            if (!up.ok) throw new Error(`Chunk transmission error`);
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
    if (!finalResp.ok) throw new Error("Final transmission failed");
    const fileResult = await finalResp.json();
    const fileUri = fileResult.file?.uri || fileResult.uri;

    const fileMetadata = await waitForFileActive(fileUri, encodedKey);
    const durationStr = fileMetadata.videoMetadata?.duration || "0s";
    const totalDurationSeconds = parseFloat(durationStr.replace('s', '')) || (fileSize / 16000);

    // --- 2. PARALLEL SWARM ---
    await updateStatus(`Step 2/3: Launching swarm (Duration: ${Math.round(totalDurationSeconds)}s)...`);

    const segmentMinutes = 7;
    const totalSegments = Math.ceil(totalDurationSeconds / (segmentMinutes * 60));
    
    let completedCount = 0;
    const totalTasks = (mode === 'TRANSCRIPT_ONLY' ? 0 : 1) + (mode === 'NOTES_ONLY' ? 0 : totalSegments);

    const swarmTasks: Promise<any>[] = [];

    // Summary Task
    if (mode !== 'TRANSCRIPT_ONLY') {
        swarmTasks.push((async () => {
            const result = await callGeminiWithRetry(fileUri, mimeType, "NOTES_ONLY", model, encodedKey);
            completedCount++;
            await updateStatus(`[DEBUG] Task ${completedCount}/${totalTasks} (SUMMARY) | Tokens: ${result.tokens} | Reason: ${result.finishReason}`);
            return { type: 'NOTES', data: result.text };
        })());
    }

    // Transcription Tasks - HARD CUT (0 overlap)
    if (mode !== 'NOTES_ONLY') {
        for (let s = 0; s < totalSegments; s++) {
            const startSec = s * segmentMinutes * 60;
            const endSec = Math.min((s + 1) * segmentMinutes * 60, totalDurationSeconds);
            const startFmt = formatSeconds(startSec);
            const endFmt = formatSeconds(endSec);

            swarmTasks.push((async () => {
                const prompt = `Transcribe verbatim from exactly ${startFmt} to exactly ${endFmt}. 
                DO NOT add any intro text or filler. Start immediately with the speech. 
                Match the exact language of the speakers. No summaries, only raw text.`;
                const result = await callGeminiWithRetry(fileUri, mimeType, "SEGMENT", model, encodedKey, prompt);
                completedCount++;
                const first50 = result.text.substring(0, 50).replace(/\n/g, ' ');
                const last50 = result.text.substring(Math.max(0, result.text.length - 50)).replace(/\n/g, ' ');
                await updateStatus(`[DEBUG] Task ${completedCount}/${totalTasks} (SEGMENT ${s}) | Tokens: ${result.tokens} | Range: ${startFmt}-${endFmt} | Start: "${first50}..." | End: "...${last50}"`);
                return { type: 'TRANSCRIPT', index: s, data: result.text };
            })());
        }
    }

    const swarmResults = await Promise.all(swarmTasks);
    await updateStatus("Step 3/3: Reconstructing final document...");

    const transcriptParts = swarmResults.filter(r => r.type === 'TRANSCRIPT').sort((a, b) => a.index - b.index);
    const notesPart = swarmResults.find(r => r.type === 'NOTES');

    // Hard stitch transcription
    const finalTranscription = transcriptParts.map(p => p.data.trim()).join(" ");
    let finalNotes = notesPart ? notesPart.data : "";

    await resultStore.setJSON(jobId, { status: 'COMPLETED', result: `${finalNotes}\n\n[TRANSCRIPTION]\n${finalTranscription}` });

    if (uid) {
        const profile = await userStore.get(uid, { type: "json" }) as any;
        if (profile && !profile.isPro) {
            profile.secondsUsed += Math.round(totalDurationSeconds);
            await userStore.setJSON(uid, profile);
        }
    }

  } catch (err: any) {
    console.error(`[Background] Error: ${err.message}`);
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
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Cloud file processing timeout");
}

function formatSeconds(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

async function callGeminiWithRetry(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<{text: string, tokens: number, finishReason: string}> {
    for (let i = 0; i < 3; i++) {
        try {
            return await callGemini(fileUri, mimeType, mode, model, encodedKey, customPrompt);
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(r => setTimeout(r, 4000 * (i + 1)));
        }
    }
    return { text: "", tokens: 0, finishReason: "FAILED" };
}

async function callGemini(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<{text: string, tokens: number, finishReason: string}> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are a robotic, high-precision meeting processor. 
    Strict Rule 1: No conversational filler or polite intros.
    Strict Rule 2: Analyze which language the speaker(s) are speaking. You MUST use the speakers' own language in your response output.
    Strict Rule 3: If transcribing, provide 100% verbatim text only.
    Strict Rule 4: If providing notes, use tags [SUMMARY], [CONCLUSIONS], [ACTIONS].`;

    let taskInstruction = "";
    if (mode === 'NOTES_ONLY') {
        taskInstruction = `Analyze the meeting content. 
        MANDATORY FORMAT:
        [SUMMARY]
        ...text...
        [CONCLUSIONS]
        ...one point per line...
        [ACTIONS]
        ...one task per line...`;
    } else {
        taskInstruction = customPrompt || "Transcribe verbatim.";
    }

    const payload = {
        contents: [{
            parts: [
                { file_data: { file_uri: fileUri, mime_type: mimeType } },
                { text: taskInstruction }
            ]
        }],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generation_config: { max_output_tokens: 8192 }
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) throw new Error(`Model error: ${resp.status}`);
    const data = await resp.json();
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const tokens = data.usageMetadata?.candidatesTokenCount || 0;
    const finishReason = data.candidates?.[0]?.finishReason || "UNKNOWN";
    
    return { text, tokens, finishReason };
}
