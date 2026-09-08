// storage.js  -  IndexedDB wrapper for user reference files & photos.
// Files persist across restarts as Blobs. File bytes NEVER leave the device.
// The decision server only receives metadata from getUserFileMetadataList().

const DB_NAME = "BrowserAgentDB";
const DB_VERSION = 1;
const STORE_NAME = "userFiles";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveUserFile({ id, name, mimeType, size, label, blob, dataUrl, optInFaceRedact = false }) {
  const db = await openDB();
  const fileId = id || ("file_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
  const record = {
    id: fileId,
    name: name || "document",
    mimeType: mimeType || blob?.type || "application/octet-stream",
    size: size || blob?.size || 0,
    label: (label || "").trim() || (name || "file"),
    blob: (blob && typeof blob.arrayBuffer === "function") ? blob : null,
    dataUrl: dataUrl || null,
    optInFaceRedact: Boolean(optInFaceRedact),
    addedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

async function getAllUserFiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Manifest transmitted to the decision server: METADATA ONLY, ZERO BYTES.
async function getUserFileMetadataList() {
  const files = await getAllUserFiles();
  const list = files.map((f) => ({
    id: f.id,
    label: f.label,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
  }));

  const hasPhoto = list.some(
    (f) =>
      (f.label && f.label.toLowerCase().includes("photo")) ||
      (f.mimeType && f.mimeType.startsWith("image/")) ||
      (f.name && /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name))
  );

  const samplePhoto = (typeof DEFAULT_SAMPLE_PHOTO !== "undefined" && DEFAULT_SAMPLE_PHOTO)
    ? DEFAULT_SAMPLE_PHOTO
    : (typeof self !== "undefined" && self.DEFAULT_SAMPLE_PHOTO ? self.DEFAULT_SAMPLE_PHOTO : null);

  if (!hasPhoto && samplePhoto) {
    list.unshift({
      id: "default_sample_photo",
      label: "photo",
      name: "sample_photo.jpg",
      mimeType: "image/jpeg",
      size: 32000,
    });
  }

  return list;
}

async function getUserFile(id) {
  const samplePhoto = (typeof DEFAULT_SAMPLE_PHOTO !== "undefined" && DEFAULT_SAMPLE_PHOTO)
    ? DEFAULT_SAMPLE_PHOTO
    : (typeof self !== "undefined" && self.DEFAULT_SAMPLE_PHOTO ? self.DEFAULT_SAMPLE_PHOTO : null);

  if (id === "default_sample_photo" && samplePhoto) {
    return {
      id: "default_sample_photo",
      label: "photo",
      name: "sample_photo.jpg",
      mimeType: "image/jpeg",
      size: 32000,
      dataUrl: samplePhoto,
    };
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteUserFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function clearAllUserFiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Export for service worker and browser environments
if (typeof self !== "undefined") {
  self.saveUserFile = saveUserFile;
  self.getAllUserFiles = getAllUserFiles;
  self.getUserFileMetadataList = getUserFileMetadataList;
  self.getUserFile = getUserFile;
  self.deleteUserFile = deleteUserFile;
  self.clearAllUserFiles = clearAllUserFiles;
}
