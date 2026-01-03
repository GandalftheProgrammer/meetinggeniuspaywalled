import { GoogleUser } from '../types';

declare const google: any;

let tokenClient: any;
let accessToken: string | null = null;
let mainFolderId: string | null = null;
let folderLock: Promise<string> | null = null;
const subFolderCache: Record<string, string> = {};

export const initDrive = (callback: (token: string | null) => void) => {
  if (typeof google === 'undefined') return;

  const env = (import.meta as any).env;
  const clientId = env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, 
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (tokenResponse: any) => {
      if (tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        localStorage.setItem('drive_token', accessToken);
        localStorage.setItem('drive_token_expiry', (Date.now() + tokenResponse.expires_in * 1000).toString());
        localStorage.setItem('drive_sticky_connection', 'true');
        callback(accessToken);
      }
    },
  });

  const storedToken = localStorage.getItem('drive_token');
  const expiry = localStorage.getItem('drive_token_expiry');
  
  if (storedToken && expiry && Date.now() < parseInt(expiry)) {
    accessToken = storedToken;
    callback(storedToken);
  } else {
    callback(null);
  }
};

export const connectToDrive = () => {
  if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent select_account' });
};

export const disconnectDrive = () => {
  accessToken = null;
  mainFolderId = null;
  folderLock = null;
  Object.keys(subFolderCache).forEach(k => delete subFolderCache[k]);
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expiry');
  localStorage.removeItem('drive_sticky_connection');
};

const getFolderId = async (name: string, parentId?: string): Promise<string | null> => {
  if (!accessToken) return null;
  let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const d = await r.json();
  return d.files?.[0]?.id || null;
};

const createFolder = async (name: string, parentId?: string): Promise<string> => {
  const meta: any = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const d = await r.json();
  return d.id;
};

const ensureFolder = async (sub: string): Promise<string> => {
    const main = localStorage.getItem('drive_folder_name') || 'MeetingGenius';
    if (!mainFolderId) {
        if (!folderLock) {
            folderLock = (async () => {
                const id = await getFolderId(main) || await createFolder(main);
                mainFolderId = id;
                return id;
            })();
        }
        await folderLock;
    }
    if (!mainFolderId) throw new Error("Main folder missing");
    if (subFolderCache[sub]) return subFolderCache[sub];
    const subId = await getFolderId(sub, mainFolderId) || await createFolder(sub, mainFolderId);
    subFolderCache[sub] = subId;
    return subId;
};

const convertMarkdownToHtml = (md: string): string => {
    // 1. Process block elements
    let html = md.trim()
        .replace(/^# (.*$)/gm, '<h1 class="title">$1</h1>')
        .replace(/^## (.*$)/gm, '<h2 class="header">$1</h2>')
        .replace(/^### (.*$)/gm, '<h3 class="subheader">$1</h3>')
        .replace(/^\*(Recorded on .*)\*$/gm, '<p class="recorded-on">$1</p>')
        .replace(/- \[ \] (.*$)/gm, '<li>☐ $1</li>')
        .replace(/- (.*$)/gm, '<li>$1</li>');

    // 2. GLUE LIST ITEMS
    // IMPORTANT: Remove newlines between list items to ensure they are treated as a single block
    // This prevents the line-splitter from isolating closing tags like </ul> and wrapping them in <p>
    html = html.replace(/<\/li>\s+(?=<li)/g, '</li>');

    // 3. Wrap consecutive <li> into <ul>
    html = html.replace(/((?:<li>.*?<\/li>)+)/g, '<ul>$1</ul>');

    // 4. Process inline elements
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // 5. Wrap remaining lines in <p> if they are not already wrapped in a block tag
    const lines = html.split('\n');
    const processedLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        
        // Safety check: Don't wrap lines that are already block tags or closing tags
        if (
            trimmed.startsWith('<h') || 
            trimmed.startsWith('<ul') || 
            trimmed.startsWith('<li') || 
            trimmed.startsWith('</ul') || // Critical fix: prevent wrapping isolated closing tags
            trimmed.startsWith('<p')
        ) {
            return trimmed;
        }
        return `<p class="body-text">${trimmed}</p>`;
    });

    const finalInnerHtml = processedLines.filter(l => l !== '').join('\n');

    return `
<html>
<head>
    <style>
        body {
            font-family: 'Arial', sans-serif;
            color: #334155;
            line-height: 1.6;
            margin: 40px;
        }
        .title {
            color: #1e3a8a;
            font-size: 26pt;
            font-weight: bold;
            margin-bottom: 12pt;
            margin-top: 0;
            padding: 0;
        }
        .recorded-on {
            color: #64748b;
            font-style: italic;
            font-size: 11pt;
            margin-bottom: 24pt;
            margin-top: 0;
        }
        .header {
            color: #1e3a8a;
            font-size: 18pt;
            font-weight: bold;
            margin-top: 24pt;
            margin-bottom: 12pt;
        }
        .subheader {
            color: #475569;
            font-size: 14pt;
            font-weight: bold;
            margin-top: 18pt;
        }
        .body-text {
            font-size: 11pt;
            margin-bottom: 12pt;
        }
        strong {
            color: #1e293b;
            font-weight: bold;
        }
        ul {
            margin-bottom: 12pt;
            margin-top: 0;
            padding-left: 20pt;
        }
        li {
            font-size: 11pt;
            margin-bottom: 6pt;
        }
    </style>
</head>
<body>
    ${finalInnerHtml}
</body>
</html>
    `.trim();
};

const uploadFile = async (name: string, content: string | Blob, type: string, sub: string, toDoc: boolean): Promise<any> => {
  if (!accessToken) throw new Error("No access token");
  const folderId = await ensureFolder(sub);
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
  const body = new Blob(bodyParts);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${accessToken}`, 
      'Content-Type': `multipart/related; boundary=${boundary}` 
    },
    body
  });
  if (!r.ok) {
     const errText = await r.text();
     throw new Error(`Upload Failed: ${errText}`);
  }
  return await r.json();
};

export const uploadAudioToDrive = (name: string, blob: Blob) => {
  // Clean the MIME type: 'audio/webm;codecs=opus' -> 'audio/webm'
  // Google Drive multipart upload rejects the codecs parameter causing 400 Bad Request
  const cleanType = (blob.type || 'audio/webm').split(';')[0].trim();
  return uploadFile(name, blob, cleanType, 'Audio', false);
};

export const uploadTextToDrive = (name: string, content: string, sub: 'Notes' | 'Transcripts') => uploadFile(name, convertMarkdownToHtml(content), 'text/html', sub, true);