/* 
  FIREBASE SERVICE
  Core database operations
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { 
    getFirestore, collection, addDoc, getDocs, getDoc, doc, 
    updateDoc, deleteDoc, query, where, orderBy, onSnapshot, 
    serverTimestamp, limit, startAfter, setDoc 
} from "https://www.gstatic.com/firebasejs/10.11.1/firebase-firestore.js";
import { firebaseConfig } from "./app-config.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Export to window for legacy support if needed
window.db = db;
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

export { 
    db, collection, addDoc, getDocs, getDoc, doc, 
    updateDoc, deleteDoc, query, where, orderBy, onSnapshot, 
    serverTimestamp, limit, startAfter, setDoc 
};
