// Keeping decks and everything learned about them outside this browser:
// - a backup file with everything (decks with their tags, tests, lines and states; tag defaults; settings), restored
//   on any device by merging (the newer copy of each deck wins);
// - a linked deck folder (desktop Chrome / Edge: the File System Access API), e.g. YGO Omega's or EDOPro's deck folder:
//   .ydk files (and .txt holding a ydke:// link or a YGO Omega code) come in, decks changed here are written back;
// - Google Drive: the same backup kept in the app's own hidden Drive folder. A website needs its own Google sign-in ID
//   for this (VITE_GOOGLE_CLIENT_ID); without one the button explains the one-time setup.
import type { SavedDeck } from "./decks";

const BACKUP_FILE = "rkapro-backup.json";
const KEYS = ["rka.decks", "rka.tags", "rka.handtest", "rka.goal"];

export interface Backup {
  app: "rkapro";
  version: 1;
  date: number;
  storage: Record<string, string>;
}

export function makeBackup(): Backup {
  const storage: Record<string, string> = {};
  for (const key of KEYS) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) storage[key] = value;
    } catch {
      // storage blocked: nothing to add
    }
  }
  return { app: "rkapro", version: 1, date: Date.now(), storage };
}

export function downloadBackup() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(makeBackup())], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `rkapro-backup-${new Date().toISOString().slice(0, 10)}.json` });
  link.click();
  URL.revokeObjectURL(url);
}

/** Decks from a backup merged with these: the newer copy of each deck wins, decks only one side has are kept. */
export function mergeBackup(text: string, decks: SavedDeck[]): SavedDeck[] {
  const backup = JSON.parse(text) as Backup;
  if (backup?.app !== "rkapro") throw new Error("Not an RKAPro backup file");
  const theirs = JSON.parse(backup.storage["rka.decks"] ?? "[]") as SavedDeck[];
  const merged = new Map(decks.map((deck) => [deck.id, deck]));
  for (const deck of theirs) {
    const mine = merged.get(deck.id);
    if (!mine || deck.updated > mine.updated) merged.set(deck.id, deck);
  }
  // tag defaults: theirs fill in what is missing here; settings only if there are none here
  try {
    const tags = { ...JSON.parse(backup.storage["rka.tags"] ?? "{}"), ...JSON.parse(localStorage.getItem("rka.tags") ?? "{}") };
    localStorage.setItem("rka.tags", JSON.stringify(tags));
    for (const key of ["rka.handtest", "rka.goal"]) if (backup.storage[key] && !localStorage.getItem(key)) localStorage.setItem(key, backup.storage[key]);
  } catch {
    // the decks still come through
  }
  return [...merged.values()].sort((a, b) => b.updated - a.updated);
}

// ---- linked deck folder ----
type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};
export const canLinkFolder = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

// the folder is remembered between visits (IndexedDB is the only place a folder handle can be kept)
function store(): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("rka", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onsuccess = () => resolve(open.result.transaction("handles", "readwrite").objectStore("handles"));
    open.onerror = () => reject(open.error);
  });
}
async function remember(handle: DirectoryHandle | null) {
  const handles = await store();
  if (handle) handles.put(handle, "folder");
  else handles.delete("folder");
}
export async function linkedFolder(): Promise<DirectoryHandle | null> {
  try {
    const handles = await store();
    return await new Promise((resolve) => {
      const get = handles.get("folder");
      get.onsuccess = () => resolve((get.result as DirectoryHandle) ?? null);
      get.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
export async function linkFolder(): Promise<DirectoryHandle> {
  const handle = (await (window as unknown as { showDirectoryPicker(options: { mode: "readwrite" }): Promise<DirectoryHandle> }).showDirectoryPicker({ mode: "readwrite" })) as DirectoryHandle;
  await remember(handle);
  return handle;
}
export const unlinkFolder = () => remember(null);

export interface FolderFile {
  name: string;
  text: string;
  modified: number;
}
/** The deck files in the folder (asks for permission again after a restart, as browsers require). */
export async function readFolder(handle: DirectoryHandle): Promise<FolderFile[]> {
  if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted" && (await handle.requestPermission({ mode: "readwrite" })) !== "granted")
    throw new Error("The deck folder needs permission to be read");
  const files: FolderFile[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== "file" || !/\.(ydk|txt)$/i.test(entry.name)) continue;
    const file = await (entry as FileSystemFileHandle).getFile();
    files.push({ name: entry.name, text: await file.text(), modified: file.lastModified });
  }
  return files;
}
export async function writeFolderFile(handle: DirectoryHandle, name: string, text: string) {
  const file = await handle.getFileHandle(name, { create: true });
  const writable = await (file as FileSystemFileHandle & { createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void> }> }).createWritable();
  await writable.write(text);
  await writable.close();
}

// ---- Google Drive (the app's hidden folder in your Drive) ----
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
export const driveReady = () => !!CLIENT_ID;

type TokenClient = { requestAccessToken(): void };
declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient(config: { client_id: string; scope: string; callback: (response: { access_token?: string; error?: string }) => void }): TokenClient } } };
  }
}
let token = "";
function signIn(): Promise<string> {
  if (token) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    const begin = () => {
      const client = window.google!.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID!,
        scope: "https://www.googleapis.com/auth/drive.appdata",
        callback: (response) => (response.access_token ? resolve((token = response.access_token)) : reject(new Error(response.error ?? "Google sign-in was cancelled"))),
      });
      client.requestAccessToken();
    };
    if (window.google) return begin();
    const script = Object.assign(document.createElement("script"), { src: "https://accounts.google.com/gsi/client", async: true });
    script.onload = begin;
    script.onerror = () => reject(new Error("Couldn't reach Google sign-in"));
    document.head.appendChild(script);
  });
}
async function drive(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://www.googleapis.com/${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await signIn()}` } });
  if (response.status === 401) token = "";
  if (!response.ok) throw new Error(`Google Drive: ${response.status} ${response.statusText}`);
  return response;
}
async function driveFileId(): Promise<string | null> {
  const list = await (await drive(`drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${BACKUP_FILE}'`)}&fields=files(id)`)).json();
  return list.files?.[0]?.id ?? null;
}
/** The backup in Drive, or null if there is none yet. */
export async function driveDownload(): Promise<string | null> {
  const id = await driveFileId();
  return id ? (await drive(`drive/v3/files/${id}?alt=media`)).text() : null;
}
export async function driveUpload(text: string) {
  const id = await driveFileId();
  const metadata = id ? {} : { name: BACKUP_FILE, parents: ["appDataFolder"] };
  const body = new FormData();
  body.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.append("file", new Blob([text], { type: "application/json" }));
  await drive(`upload/drive/v3/files${id ? `/${id}` : ""}?uploadType=multipart`, { method: id ? "PATCH" : "POST", body });
}
