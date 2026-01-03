
import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel, UserProfile } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive } from './services/driveService';
import { deleteSessionData } from './services/db';
import { AlertCircle } from 'lucide-react';

declare const google: any;

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-3-flash-preview');
  const [lastRequestedMode, setLastRequestedMode] = useState<ProcessingMode>('NOTES_ONLY');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [currentRecordingSeconds, setCurrentRecordingSeconds] = useState(0);
  
  const audioChunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string>(`session_${Date.now()}`);
  
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);

  // Ref for the explicit OAuth2 token client (more reliable for manual clicks)
  const tokenClientRef = useRef<any>(null);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString('en-GB')} - ${msg}`]);
  };

  const formatMeetingDateTime = (date: Date) => {
    const day = date.getDate();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${day} ${months[date.getMonth()]} ${date.getFullYear()} at ${date.getHours().toString().padStart(2, '0')}h${date.getMinutes().toString().padStart(2, '0')}m`;
  };

  const fetchUserProfile = async (email: string, uid: string) => {
    try {
      addLog(`Syncing profile for ${email}...`);
      const res = await fetch('/.netlify/functions/get-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, uid })
      });
      const profile = await res.json();
      setUser(profile);
      addLog("Profile synchronized.");
    } catch (err) {
      setError("Database connection error. Please try again.");
    }
  };

  const handleIdResponse = async (response: any) => {
    try {
      const decoded = JSON.parse(atob(response.credential.split('.')[1]));
      fetchUserProfile(decoded.email, decoded.sub);
    } catch (err) {
      console.error("Auth profile error:", err);
    }
  };

  useEffect(() => {
    const initAuth = () => {
      const CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;
      if (!CLIENT_ID || !(window as any).google) return;

      // 1. Initialize for One Tap (Automatic top right)
      google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: handleIdResponse,
        auto_select: true,
        itp_support: true
      });
      google.accounts.id.prompt();

      // 2. Initialize for Manual Buttons (Popup flow)
      tokenClientRef.current = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'email profile openid',
        callback: async (tokenResponse: any) => {
          if (tokenResponse.access_token) {
            // Get user info via access token
            try {
              const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
              }).then(r => r.json());
              fetchUserProfile(info.email, info.sub);
            } catch (e) {
              console.error("Token info fetch failed", e);
            }
          }
        },
      });
      
      addLog("Auth system ready.");
    };

    if ((window as any).google) {
      initAuth();
    } else {
      const script = document.querySelector('script[src*="gsi/client"]');
      script?.addEventListener('load', initAuth);
    }

    const timer = setTimeout(() => {
      initDrive((token) => {
          setIsDriveConnected(!!token);
          if (token) addLog("Drive link active.");
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  const handleLogin = () => {
    if (tokenClientRef.current) {
      addLog("Starting secure login...");
      tokenClientRef.current.requestAccessToken();
    } else {
      // Emergency fallback
      google?.accounts?.id?.prompt();
      addLog("Auth client not ready, trying prompt...");
    }
  };

  const handleLogout = () => {
    setUser(null);
    disconnectDrive();
    setIsDriveConnected(false);
    addLog("Logged out.");
  };

  const handleUpgrade = async () => {
    if (!user) { handleLogin(); return; }
    addLog("Redirecting to Stripe...");
    try {
      const res = await fetch('/.netlify/functions/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, uid: user.uid })
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch (err) {
      setError("Payment setup failed.");
    }
  };

  const handleRecordingChange = (isRecording: boolean) => {
    if (isRecording) {
      if (!user) { handleLogin(); return; }
      sessionIdRef.current = `session_${Date.now()}`;
      audioChunksRef.current = [];
      setSessionStartTime(new Date());
      setAppState(AppState.RECORDING);
      setError(null);
    } else {
       if (appState === AppState.RECORDING) {
         setAppState(AppState.PAUSED);
         if (audioChunksRef.current.length > 0) {
            const blob = new Blob(audioChunksRef.current, { type: audioChunksRef.current[0].type || 'audio/webm' });
            setCombinedBlob(blob);
            setAudioUrl(URL.createObjectURL(blob));
         }
         setCurrentRecordingSeconds(0);
       }
    }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob || !user) return;
    setLastRequestedMode(mode);
    let finalTitle = title.trim() || "Meeting";
    setTitle(finalTitle);
    setAppState(AppState.PROCESSING);
    setError(null);

    try {
      addLog("Starting analysis...");
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type || 'audio/webm', 'ALL', selectedModel, addLog, user.uid);
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);
      deleteSessionData(sessionIdRef.current).catch(() => {});
      if (isDriveConnected) autoSyncToDrive(newData, finalTitle, combinedBlob);
    } catch (apiError: any) {
      setError(`Analysis failed: ${apiError.message || 'Unknown error'}`);
      setAppState(AppState.PAUSED); 
    }
  };

  const autoSyncToDrive = async (data: MeetingData, currentTitle: string, blob: Blob | null) => {
    if (!isDriveConnected) return;
    const startTime = sessionStartTime || new Date();
    const dateString = formatMeetingDateTime(startTime);
    const cleanTitle = currentTitle.replace(/[()]/g, '').trim();
    const safeBaseName = `${cleanTitle} on ${dateString}`.replace(/[/\\?%*:|"<>]/g, '-');

    if (blob) {
      const type = blob.type.toLowerCase();
      let ext = type.includes('mp4') ? 'm4a' : type.includes('wav') ? 'wav' : 'webm';
      uploadAudioToDrive(`${safeBaseName} - audio.${ext}`, blob).catch(() => {});
    }

    const notesMarkdown = `# ${cleanTitle} notes\n*Recorded on ${dateString}*\n\n${data.summary}\n\n## Conclusions\n${data.conclusions.map(i => `- ${i}`).join('\n')}\n\n## Action Items\n${data.actionItems.map(i => `- ${i}`).join('\n')}`;
    uploadTextToDrive(`${safeBaseName} - notes`, notesMarkdown, 'Notes').catch(() => {});
  };

  const handleDiscard = async () => {
    await deleteSessionData(sessionIdRef.current);
    setAppState(AppState.IDLE);
    audioChunksRef.current = [];
    setCombinedBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setMeetingData(null);
    setDebugLogs([]);
    setTitle("");
    setError(null);
    setCurrentRecordingSeconds(0);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header 
        isDriveConnected={isDriveConnected} 
        onConnectDrive={connectToDrive} 
        onDisconnectDrive={handleLogout}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        user={user}
        onLogin={handleLogin}
        onLogout={handleLogout}
        onUpgrade={handleUpgrade}
        currentRecordingSeconds={currentRecordingSeconds}
      />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8 md:py-12">
        {error && (
          <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-center text-sm font-medium shadow-sm animate-in fade-in zoom-in duration-300">
            <div className="flex items-center justify-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4" />
              <span className="font-bold">Error</span>
            </div>
            {error}
          </div>
        )}

        {appState !== AppState.COMPLETED && (
          <div className="flex flex-col items-center space-y-8 animate-in fade-in duration-500">
            <div className="w-full max-w-lg space-y-2">
              <label htmlFor="title" className="block text-sm font-semibold text-slate-600 ml-1">Meeting Title</label>
              <input
                type="text"
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Meeting Title"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none"
                disabled={appState === AppState.PROCESSING || appState === AppState.RECORDING}
              />
            </div>
            <Recorder 
              appState={appState}
              onChunkReady={(chunk) => audioChunksRef.current.push(chunk)}
              onProcessAudio={handleProcessAudio}
              onDiscard={handleDiscard}
              onRecordingChange={handleRecordingChange}
              onFileUpload={(file) => {
                if (!user) { handleLogin(); return; }
                setCombinedBlob(file);
                setAudioUrl(URL.createObjectURL(file));
                setAppState(AppState.PAUSED);
                setSessionStartTime(new Date(file.lastModified));
                if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ""));
              }}
              audioUrl={audioUrl}
              debugLogs={debugLogs}
              user={user}
              onUpgrade={handleUpgrade}
              onLogin={handleLogin}
              onRecordingTick={setCurrentRecordingSeconds}
            />
          </div>
        )}
        {appState === AppState.COMPLETED && meetingData && (
          <Results 
            data={meetingData} title={title} onReset={handleDiscard}
            onGenerateMissing={() => {}} isProcessingMissing={false}
            isDriveConnected={isDriveConnected} onConnectDrive={connectToDrive}
            audioBlob={combinedBlob} initialMode={lastRequestedMode}
            sessionDateString={sessionStartTime ? formatMeetingDateTime(sessionStartTime) : formatMeetingDateTime(new Date())}
          />
        )}
      </main>
    </div>
  );
};

export default App;
