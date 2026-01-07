
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
        const currentData = await resultStore.get(jobId, { type: "json" }) || { status: 'PROCESSING' };
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

    if (!initResp.ok) throw new Error(`Google Upload Handshake Failed`);
    let uploadUrl = initResp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error("No upload URL returned");
    if (!uploadUrl.includes('key=')) uploadUrl = `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}key=${encodedKey}`;

    const GEMINI_CHUNK_SIZE = 8 * 1024 * 1024;
    let buffer = Buffer.alloc(0);
    let uploadOffset = 0;

    for (let i = 0; i < totalChunks; i++) {
        const chunkKey = `${jobId}/${i}`;
        const chunkBase64 = await uploadStore.get(chunkKey, { type: 'text' });
        if (!chunkBase64) throw new Error(`Missing segment ${i}`);
        
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
            if (!up.ok) throw new Error(`Segment Upload Failed`);
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

    // --- 2. PARALLEL SWARM ---
    await updateStatus("Step 2/3: Deploying analysis swarm (Parallel Processing).");

    const segmentMinutes = 7;
    const overlapSeconds = 45; // Increased overlap to give room for 150-word fuzzy match
    const totalSegments = Math.ceil(totalDurationSeconds / (segmentMinutes * 60));
    
    let completedCount = 0;
    const totalTasks = (mode === 'TRANSCRIPT_ONLY' ? 0 : 1) + (mode === 'NOTES_ONLY' ? 0 : totalSegments);

    const swarmTasks: Promise<any>[] = [];

    // Summary Task
    if (mode !== 'TRANSCRIPT_ONLY') {
        swarmTasks.push((async () => {
            const result = await callGeminiWithRetry(fileUri, mimeType, "NOTES_ONLY", model, encodedKey);
            completedCount++;
            await updateStatus(`Swarm progress: ${completedCount}/${totalTasks} tasks finished.`);
            return { type: 'NOTES', data: result };
        })());
    }

    // Transcription Tasks
    if (mode !== 'NOTES_ONLY') {
        for (let s = 0; s < totalSegments; s++) {
            const startSec = Math.max(0, s * segmentMinutes * 60 - (s > 0 ? overlapSeconds : 0));
            const endSec = Math.min((s + 1) * segmentMinutes * 60, totalDurationSeconds);
            const startFmt = formatSeconds(startSec);
            const endFmt = formatSeconds(endSec);

            swarmTasks.push((async () => {
                const prompt = `Transcribe exactly from ${startFmt} to ${endFmt}. 
                Output ONLY the raw text. Do not summarize. Match language of audio.`;
                const result = await callGeminiWithRetry(fileUri, mimeType, "SEGMENT", model, encodedKey, prompt);
                completedCount++;
                await updateStatus(`Swarm progress: ${completedCount}/${totalTasks} tasks finished.`);
                return { type: 'TRANSCRIPT', index: s, data: result };
            })());
        }
    }

    const swarmResults = await Promise.all(swarmTasks);
    await updateStatus("Step 3/3: Stitching results with Fuzzy Anchor-Point logic.");

    let finalTranscription = "";
    let finalNotes = "";

    const transcriptParts = swarmResults.filter(r => r.type === 'TRANSCRIPT').sort((a, b) => a.index - b.index);
    const notesPart = swarmResults.find(r => r.type === 'NOTES');

    // --- FUZZY STITCHING ---
    for (let i = 0; i < transcriptParts.length; i++) {
        const currentText = transcriptParts[i].data.trim();
        if (i === 0) {
            finalTranscription = currentText;
        } else {
            finalTranscription = fuzzyStitch(finalTranscription, currentText, 150);
        }
    }

    if (notesPart) finalNotes = notesPart.data;

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

/**
 * Fuzzy Anchor-Point Stitching.
 * Looks for the best cut point in Part B that aligns with the tail of Part A.
 */
function fuzzyStitch(partA: string, partB: string, wordWindow: number): string {
    const wordsA = partA.split(/\s+/);
    const wordsB = partB.split(/\s+/);

    if (wordsA.length < 20 || wordsB.length < 20) return partA + "\n\n" + partB;

    // Take tail of A and head of B
    const tailA = wordsA.slice(-wordWindow);
    const headB = wordsB.slice(0, wordWindow * 1.5);

    let bestMatchIndex = -1;
    let maxMatchScore = 0;

    // Look for a sequence of 6 words that match
    const seqLength = 6;
    for (let i = tailA.length - seqLength; i >= 0; i--) {
        const sequence = tailA.slice(i, i + seqLength).join(" ").toLowerCase().replace(/[.,!?;:]/g, "");
        
        // Search this sequence in headB
        for (let j = 0; j < headB.length - seqLength; j++) {
            const target = headB.slice(j, j + seqLength).join(" ").toLowerCase().replace(/[.,!?;:]/g, "");
            if (sequence === target) {
                // Potential match found at headB index j
                bestMatchIndex = j + seqLength;
                break;
            }
        }
        if (bestMatchIndex !== -1) break;
    }

    if (bestMatchIndex !== -1) {
        return partA + "\n\n" + wordsB.slice(bestMatchIndex).join(" ");
    }

    // Fallback: Hard cut at 75% of headB if no fuzzy match found to avoid too much duplicate
    return partA + "\n\n" + wordsB.slice(Math.floor(wordWindow * 0.75)).join(" ");
}

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
    throw new Error("File processing timeout");
}

function formatSeconds(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

async function callGeminiWithRetry(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<string> {
    for (let i = 0; i < 3; i++) {
        try {
            return await callGemini(fileUri, mimeType, mode, model, encodedKey, customPrompt);
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(r => setTimeout(r, 4000 * (i + 1)));
        }
    }
    return "";
}

async function callGemini(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are a meeting assistant. 
    Linguistic Rule: Use the same language as spoken in the audio.
    Formatting Rule: For notes, use tags [SUMMARY], [CONCLUSIONS], [ACTIONS]. 
    For transcription, be verbatim.`;

    let taskInstruction = "";
    if (mode === 'NOTES_ONLY') {
        taskInstruction = `Analyze the meeting. 
        MANDATORY: Return the result in this tag format:
        [SUMMARY] ...Brief overview...
        [CONCLUSIONS] - Point 1 - Point 2...
        [ACTIONS] - Item 1 - Item 2...`;
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

    if (!resp.ok) throw new Error(`Gemini Call Error: ${resp.status}`);
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
