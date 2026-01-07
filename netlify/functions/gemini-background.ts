
import { getStore } from "@netlify/blobs";
import { Buffer } from "node:buffer";

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

    // --- PARALLEL PROCESSING ---
    await updateStatus("Step 2/3: Launching parallel analysis swarm...");

    const segmentMinutes = 7;
    const overlapSeconds = 15;
    const totalSegments = Math.ceil(totalDurationSeconds / (segmentMinutes * 60));
    
    // Create segment tasks
    const tasks: Promise<any>[] = [];

    // Task for summary/notes
    if (mode !== 'TRANSCRIPT_ONLY') {
        tasks.push((async () => {
            await updateStatus("Swarm: Summary generator active...");
            const raw = await callGeminiWithRetry(fileUri, mimeType, "NOTES_ONLY", model, encodedKey);
            return { type: 'NOTES', data: raw };
        })());
    }

    // Swarm tasks for transcription
    if (mode !== 'NOTES_ONLY') {
        for (let s = 0; s < totalSegments; s++) {
            const startSec = Math.max(0, s * segmentMinutes * 60 - (s > 0 ? overlapSeconds : 0));
            const endSec = Math.min((s + 1) * segmentMinutes * 60, totalDurationSeconds);
            const startFmt = formatSeconds(startSec);
            const endFmt = formatSeconds(endSec);

            tasks.push((async () => {
                await updateStatus(`Swarm: Transcribing part ${s + 1}/${totalSegments} (${startFmt}-${endFmt})...`);
                const prompt = `Transcribe verbatim from ${startFmt} to ${endFmt}. Output ONLY raw text.`;
                const raw = await callGeminiWithRetry(fileUri, mimeType, "SEGMENT", model, encodedKey, prompt);
                return { type: 'TRANSCRIPT', index: s, data: raw };
            })());
        }
    }

    const swarmResults = await Promise.all(tasks);
    await updateStatus("Step 3/3: Stitching swarm results together.");

    let finalTranscription = "";
    let summaryData: any = { summary: "", conclusions: [], actionItems: [] };

    // Separate results
    const transcriptParts = swarmResults.filter(r => r.type === 'TRANSCRIPT').sort((a, b) => a.index - b.index);
    const notesResult = swarmResults.find(r => r.type === 'NOTES');

    // Stitch transcripts
    finalTranscription = transcriptParts.map(p => p.data.trim()).join("\n\n");

    // Hammer Unwrapping for Notes
    if (notesResult) {
        const text = notesResult.data;
        const parsed = extractJson(text);
        if (parsed) {
            summaryData = parsed;
        } else {
            // Heuristic fallback if JSON fails
            summaryData = heuristicExtract(text);
        }
    }

    const finalResult = {
        transcription: finalTranscription || "No transcription available.",
        summary: summaryData.summary || "Summary generation completed.",
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

/**
 * The Hammer: Heuristically extract sections from a messy text block if JSON fails.
 */
function heuristicExtract(text: string): any {
    const data = { summary: '', conclusions: [] as string[], actionItems: [] as string[] };
    
    const findPart = (pattern: RegExp) => {
        const match = text.match(pattern);
        return match ? match[1].trim() : null;
    };

    // Try to find sections based on common headers
    data.summary = findPart(/Summary[:\s]*([\s\S]*?)(?=Conclusion|Action|Key Points|$)/i) || 
                   findPart(/Samenvatting[:\s]*([\s\S]*?)(?=Conclusie|Actie|Belangrijk|$)/i) || 
                   text.substring(0, 500);

    const conMatch = findPart(/Conclusions?[:\s]*([\s\S]*?)(?=Action|Summary|Key Points|$)/i) ||
                     findPart(/Conclusies?[:\s]*([\s\S]*?)(?=Actie|Samenvatting|Belangrijk|$)/i);
    if (conMatch) {
        data.conclusions = conMatch.split(/\n-|\n\*|\n\d\./).map(s => s.trim()).filter(s => s.length > 5);
    }

    const actMatch = findPart(/Action Items?[:\s]*([\s\S]*?)(?=Conclusion|Summary|Key Points|$)/i) ||
                     findPart(/Actiepunten?[:\s]*([\s\S]*?)(?=Conclusie|Samenvatting|Belangrijk|$)/i);
    if (actMatch) {
        data.actionItems = actMatch.split(/\n-|\n\*|\n\d\./).map(s => s.trim()).filter(s => s.length > 5);
    }

    return data;
}

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
        return JSON.parse(text.substring(start, end + 1).replace(/,\s*([\]}])/g, '$1'));
    } catch (e) {
        return null;
    }
}

function formatSeconds(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

async function callGeminiWithRetry(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string, retries = 3): Promise<string> {
    for (let i = 0; i <= retries; i++) {
        try {
            return await callGemini(fileUri, mimeType, mode, model, encodedKey, customPrompt);
        } catch (e) {
            if (i === retries) throw e;
            console.log(`Retry ${i+1}/${retries} after error:`, e);
            await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        }
    }
    throw new Error("Unexpected retry failure");
}

async function callGemini(fileUri: string, mimeType: string, mode: string, model: string, encodedKey: string, customPrompt?: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodedKey}`;

    const systemInstruction = `You are a world-class meeting specialist. 
    Linguistic Rule: Use the same language as the spoken audio.
    Formatting: Be robust and clear. If JSON is requested, strictly provide valid JSON. 
    If transcription is requested, be 100% verbatim.`;

    let taskInstruction = "";
    let responseMimeType = "text/plain";

    if (mode === 'NOTES_ONLY') {
        responseMimeType = "application/json";
        taskInstruction = `Return ONLY a raw JSON object: {"summary": "string", "conclusions": ["string"], "actionItems": ["string"]}. 
        Language must match the audio.`;
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

    if (!resp.ok) throw new Error(`Gemini Call Failed (${resp.status})`);
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
