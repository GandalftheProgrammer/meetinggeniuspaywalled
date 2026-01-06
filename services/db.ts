
export interface AudioChunk {
  sessionId: string;
  index: number;
  chunk: Blob;
  timestamp: number;
}

export interface SessionMetadata {
  sessionId: string;
  title: string;
  lastUpdated: number;
  duration: number;
  startTime: string; // Added to persist the "Recorded on" date
}

const DB_NAME = 'MeetingGeniusDB';
const DB_VERSION = 3; // Bumped version for schema update
const CHUNK_STORE = 'audio_chunks';
const SESSION_STORE = 'active_sessions';

export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: 'id', autoIncrement: true });
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' });
      }
    };
  });
};

export const saveChunkToDB = async (chunk: AudioChunk, duration: number, startTime: string) => {
  const db = await initDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([CHUNK_STORE, SESSION_STORE], 'readwrite');
    const chunkStore = transaction.objectStore(CHUNK_STORE);
    const sessionStore = transaction.objectStore(SESSION_STORE);

    chunkStore.add(chunk);
    sessionStore.put({ 
        sessionId: chunk.sessionId, 
        lastUpdated: Date.now(),
        duration: isNaN(duration) ? 0 : duration,
        startTime: startTime,
        title: localStorage.getItem(`title_${chunk.sessionId}`) || 'Untitled Meeting'
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};

export const getChunksForSession = async (sessionId: string): Promise<Blob[]> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CHUNK_STORE], 'readonly');
    const store = transaction.objectStore(CHUNK_STORE);
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);

    request.onsuccess = () => {
      const results = request.result as AudioChunk[];
      const sortedChunks = results.sort((a, b) => a.timestamp - b.timestamp).map(r => r.chunk);
      resolve(sortedChunks);
    };
    request.onerror = () => reject(request.error);
  });
};

export const getPendingSessions = async (): Promise<SessionMetadata[]> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSION_STORE], 'readonly');
    const store = transaction.objectStore(SESSION_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      // Return all sessions, sorted by lastUpdated descending (most recent first)
      const results = (request.result as SessionMetadata[]).sort((a, b) => b.lastUpdated - a.lastUpdated);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
};

export const cleanupOldSessions = async (): Promise<void> => {
    const db = await initDB();
    // Increase cleanup limit to 7 days as requested (effectively "no limit" for daily users)
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SESSION_STORE, CHUNK_STORE], 'readwrite');
        const sessionStore = transaction.objectStore(SESSION_STORE);
        const chunkStore = transaction.objectStore(CHUNK_STORE);
        
        const request = sessionStore.getAll();
        request.onsuccess = () => {
            const sessions = request.result as SessionMetadata[];
            sessions.forEach(s => {
                if (s.lastUpdated < sevenDaysAgo) {
                    sessionStore.delete(s.sessionId);
                    const index = chunkStore.index('sessionId');
                    const chunkRequest = index.openCursor(IDBKeyRange.only(s.sessionId));
                    chunkRequest.onsuccess = (e) => {
                        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
                        if (cursor) {
                            cursor.delete();
                            cursor.continue();
                        }
                    };
                }
            });
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
};

export const deleteSessionData = async (sessionId: string): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CHUNK_STORE, SESSION_STORE], 'readwrite');
    const chunkStore = transaction.objectStore(CHUNK_STORE);
    const sessionStore = transaction.objectStore(SESSION_STORE);

    const index = chunkStore.index('sessionId');
    const request = index.openCursor(IDBKeyRange.only(sessionId));

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    sessionStore.delete(sessionId);
    localStorage.removeItem(`title_${sessionId}`);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
};
