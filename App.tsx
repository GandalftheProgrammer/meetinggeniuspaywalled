
import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import Footer from './components/Footer';
import PrivacyPolicy from './components/PrivacyPolicy';
import TermsOfService from './components/TermsOfService';
import { AppState, MeetingData, ProcessingMode, GeminiModel, UserProfile } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive } from './services/driveService';
import { saveChunkToDB, deleteSessionData } from './services/db';
import { AlertCircle } from 'lucide-react';

declare const google: any;

type View = 'main' | 'privacy' | 'terms';

const App: React.FC = () => {
  const [view, setView] = useState<View>('main');
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

  const tokenClientRef = useRef<any>(null);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString('en-GB')} - ${msg}`]);
  };

  const handleNavigate = (newView: View) => {
    setView(newView);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const formatMeetingDateTime = (date: Date) => {
    const day = date.getDate();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const time = `${date.getHours().toString().padStart(2, '0')}h${date.getMinutes().toString().padStart(2, '0')}m`;
    return `${day} ${months[date.getMonth()]} at ${time}`;
  };

  const fetchUserProfile = async (email: string, uid: string) => {
    try {
      const res = await fetch('/.netlify/functions/get-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, uid })
      });
      const profile = await res.json();
      setUser(profile);
      addLog(`User profile synced: ${email}`);
      
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('session_id')) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (err) {
      console.error("Auth profile error:", err);
      setError("Failed to load user profile. Check your connection.");
    }
  };

  useEffect(() => {
    const handleCredentialResponse = async (response: any) => {
      const decoded = JSON.parse(atob(response.credential.split('.')[1]));
      fetchUserProfile(decoded.email, decoded.sub);
    };

    const CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;

    if ((window as any).google && CLIENT_ID) {
      google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: true,
        use_fedcm_for_prompt: false,
        itp_support: true
      });
      google.accounts.id.prompt();

      tokenClientRef.current = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'email profile openid',
        callback: async (tokenResponse: any) => {
          if (tokenResponse.access_token) {
            try {
              const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
              }).then(r => r.json());
              fetchUserProfile(info.email, info.sub);
            } catch (e) {
              console.error("Token info error:", e);
            }
          }
        },
      });
    }

    const timer = setTimeout(() => {
      initDrive((token) => {
          setIsDriveConnected(!!token);
          if (token) addLog("Drive connection confirmed.");
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

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

  const handleLogin = () => {
    if (tokenClientRef.current) {
      tokenClientRef.current.requestAccessToken();
    } else if ((window as any).google) {
      google.accounts.id.prompt();
    }
  };

  const handleLogout = () => {
    setUser(null);
    disconnectDrive();
    setIsDriveConnected(false);
    addLog("Logged out.");
  };

  const finalizeAudio = () => {
    if (audioChunksRef.current.length > 0) {
      const mimeType = audioChunksRef.current[0].type || 'audio/webm';
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      setCombinedBlob(blob);
      setAudioUrl(URL.createObjectURL(blob));
    }
  };

  const handleChunkReady = (chunk: Blob) => {
    audioChunksRef.current.push(chunk);
    saveChunkToDB({
        sessionId: sessionIdRef.current,
        index: audioChunksRef.current.length,
        chunk: chunk,
        timestamp: Date.now()
    }).catch(() => {});
  };

  const handleFileUpload = (file: File) => {
      if (!user) { handleLogin(); return; }
      audioChunksRef.current = [];
      setCombinedBlob(file);
      setAudioUrl(URL.createObjectURL(file));
      setAppState(AppState.PAUSED);
      setSessionStartTime(new Date(file.lastModified));
      if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ""));
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
         finalizeAudio();
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
      
      if (isDriveConnected) {
        autoSyncToDrive(newData, finalTitle, combinedBlob);
      }
    } catch (apiError: any) {
      setError(`Analysis failed: ${apiError.message || 'Unknown error'}`);
      setAppState(AppState.PAUSED); 
    }
  };

  const autoSyncToDrive = async (data: MeetingData, currentTitle: string, blob: Blob | null) => {
    if (!isDriveConnected) return;
    const startTime = sessionStartTime || new Date();
    const dateTimeStr = formatMeetingDateTime(startTime);
    const cleanTitle = currentTitle.replace(/[()]/g, '').trim();
    const safeBaseName = `${cleanTitle} on ${dateTimeStr}`;

    addLog("Auto-syncing results to Google Drive...");

    if (blob) {
      const type = blob.type.toLowerCase();
      let ext = type.includes('mp4') ? 'm4a' : type.includes('wav') ? 'wav' : 'webm';
      uploadAudioToDrive(`${safeBaseName} - audio.${ext}`, blob).catch(e => addLog(`Drive Audio Error: ${e.message}`));
    }

    if (data.summary || data.conclusions.length > 0) {
      const notesMarkdown = `# ${cleanTitle} notes\n*Recorded on ${dateTimeStr}*\n\n${data.summary}\n\n## Conclusions\n${data.conclusions.map(i => `- ${i}`).join('\n')}\n\n## Action Items\n${data.actionItems.map(i => `- ${i}`).join('\n')}`;
      uploadTextToDrive(`${safeBaseName} - notes`, notesMarkdown, 'Notes').catch(e => addLog(`Drive Notes Error: ${e.message}`));
    }

    if (data.transcription && data.transcription.trim().length > 2) {
      const transcriptMarkdown = `# ${cleanTitle} transcript\n*Recorded on ${dateTimeStr}*\n\n${data.transcription}`;
      uploadTextToDrive(`${safeBaseName} - transcript`, transcriptMarkdown, 'Transcripts')
        .then(() => addLog("Transcript saved to Drive."))
        .catch(e => addLog(`Drive Transcript Error: ${e.message}`));
    }
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

  const renderMainView = () => (
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
        onChunkReady={handleChunkReady}
        onProcessAudio={handleProcessAudio}
        onDiscard={handleDiscard}
        onRecordingChange={handleRecordingChange}
        onFileUpload={handleFileUpload}
        audioUrl={audioUrl}
        debugLogs={debugLogs}
        user={user}
        onUpgrade={handleUpgrade}
        onLogin={handleLogin}
        onRecordingTick={setCurrentRecordingSeconds}
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header 
        isDriveConnected={isDriveConnected} 
        onConnectDrive={() => connectToDrive(user?.email)} 
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
        {view === 'main' ? (
          <>
            {error && (
              <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-center text-sm font-medium shadow-sm animate-in fade-in zoom-in duration-300">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <AlertCircle className="w-4 h-4" />
                  <span className="font-bold">Error</span>
                </div>
                {error}
              </div>
            )}

            {appState !== AppState.COMPLETED ? renderMainView() : (
              meetingData && (
                <Results 
                  data={meetingData} title={title} onReset={handleDiscard}
                  onGenerateMissing={() => {}} isProcessingMissing={false}
                  isDriveConnected={isDriveConnected} onConnectDrive={() => connectToDrive(user?.email)}
                  audioBlob={combinedBlob} initialMode={lastRequestedMode}
                  sessionDateString={sessionStartTime ? formatMeetingDateTime(sessionStartTime) : formatMeetingDateTime(new Date())}
                />
              )
            )}
          </>
        ) : view === 'privacy' ? (
          <PrivacyPolicy onBack={() => handleNavigate('main')} />
        ) : (
          <TermsOfService onBack={() => handleNavigate('main')} />
        )}
      </main>

      <Footer onNavigate={handleNavigate} />
    </div>
  );
};

export default App;
