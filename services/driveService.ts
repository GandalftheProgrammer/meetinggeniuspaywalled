
import { UserProfile } from '../types';

declare const google: any;

let codeClient: any;
let accessToken: string | null = null;
let mainFolderId: string | null = null;
let folderLock: Promise<string> | null = null;
const subFolderCache: Record<string, string> = {};
let globalStatusCallback: ((token: string | null) => void) | null = null;

export const getAccessToken = () => accessToken;

export const initDrive = (uid: string | undefined, callback: (token: string | null) => void) => {
  if (typeof google === 'undefined' || !google.accounts?.oauth2) return;
  if (codeClient) return;

  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID;

  if (!clientId) return;
  globalStatusCallback = callback;

  codeClient = google.accounts.oauth2.initCodeClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/drive.file',
    ux_mode: 'popup',
    callback: async (response: any) => {
      if (response.code && uid) {
        try {
          const res = await fetch('/.netlify/functions/drive-handler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'exchange_code', code: response.code, uid })
          });
          const data = await res.json();
          if (data.access_token) {
            accessToken = data.access_token;
            localStorage.setItem('mg_drive_connected', 'true');
            if (globalStatusCallback) globalStatusCallback(accessToken);
          }
        } catch (err) {
          console.error("Code exchange failed:", err);
          if (globalStatusCallback) globalStatusCallback(null);
        }
      }
    },
  });
};

export const connectToDrive = () => {
  if (!codeClient) return;
  codeClient.requestCode();
};

export const checkDriveStatus = async (uid: string): Promise<string | null> => {
  try {
    const res = await fetch('/.netlify/functions/drive-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_token', uid })
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        accessToken = data.access_token;
        localStorage.setItem('mg_drive_connected', 'true');
        if (globalStatusCallback) globalStatusCallback(accessToken);
        return accessToken;
      }
    }
  } catch (err) {
    console.error("Passive token check failed:", err);
  }
  
  accessToken = null;
  localStorage.removeItem('mg_drive_connected');
  if (globalStatusCallback) globalStatusCallback(null);
  return null;
};

export const ensureValidToken = async (uid?: string): Promise<string | null> => {
  if (accessToken) return accessToken;
  if (!uid) return null;
  return await checkDriveStatus(uid);
};

export const disconnectDrive = async (uid: string) => {
  accessToken = null;
  mainFolderId = null;
  folderLock = null;
  Object.keys(subFolderCache).forEach(k => delete subFolderCache[k]);
  localStorage.removeItem('mg_drive_connected');
  
  try {
    await fetch('/.netlify/functions/drive-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disconnect', uid })
    });
  } catch (e) {
    console.error("Backend disconnect failed:", e);
  }
  
  if (globalStatusCallback) globalStatusCallback(null);
};

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
    // Process the strict header logic
    // Header format: [NOTES] Meeting Title OR [TRANSCRIPT] Meeting Title
    // Then Recorded on [date] at [time]
    let html = md.trim()
        .replace(/^\[NOTES\] (.*$)/gm, '<h1 class="title">Notes $1</h1>')
        .replace(/^\[TRANSCRIPT\] (.*$)/gm, '<h1 class="title">Transcript $1</h1>')
        .replace(/^Recorded on (.*)$/gm, '<p class="recorded-on">Recorded on $1</p>')
        .replace(/^## (.*$)/gm, '<h2 class="header">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 class="subheader">$1</h3>')
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
        .title { color: #1e3a8a; font-size: 26pt; font-weight: bold; margin-bottom: 4pt; margin-top: 0; }
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

const uploadFile = async (name: string, content: string | Blob, type: string, sub: string, toDoc: boolean, uid?: string): Promise<any> => {
  let token = await ensureValidToken(uid);
  if (!token) throw new Error("Drive connection lost. Please reconnect in the header.");
  
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

export const uploadAudioToDrive = (name: string, blob: Blob, uid?: string) => {
  // Use audio/mp4 for .m4a naming consistency
  const mimeType = 'audio/mp4';
  return uploadFile(name, blob, mimeType, 'Audio', false, uid);
};

export const uploadTextToDrive = (name: string, content: string, sub: 'Notes' | 'Transcripts', uid?: string) => 
  uploadFile(name, convertMarkdownToHtml(content), 'text/html', sub, true, uid);
