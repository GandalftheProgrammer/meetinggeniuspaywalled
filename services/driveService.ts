
import { GoogleUser } from '../types';

declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;
let mainFolderId: string | null = null;
let folderLock: Promise<string> | null = null;
const subFolderCache: Record<string, string> = {};
let globalStatusCallback: ((token: string | null) => void) | null = null;

// Track if we are currently in an escalation flow to prevent loops
let isEscalating = false;

/**
 * Returns the current access token if available.
 */
export const getAccessToken = () => accessToken;

/**
 * Initializes the Drive token client.
 */
export const initDrive = (callback: (token: string | null) => void) => {
  if (typeof google === 'undefined' || !google.accounts?.oauth2) return;
  if (tokenClient) return;

  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID;

  if (!clientId) return;
  globalStatusCallback = callback;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, 
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse: any) => {
      if (tokenResponse.access_token) {
        // Success!
        isEscalating = false;
        accessToken = tokenResponse.access_token;
        localStorage.setItem('drive_token', accessToken);
        localStorage.setItem('drive_token_expiry', (Date.now() + tokenResponse.expires_in * 1000).toString());
        if (globalStatusCallback) globalStatusCallback(accessToken);
      } else if (tokenResponse.error === 'interaction_required') {
        // ESCALATION: Silent failed, so we MUST show the popup now.
        // We only do this if we aren't already in the middle of an escalation.
        if (!isEscalating) {
          isEscalating = true;
          tokenClient.requestAccessToken({ 
            hint: localStorage.getItem('mg_drive_email_hint') || undefined, 
            prompt: '' 
          });
        }
      } else {
        // Other errors or user closed the popup
        isEscalating = false;
        accessToken = null;
        if (globalStatusCallback) globalStatusCallback(null);
      }
    },
  });

  // Handle Page Refresh: Check storage first
  const storedToken = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  
  if (storedToken && expiry && Date.now() < (parseInt(expiry) - 60000)) {
    accessToken = storedToken;
    callback(storedToken);
  } else if (localStorage.getItem('mg_drive_intent') === 'true') {
    // No valid token, but user wants to be connected. Start the silent-first flow.
    connectToDrive(localStorage.getItem('mg_drive_email_hint') || undefined);
  } else {
    callback(null);
  }
};

/**
 * Connection flow. Always tries silent first. 
 * The callback handles escalation to popup if prompt:'none' fails.
 */
export const connectToDrive = (emailHint?: string) => {
  if (!tokenClient) return;
  
  const hint = emailHint || localStorage.getItem('mg_drive_email_hint') || undefined;
  
  // Set intent and hint for future auto-connects
  localStorage.setItem('mg_drive_intent', 'true');
  if (hint) localStorage.setItem('mg_drive_email_hint', hint);

  isEscalating = false; // Reset state for a new request chain
  tokenClient.requestAccessToken({
    hint: hint,
    prompt: 'none' 
  });
};

/**
 * Ensures a valid token is available before a cloud task.
 * Uses the same silent-first escalation logic.
 */
export const ensureValidToken = async (): Promise<string | null> => {
  const expiry = localStorage.getItem('drive_token_expiry');
  const storedToken = localStorage.getItem('drive_token');
  const isExpired = !expiry || Date.now() > (parseInt(expiry) - 30000); 

  if (!isExpired && storedToken) {
    accessToken = storedToken;
    return storedToken;
  }
  
  if (!tokenClient) return null;

  return new Promise((resolve) => {
    // Temporarily swap the callback to resolve this promise
    const originalCallback = tokenClient.callback;
    
    tokenClient.callback = (response: any) => {
      if (response.access_token) {
          accessToken = response.access_token;
          localStorage.setItem('drive_token', accessToken);
          localStorage.setItem('drive_token_expiry', (Date.now() + response.expires_in * 1000).toString());
          if (globalStatusCallback) globalStatusCallback(accessToken);
          tokenClient.callback = originalCallback; 
          resolve(accessToken);
      } else if (response.error === 'interaction_required') {
          // Escalation is handled by the manual call below to keep logic clean
          tokenClient.requestAccessToken({ 
              hint: localStorage.getItem('mg_drive_email_hint') || undefined, 
              prompt: '' 
          });
      } else {
          tokenClient.callback = originalCallback;
          resolve(null);
      }
    };
    
    tokenClient.requestAccessToken({ 
      hint: localStorage.getItem('mg_drive_email_hint') || undefined, 
      prompt: 'none' 
    });
  });
};

/**
 * Disconnects drive and clears the user's persistent preference.
 */
export const disconnectDrive = (clearIntent: boolean = true) => {
  accessToken = null;
  mainFolderId = null;
  folderLock = null;
  Object.keys(subFolderCache).forEach(k => delete subFolderCache[k]);
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  
  if (clearIntent) {
      localStorage.removeItem('mg_drive_intent');
      localStorage.removeItem('mg_drive_email_hint');
  }
  
  if (globalStatusCallback) globalStatusCallback(null);
};

// --- Helper Functions for Drive operations remain unchanged ---

const getFolderId = async (token: string, name: string, parentId?: string): Promise<string | null> => {
  let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const d = await r.json();
  return d.files?.[0]?.id || null;
};

const createFolder = async (token: string, name: string, parentId?: string): Promise<string> => {
  const meta: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const d = await r.json();
  return d.id;
};

const ensureFolder = async (token: string, sub: string): Promise<string> => {
    const main = localStorage.getItem('drive_folder_name') || 'MeetingGenius';
    if (!mainFolderId) {
        if (!folderLock) {
            folderLock = (async () => {
                const id = await getFolderId(token, main) || await createFolder(token, main);
                mainFolderId = id;
                return id;
            })();
        }
        await folderLock;
    }
    if (!mainFolderId) throw new Error("Main folder missing");
    if (subFolderCache[sub]) return subFolderCache[sub];
    const subId = await getFolderId(token, sub, mainFolderId) || await createFolder(token, sub, mainFolderId);
    subFolderCache[sub] = subId;
    return subId;
};

const convertMarkdownToHtml = (md: string): string => {
    let html = md.trim()
        .replace(/^# (.*$)/gm, '<h1 class="title">$1</h1>')
        .replace(/^## (.*$)/gm, '<h2 class="header">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 class="subheader">$1</h3>')
        .replace(/^\*(Recorded on .*)\*$/gm, '<p class="recorded-on">$1</p>')
        .replace(/- \[ \] (.*$)/gm, '<li>☐ $1</li>')
        .replace(/- (.*$)/gm, '<li>$1</li>');

    html = html.replace(/<\/li>\s+(?=<li)/g, '</li>');
    html = html.replace(/((?:<li>.*?<\/li>)+)/g, '<ul>$1</ul>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    const lines = html.split('\n');
    const processedLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<li') || trimmed.startsWith('</ul') || trimmed.startsWith('<p')) {
            return trimmed;
        }
        return `<p class="body-text">${trimmed}</p>`;
    });

    return `
<html>
<head>
    <style>
        body { font-family: 'Arial', sans-serif; color: #334155; line-height: 1.6; margin: 40px; }
        .title { color: #1e3a8a; font-size: 26pt; font-weight: bold; margin-bottom: 12pt; margin-top: 0; }
        .recorded-on { color: #64748b; font-style: italic; font-size: 11pt; margin-bottom: 24pt; }
        .header { color: #1e3a8a; font-size: 18pt; font-weight: bold; margin-top: 24pt; margin-bottom: 12pt; }
        .body-text { font-size: 11pt; margin-bottom: 12pt; }
        ul { margin-bottom: 12pt; padding-left: 20pt; }
        li { font-size: 11pt; margin-bottom: 6pt; }
    </style>
</head>
<body>${processedLines.filter(l => l !== '').join('\n')}</body>
</html>`.trim();
};

const uploadFile = async (name: string, content: string | Blob, type: string, sub: string, toDoc: boolean): Promise<any> => {
  let token = await ensureValidToken();
  if (!token) throw new Error("Could not verify cloud access. Please check the Google popup.");
  
  const folderId = await ensureFolder(token, sub);
  const meta = { 
    name: name, 
    parents: [folderId], 
    mimeType: toDoc ? 'application/vnd.google-apps.document' : type 
  };
  const boundary = '-------314159265358979323846';
  const mediaContent = content instanceof Blob ? content : new Blob([content], { type });
  const bodyParts: (string | Blob)[] = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(meta) + '\r\n',
    `--${boundary}\r\n`,
    `Content-Type: ${type}\r\n\r\n`,
    mediaContent,
    `\r\n--${boundary}--`
  ];
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${token}`, 
      'Content-Type': `multipart/related; boundary=${boundary}` 
    },
    body: new Blob(bodyParts)
  });
  if (!r.ok) throw new Error(`Drive upload failed: ${r.status}`);
  return await r.json();
};

export const uploadAudioToDrive = (name: string, blob: Blob) => {
  const cleanType = (blob.type || 'audio/webm').split(';')[0].trim();
  return uploadFile(name, blob, cleanType, 'Audio', false);
};

export const uploadTextToDrive = (name: string, content: string, sub: 'Notes' | 'Transcripts') => uploadFile(name, convertMarkdownToHtml(content), 'text/html', sub, true);
