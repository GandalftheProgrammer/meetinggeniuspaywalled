
import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel, UserProfile } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive } from './services/driveService';
import { saveChunkToDB, getChunksForSession, getPendingSessions, deleteSessionData } from './services/db';
import { AlertCircle, RotateCcw } from 'lucide-react';

declare const google: any;

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  // Fix: Default to Gemini 3 Flash for basic text/summarization tasks as per guidelines
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-3-flash-preview');
  const [lastRequestedMode, setLastRequestedMode] = useState<ProcessingMode>('NOTES_ONLY');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  
  const audioChunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string>(`session_${Date.now()}`);
  
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);

  const [recoverableSession, setRecoverableSession] = useState<{sessionId: string, title: string} | null>(null);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString('en-GB')} - ${msg}`]);
  };

  const formatMeetingDateTime = (date: Date) => {
    const day = date.getDate();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${day} ${months[date.getMonth()]} ${date.getFullYear()} at ${date.getHours().toString().padStart(2, '0')}h${date.getMinutes().toString().padStart(2, '0')}m`;
  };

  // --- AUTH LOGIC ---
  useEffect(() => {
    const checkRecovery = async () => {
        const sessions = await getPendingSessions();
        if (sessions.length > 0) setRecoverableSession(sessions[0]);
    };
    checkRecovery();

    // Initialize Google Sign-In
    const handleCredentialResponse = async (response: any) => {
      const decoded = JSON.parse(atob(response.credential.split('.')[1]));
      addLog(`Authenticated as ${decoded.email}`);
      
      // Fetch user profile from backend
      try {
        const res = await fetch('/.netlify/functions/get-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: decoded.email, uid: decoded.sub })
        });
        const profile = await res.json();
        setUser(profile);
      } catch (err) {
        console.error("Auth profile error:", err);
      }
    };

    // Fix: Cast window to any to access the global 'google' object and resolve TS error
    if ((window as any).google) {
      google.accounts.id.initialize({
        client_id: (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
        callback: handleCredentialResponse,
        // CRITICAL FIX: Disable FedCM to resolve 'identity-credentials-get' NotAllowedError
        // This is often required in iframed or restricted environments like Netlify preview
        use_fedcm_for_prompt: false,
        auto_select: false,
        itp_support: true
      });
      google.accounts.id.prompt(); // Display One Tap
    }

    const timer = setTimeout(() => {
      initDrive((token) => {
          if (token) {
              setIsDriveConnected(true);
              addLog("Drive link active.");
          } else {
              setIsDriveConnected(false);
          }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const handleUpgrade = async () => {
    if (!user) {
      handleLogin();
      return;
    }
    addLog("Redirecting to Stripe...");
    try {
      const res = await fetch('/.netlify/functions/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, uid: user.uid })
      });
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      addLog("Stripe redirect failed.");
    }
  };

  const handleLogin = () => {
    // Fix: Cast window to any to access the global 'google' object and resolve TS error
    if ((window as any).google) {
      // Re-trigger the prompt to ensure user can sign in manually if One Tap fails or is closed
      google.accounts.id.prompt((notification: any) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          // If the prompt is blocked or skipped, we could potentially show a button 
          // or use the standard sign-in button if we had one.
          console.log("One Tap skipped or not displayed", notification.getNotDisplayedReason());
        }
      });
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
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    }
  };

  const handleChunkReady = (chunk: Blob) => {
    audioChunksRef.current.push(chunk);
    saveChunkToDB({
        sessionId: sessionIdRef.current,
        index: audioChunksRef.current.length,
        chunk: chunk,
        timestamp: Date.now()
    }).catch(err => console.error("DB save error", err));
  };

  const handleFileUpload = (file: File) => {
      if (!user) { handleLogin(); return; }
      audioChunksRef.current = [];
      setCombinedBlob(file);
      const url = URL.createObjectURL(file);
      setAudioUrl(url);
      setAppState(AppState.PAUSED);
      setSessionStartTime(new Date(file.lastModified));
      addLog(`File received: ${file.name}`);
      if (!title) setTitle(file.name.replace(/\.[^/.]+$/, ""));
  };

  const handleRecordingChange = (isRecording: boolean) => {
    if (isRecording) {
      if (!user) { handleLogin(); return; }
      sessionIdRef.current = `session_${Date.now()}`;
      audioChunksRef.current = [];
      setSessionStartTime(new Date());
      setAppState(AppState.RECORDING);
      setRecoverableSession(null);
    } else {
       if (appState === AppState.RECORDING) {
         setAppState(AppState.PAUSED);
         finalizeAudio();
       }
    }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob || !user) return;
    
    setLastRequestedMode(mode);
    let finalTitle = title.trim() || "Meeting";
    setTitle(finalTitle);

    setAppState(AppState.PROCESSING);

    try {
      addLog("Starting analysis...");
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type || 'audio/webm', 'ALL', selectedModel, addLog, user.uid);
      
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);

      deleteSessionData(sessionIdRef.current).catch(() => {});
      if (isDriveConnected) autoSyncToDrive(newData, finalTitle, combinedBlob);
    } catch (apiError) {
      addLog(`Error: ${apiError instanceof Error ? apiError.message : 'Unknown'}`);
      setError("Analysis failed.");
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
      />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8 md:py-12">
        {error && <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl text-center text-sm font-medium">{error}</div>}

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
