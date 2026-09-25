/* 
  FIREBASE SERVICE
  Core database operations
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { 
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    getFirestore, collection, addDoc, getDocs, getDoc, doc, 
    updateDoc, deleteDoc, query, where, orderBy, onSnapshot, 
    serverTimestamp, limit, startAfter, setDoc, runTransaction, Timestamp 
} from "https://www.gstatic.com/firebasejs/10.11.1/firebase-firestore.js";
import { 
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut 
} from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { firebaseConfig } from "./app-config.js";

// Initialize Firebase with Multi-Tab IndexedDB Persistent Cache
const app = initializeApp(firebaseConfig);

let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
        })
    });
} catch (e) {
    console.warn("Falling back to default getFirestore:", e);
    db = getFirestore(app);
}

const auth = getAuth(app);

// Export to window for legacy support if needed
window.db = db;
window.auth = auth;
window.fsCollection = collection;
window.fsAddDoc = addDoc;
window.fsGetDocs = getDocs;
window.fsGetDoc = getDoc;
window.fsDoc = doc;
window.fsUpdateDoc = updateDoc;
window.fsDeleteDoc = deleteDoc;
window.fsQuery = query;
window.fsWhere = where;
window.fsOrderBy = orderBy;
window.fsOnSnapshot = onSnapshot;
window.fsServerTimestamp = serverTimestamp;
window.fsLimit = limit;
window.fsStartAfter = startAfter;
window.fsSetDoc = setDoc;
window.fsRunTransaction = runTransaction;
window.fsTimestamp = Timestamp;

export { 
    db, auth, collection, addDoc, getDocs, getDoc, doc, 
    updateDoc, deleteDoc, query, where, orderBy, onSnapshot, 
    serverTimestamp, limit, startAfter, setDoc, runTransaction, Timestamp,
    onAuthStateChanged, signInWithEmailAndPassword, signOut
};

