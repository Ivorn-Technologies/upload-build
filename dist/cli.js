"use strict";

// ../../web/frontend/lib/upload/abort.ts
function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}
function isAbortError(err) {
  return err?.name === "AbortError";
}

// ../../web/frontend/lib/upload/archive-error.ts
var ArchiveError = class extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
    this.name = "ArchiveError";
  }
};

// ../../web/frontend/lib/upload/concurrency.ts
async function mapWithConcurrency(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError;
  const lane = async () => {
    while (!failed && next < items.length) {
      if (signal?.aborted) {
        failed = true;
        firstError = abortError();
        return;
      }
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed) throw firstError;
  return results;
}
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ../../web/frontend/lib/upload/normalize.ts
var MAX_BUILD_FILES = 5e3;
var MAX_PATH_LENGTH = 300;
var MAX_BUILD_FILE_BYTES = 5 * 1024 ** 3;
var JUNK_DIR = "__MACOSX";
var JUNK_NAMES = /* @__PURE__ */ new Set([".ds_store", "thumbs.db"]);
function cleanPath(path) {
  let p = path.replace(/\\/g, "/").normalize("NFC");
  for (; ; ) {
    if (p.startsWith("./")) p = p.slice(2);
    else if (p.startsWith("/")) p = p.slice(1);
    else return p;
  }
}
function isJunkPath(path) {
  const segments = path.split("/");
  if (segments.includes(JUNK_DIR)) return true;
  const name = segments[segments.length - 1];
  return JUNK_NAMES.has(name.toLowerCase()) || name.startsWith("._");
}
function pathProblem(path) {
  const segments = path.split("/");
  if (path.includes("\\") || segments.some((s) => s === "" || s === "." || s === ".." || s.includes(":"))) {
    return "invalid-path";
  }
  return path.length > MAX_PATH_LENGTH ? "too-long" : null;
}
function commonRoot(paths) {
  let root = null;
  for (const p of paths) {
    const slash = p.indexOf("/");
    if (slash <= 0) return null;
    const first = p.slice(0, slash);
    if (root === null) root = first;
    else if (root !== first) return null;
  }
  return root;
}
var plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function normalizeEntries(raw, opts) {
  let junk = 0;
  let links = 0;
  const kept = [];
  for (const entry of raw) {
    if (entry.kind === "directory") continue;
    if (entry.kind === "symlink") {
      links++;
      continue;
    }
    const path = cleanPath(entry.path);
    if (isJunkPath(path)) {
      junk++;
      continue;
    }
    kept.push({ path, source: entry });
  }
  const notes = [];
  if (links > 0) notes.push(`Skipped ${plural(links, "symbolic link", "symbolic links")}`);
  if (junk > 0) notes.push(`Skipped ${plural(junk, "system file", "system files")} (__MACOSX, .DS_Store, Thumbs.db)`);
  const root = opts.stripCommonRoot ? commonRoot(kept.map((k) => k.path)) : null;
  if (root) notes.push(`Stripped the common folder ${root}/`);
  const invalid = [];
  const tooLong = [];
  const tooLarge = [];
  const duplicates = [];
  const seen = /* @__PURE__ */ new Map();
  const entries = [];
  for (const { path: full, source } of kept) {
    const path = root ? full.slice(root.length + 1) : full;
    const problem = pathProblem(path);
    if (problem === "invalid-path") {
      invalid.push(path);
      continue;
    }
    if (problem === "too-long") {
      tooLong.push(path);
      continue;
    }
    if (source.size > MAX_BUILD_FILE_BYTES) {
      tooLarge.push(path);
      continue;
    }
    const key = path.toLowerCase();
    const prior = seen.get(key);
    if (prior !== void 0) {
      duplicates.push({ code: prior === path ? "duplicate" : "case-duplicate", paths: [prior, path] });
      continue;
    }
    seen.set(key, path);
    entries.push({ path, size: source.size, open: () => source.open() });
  }
  const problems = [];
  if (invalid.length) problems.push({ code: "invalid-path", paths: invalid });
  if (tooLong.length) problems.push({ code: "too-long", paths: tooLong });
  if (tooLarge.length) problems.push({ code: "too-large", paths: tooLarge });
  problems.push(...duplicates);
  if (entries.length > MAX_BUILD_FILES) problems.push({ code: "too-many", paths: [], count: entries.length });
  if (entries.length === 0 && problems.length === 0) problems.push({ code: "empty", paths: [] });
  return { entries, notes, problems, strippedRoot: root };
}
function listPaths(paths) {
  const shown = paths.slice(0, 5).map((p) => `"${p}"`).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}
var MAX_PROBLEM_LINES = 10;
function describeProblems(problems) {
  const lines = problems.slice(0, MAX_PROBLEM_LINES).map(describeProblem);
  const hidden = problems.length - lines.length;
  if (hidden > 0) lines.push(`and ${plural(hidden, "more problem", "more problems")}`);
  return lines;
}
function describeProblem(p) {
  switch (p.code) {
    case "invalid-path":
      return `${p.paths.length === 1 ? "1 file has a name" : `${p.paths.length} files have names`} the installer can’t use: ${listPaths(p.paths)}`;
    case "too-long":
      return `${p.paths.length === 1 ? "1 file has a path" : `${p.paths.length} files have paths`} longer than ${MAX_PATH_LENGTH} characters: ${listPaths(p.paths)}`;
    case "too-large":
      return `${p.paths.length === 1 ? "1 file is" : `${p.paths.length} files are`} larger than 5 GB, the limit for a single file: ${listPaths(p.paths)}`;
    case "case-duplicate":
      return `Two files differ only by letter case: "${p.paths[0]}" and "${p.paths[1]}"`;
    case "duplicate":
      return `"${p.paths[0]}" appears twice`;
    case "too-many":
      return `This build has ${p.count} files; the limit is ${MAX_BUILD_FILES} per build`;
    case "empty":
      return "There are no files to upload";
  }
}

// ../../web/frontend/lib/upload/pipeline.ts
var CHECK_CHUNK_SIZE = 500;
var UPLOAD_CONCURRENCY = 5;
var UPLOAD_RETRIES = 3;
var RETRY_BASE_DELAY_MS = 1e3;
var UPLOAD_CONTENT_TYPE = "application/octet-stream";
var UploadHttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "UploadHttpError";
  }
};
var UploadError = class extends Error {
  constructor(message, resume) {
    super(message);
    this.resume = resume;
    this.name = "UploadError";
  }
};
function isExpired(err) {
  return err instanceof UploadHttpError && (err.status === 403 || err.status === 400 && /expired/i.test(err.message));
}
async function runUpload(input, deps, signal, resume, options = {}) {
  const { entries } = input;
  const { progress } = deps;
  const hashes = new Map(resume?.hashes ?? []);
  const done = new Map(resume?.done ?? []);
  const sizes = new Map(resume?.sizes ?? []);
  let sessionId = resume?.uploadSessionId ?? null;
  const sizeOf = (entry) => sizes.get(entry.path) ?? done.get(entry.path)?.size ?? entry.size;
  const snapshotResume = () => ({
    uploadSessionId: sessionId,
    hashes: new Map(hashes),
    done: new Map(done),
    sizes: new Map(sizes)
  });
  const checkItem = (entry) => ({
    filename: entry.path,
    hash: hashes.get(entry.path),
    size: sizeOf(entry),
    contentType: UPLOAD_CONTENT_TYPE
  });
  const payload = (entry, location) => ({
    filename: entry.path,
    hash: hashes.get(entry.path),
    size: sizeOf(entry),
    required: true,
    ...location
  });
  let totalBytes = 0;
  let readDone = 0;
  const toHash = [];
  for (const e of entries) {
    totalBytes += sizeOf(e);
    if (hashes.has(e.path)) readDone += sizeOf(e);
    else toHash.push(e);
  }
  const reading = /* @__PURE__ */ new Map();
  const publishRead = () => {
    let inFlight = 0;
    for (const bytes of reading.values()) inFlight += bytes;
    progress.update({ totalBytes, readBytes: readDone + inFlight });
  };
  progress.update({
    step: "reading",
    totalFiles: entries.length,
    totalBytes,
    readBytes: readDone,
    alreadyUploadedFiles: 0,
    alreadyUploadedBytes: 0,
    uploadedBytes: 0,
    active: [],
    failed: []
  });
  progress.flush();
  await mapWithConcurrency(
    toHash,
    Math.max(1, deps.hashConcurrency),
    async (entry) => {
      let size;
      try {
        const blob = await entry.open();
        if (entry.size > 0 && blob.size !== entry.size) throw new Error("it changed while it was being read");
        if (blob.size > MAX_BUILD_FILE_BYTES) {
          throw new Error("it is larger than 5 GB, the limit for a single file");
        }
        size = blob.size;
        totalBytes += size - entry.size;
        sizes.set(entry.path, size);
        const hash = await deps.hash(
          blob,
          (bytes) => {
            reading.set(entry.path, bytes);
            publishRead();
          },
          signal
        );
        hashes.set(entry.path, hash);
      } catch (err) {
        if (isAbortError(err) || err instanceof ArchiveError) throw err;
        throw new UploadError(
          `Couldn’t read ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
          snapshotResume()
        );
      } finally {
        reading.delete(entry.path);
      }
      readDone += size;
      publishRead();
    },
    signal
  );
  let alreadyUploadedFiles = 0;
  let alreadyUploadedBytes = 0;
  let uploadedBytes = 0;
  for (const e of entries) {
    const p = done.get(e.path);
    if (!p) continue;
    if (p.s3Key) {
      alreadyUploadedFiles++;
      alreadyUploadedBytes += sizeOf(e);
    } else {
      uploadedBytes += sizeOf(e);
    }
  }
  const active = /* @__PURE__ */ new Map();
  const failed = /* @__PURE__ */ new Map();
  let failedList = [];
  const setFailed = (path, fp) => {
    if (fp) failed.set(path, fp);
    else if (!failed.delete(path)) return;
    failedList = [...failed.values()];
  };
  let overallHigh = 0;
  const publishUpload = () => {
    let inFlight = 0;
    const activeList = [];
    for (const a of active.values()) {
      inFlight += a.loaded;
      activeList.push({ ...a });
    }
    overallHigh = Math.max(overallHigh, alreadyUploadedBytes + uploadedBytes + inFlight);
    progress.update({
      alreadyUploadedFiles,
      alreadyUploadedBytes,
      uploadedBytes: overallHigh - alreadyUploadedBytes,
      active: activeList,
      failed: failedList
    });
  };
  const markAlreadyUploaded = (entry, s3Key) => {
    alreadyUploadedFiles++;
    alreadyUploadedBytes += sizeOf(entry);
    done.set(entry.path, payload(entry, { s3Key }));
  };
  const sessionExpired = () => {
    sessionId = null;
    for (const [path, p] of done) if (p.tmpKey) done.delete(path);
    return new UploadError("The upload session expired. Press “Try again” to upload the remaining files.", snapshotResume());
  };
  const checkChunk = async (batch) => {
    try {
      const response = await deps.api.checkFiles(
        { ...sessionId ? { uploadSessionId: sessionId } : {}, files: batch.map(checkItem) },
        signal
      );
      sessionId = response.uploadSessionId;
      return response;
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (deps.errorCode(err) === "UPLOAD_SESSION_INVALID") throw sessionExpired();
      throw new UploadError(deps.describeError(err, "Couldn’t check the files with the server"), snapshotResume());
    }
  };
  const uploadOne = async (entry, first) => {
    let current = first;
    const size = sizeOf(entry);
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError();
      const fp = { path: entry.path, size, loaded: 0 };
      setFailed(entry.path, null);
      active.set(entry.path, fp);
      publishUpload();
      try {
        if (!current.uploadUrl || !current.tmpKey || !current.checksumSha256B64) {
          throw new UploadHttpError(null, "The server did not return an upload URL");
        }
        const blob = await entry.open();
        if (blob.size !== size) throw new Error("it changed after it was read");
        await deps.api.put(
          current.uploadUrl,
          blob,
          current.checksumSha256B64,
          (loaded) => {
            fp.loaded = Math.min(loaded, size);
            publishUpload();
          },
          signal
        );
        active.delete(entry.path);
        uploadedBytes += size;
        done.set(entry.path, payload(entry, { tmpKey: current.tmpKey }));
        publishUpload();
        return;
      } catch (err) {
        active.delete(entry.path);
        if (isAbortError(err) || err instanceof ArchiveError) throw err;
        if (attempt >= UPLOAD_RETRIES) {
          setFailed(entry.path, { ...fp, loaded: 0, error: err instanceof Error ? err.message : String(err) });
          publishUpload();
          return;
        }
        publishUpload();
        await deps.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
        if (isExpired(err) && sessionId) {
          try {
            const fresh = await deps.api.checkFiles({ uploadSessionId: sessionId, files: [checkItem(entry)] }, signal);
            const again = fresh.files[0];
            if (again?.exists && again.s3Key) {
              markAlreadyUploaded(entry, again.s3Key);
              publishUpload();
              return;
            }
            if (again) current = again;
          } catch (presignErr) {
            if (isAbortError(presignErr)) throw presignErr;
          }
        }
      }
    }
  };
  progress.update({ step: "checking" });
  publishUpload();
  progress.flush();
  for (const batch of chunk(entries.filter((e) => !done.has(e.path)), CHECK_CHUNK_SIZE)) {
    if (signal.aborted) throw abortError();
    progress.update({ step: "checking" });
    const response = await checkChunk(batch);
    const byPath = new Map(response.files.map((f) => [f.filename, f]));
    const uploads = [];
    for (const entry of batch) {
      const result = byPath.get(entry.path);
      if (!result) throw new UploadError(`The server did not answer for ${entry.path}`, snapshotResume());
      if (result.exists && result.s3Key) markAlreadyUploaded(entry, result.s3Key);
      else uploads.push({ entry, result });
    }
    progress.update({ step: "uploading" });
    publishUpload();
    progress.flush();
    await mapWithConcurrency(uploads, UPLOAD_CONCURRENCY, ({ entry, result }) => uploadOne(entry, result), signal);
  }
  if (failed.size > 0) {
    progress.update({ alreadyUploadedFiles, alreadyUploadedBytes, uploadedBytes, active: [], failed: failedList });
    progress.flush();
    return { status: "incomplete", failed: [...failed.values()], resume: snapshotResume() };
  }
  if (!sessionId) throw new UploadError("No upload session — start the upload again.", null);
  progress.update({ step: "creating", active: [] });
  progress.flush();
  let created;
  try {
    created = await deps.api.createBuild(
      {
        ...input.baseVersion ? { baseVersion: input.baseVersion } : {},
        releaseNotes: input.releaseNotes,
        uploadSessionId: sessionId,
        files: entries.map((e) => done.get(e.path))
      },
      signal
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (deps.errorCode(err) === "UPLOAD_SESSION_INVALID") throw sessionExpired();
    if (deps.errorCode(err) === "FILE_NOT_OWNED" && !options.fileNotOwnedRetried) {
      for (const [path, p] of done) if (p.s3Key) done.delete(path);
      return runUpload(input, deps, signal, snapshotResume(), { fileNotOwnedRetried: true });
    }
    throw new UploadError(deps.describeError(err, "Couldn’t create the build"), snapshotResume());
  }
  progress.update({ step: "processing" });
  progress.flush();
  return { status: "created", buildId: created.id };
}

// ../../web/frontend/lib/utils/file-hash.ts
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ../../web/frontend/lib/upload/progress.ts
var EMPTY_PROGRESS = {
  step: null,
  totalFiles: 0,
  totalBytes: 0,
  readBytes: 0,
  alreadyUploadedFiles: 0,
  alreadyUploadedBytes: 0,
  uploadedBytes: 0,
  active: [],
  failed: []
};
var PROGRESS_INTERVAL_MS = 250;
function createProgressStore(opts = {}) {
  const intervalMs = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
  const listeners = /* @__PURE__ */ new Set();
  let published = EMPTY_PROGRESS;
  let pending = EMPTY_PROGRESS;
  let timer = null;
  const publish = () => {
    timer = null;
    if (published === pending) return;
    published = pending;
    listeners.forEach((listener) => listener());
  };
  const cancelTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  return {
    getSnapshot: () => published,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(patch) {
      pending = { ...pending, ...patch };
      if (timer === null) timer = setTimer(publish, intervalMs);
    },
    flush() {
      cancelTimer();
      publish();
    },
    reset() {
      cancelTimer();
      pending = EMPTY_PROGRESS;
      publish();
    }
  };
}

// src/api.ts
var API_RETRIES = 4;
var API_RETRY_BASE_MS = 1e3;
var RETRY_AFTER_CAP_MS = 3e4;
var API_TIMEOUT_MS = 6e4;
var putTimeoutMs = (bytes) => 12e4 + Math.ceil(bytes / (256 * 1024)) * 1e3;
var USER_AGENT = "omnihorn-upload-build/1";
var CiApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "CiApiError";
  }
  status;
  code;
};
function withDeadline(signal, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    timedOut: () => timedOut,
    done: () => clearTimeout(timer)
  };
}
var NEVER = new AbortController().signal;
function backoff(attempt) {
  return API_RETRY_BASE_MS * 2 ** attempt;
}
function retryDelay(res, payload, attempt) {
  const header = Number(res.headers.get("retry-after"));
  const body = Number(payload?.retryAfterSeconds);
  const seconds = Number.isFinite(header) && header > 0 ? header : body;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1e3, RETRY_AFTER_CAP_MS) : backoff(attempt);
}
function networkReason(err) {
  const code = err?.cause?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.message : String(err);
}
function toApiError(status, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const code = typeof p.code === "string" ? p.code : void 0;
  const serverMessage = Array.isArray(p.message) ? p.message.join(", ") : typeof p.message === "string" ? p.message : "";
  if (status === 401) {
    return new CiApiError(
      401,
      code ?? "INVALID_API_KEY",
      "The API key was refused (missing, unknown or revoked). Check the OMNIHORN_API_KEY secret; if the key was revoked, create a new one on the app’s CI/CD tab."
    );
  }
  if (status === 403 && serverMessage === "workspace_suspended") {
    return new CiApiError(403, "workspace_suspended", "This Omnihorn workspace is suspended. Contact Omnihorn support.");
  }
  const text = serverMessage || `HTTP ${status}`;
  return new CiApiError(status, code, code ? `${text} (${code})` : text);
}
function putFailureMessage(status, detail) {
  const withDetail = (text, inner) => inner ? `${text} (${inner})` : text;
  if (status === 403) return withDetail("The upload link expired", detail);
  if (status >= 500) return withDetail(`The storage server answered ${status}`, detail);
  return withDetail("The storage server refused the upload", detail ? `${status}: ${detail}` : String(status));
}
function createCiClient(opts) {
  const base = opts.apiUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? sleepWithSignal;
  const retries = opts.retries ?? API_RETRIES;
  const apiTimeout = opts.apiTimeoutMs ?? API_TIMEOUT_MS;
  const putTimeout = opts.putTimeoutMs ?? putTimeoutMs;
  async function request(method, path, body, signal = NEVER) {
    for (let attempt = 0; ; attempt++) {
      const deadline = withDeadline(signal, apiTimeout);
      let res;
      let payload;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            ...body === void 0 ? {} : { "Content-Type": "application/json" }
          },
          body: body === void 0 ? void 0 : JSON.stringify(body),
          // The API never redirects; following one could hand the key to another host.
          redirect: "error",
          signal: deadline.signal
        });
        payload = res.ok ? await res.json() : await res.json().catch(() => null);
      } catch (err) {
        if (signal.aborted || isAbortError(err) && !deadline.timedOut()) throw err;
        const reason = deadline.timedOut() ? `no answer within ${Math.round(apiTimeout / 1e3)} s` : networkReason(err);
        if (attempt >= retries) throw new CiApiError(null, void 0, `Could not reach ${base}: ${reason}`);
        await sleep(backoff(attempt), signal);
        continue;
      } finally {
        deadline.done();
      }
      if (res.ok) return payload;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(retryDelay(res, payload, attempt), signal);
        continue;
      }
      throw toApiError(res.status, payload);
    }
  }
  async function put(url, blob, checksum, onProgress, signal) {
    const deadline = withDeadline(signal, putTimeout(blob.size));
    let res;
    try {
      res = await doFetch(url, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": UPLOAD_CONTENT_TYPE, "x-amz-checksum-sha256": checksum },
        signal: deadline.signal
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err) && !deadline.timedOut()) throw err;
      throw new UploadHttpError(null, deadline.timedOut() ? "The storage server did not answer in time" : "Could not reach the storage server");
    } finally {
      deadline.done();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
      throw new UploadHttpError(res.status, putFailureMessage(res.status, detail));
    }
    onProgress(blob.size);
  }
  return {
    whoami: (signal) => request("GET", "/ci/v1/whoami", void 0, signal),
    checkFiles: (req, signal) => request("POST", "/ci/v1/builds/check-files", req, signal),
    createBuild: (body, signal) => request("POST", "/ci/v1/builds", body, signal),
    getBuild: (id, signal) => request("GET", `/ci/v1/builds/${encodeURIComponent(id)}`, void 0, signal),
    put
  };
}

// src/files.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var IGNORED_DIRECTORIES = /* @__PURE__ */ new Set([".git"]);
async function walkDirectory(root, open = (p) => (0, import_node_fs.openAsBlob)(p)) {
  const rootStat = await (0, import_promises.lstat)(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) throw new Error(`"${root}" is not a directory`);
  const out = [];
  async function visit(dir) {
    const items = await (0, import_promises.readdir)(dir, { withFileTypes: true });
    items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of items) {
      const absolute = (0, import_node_path.join)(dir, item.name);
      const path = (0, import_node_path.relative)(root, absolute).split(import_node_path.sep).join("/");
      if (item.isSymbolicLink()) {
        out.push({ path, size: 0, kind: "symlink", open: () => Promise.reject(new Error("symbolic links are not uploaded")) });
      } else if (item.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(item.name)) await visit(absolute);
      } else if (item.isFile()) {
        const { size } = await (0, import_promises.lstat)(absolute);
        out.push({ path, size, kind: "file", open: () => open(absolute) });
      }
    }
  }
  await visit(root);
  return out;
}

// src/hash.ts
var import_node_crypto = require("node:crypto");
async function hashBlob(blob, onBytes, signal) {
  const hash = (0, import_node_crypto.createHash)("sha256");
  const reader = blob.stream().getReader();
  let read = 0;
  try {
    for (; ; ) {
      if (signal.aborted) {
        await reader.cancel().catch(() => void 0);
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      read += value.byteLength;
      onBytes(read);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}

// src/github.ts
var SOURCE_REF_MAX = 200;
var COMMIT_MESSAGE_MAX = 500;
var ACTOR_MAX = 100;
var RUN_URL_MAX = 500;
function clip(value, max) {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max - 1).join("")}…`;
}
function cleanSource(raw) {
  const warnings = [];
  const source = { provider: raw.provider };
  for (const field of ["branch", "tag"]) {
    const value = raw[field]?.trim();
    if (!value) continue;
    if (value.length > SOURCE_REF_MAX) {
      warnings.push(`The ${field} name is longer than ${SOURCE_REF_MAX} characters, so it is not sent with the build.`);
    } else {
      source[field] = value;
    }
  }
  if (source.tag) delete source.branch;
  const commit = raw.commit?.trim().toLowerCase();
  if (commit) {
    if (/^[0-9a-f]{7,64}$/.test(commit)) source.commit = commit;
    else warnings.push(`"${clip(raw.commit.trim(), 80)}" is not a commit SHA, so it is not sent with the build.`);
  }
  const message = raw.commitMessage?.trim();
  if (message) source.commitMessage = clip(message, COMMIT_MESSAGE_MAX);
  const actor = raw.actor?.trim();
  if (actor) source.actor = clip(actor, ACTOR_MAX);
  const runUrl = raw.runUrl?.trim();
  if (runUrl) {
    if (/^https?:\/\//.test(runUrl) && runUrl.length <= RUN_URL_MAX) source.runUrl = runUrl;
    else warnings.push(`The CI run URL is not an http(s) URL of at most ${RUN_URL_MAX} characters, so it is not sent.`);
  }
  return { source, warnings };
}

// src/inputs.ts
var DEFAULT_API_URL = "https://api.omnihorn.com";
var VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
var CHANNEL_MAX = 100;
var RELEASE_NOTES_MAX = 1e4;
var CHANNEL_PATTERN = /^[a-z0-9-]+$/;
var InputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
};
function checked(o) {
  if (!o.path) throw new InputError("path is required: the folder whose files make up the build, e.g. ./dist");
  if (o.version && !VERSION_PATTERN.test(o.version)) {
    throw new InputError(`version must be MAJOR.MINOR.PATCH (e.g. 1.4.0), got "${o.version}"`);
  }
  if (o.channel && !CHANNEL_PATTERN.test(o.channel)) {
    throw new InputError(`channel must be a channel name (lowercase letters, numbers and hyphens), got "${o.channel}"`);
  }
  if (o.channel && o.channel.length > CHANNEL_MAX) throw new InputError(`channel must be at most ${CHANNEL_MAX} characters`);
  if (o.releaseNotes.length > RELEASE_NOTES_MAX) {
    throw new InputError(`release-notes must be at most ${RELEASE_NOTES_MAX} characters, got ${o.releaseNotes.length}`);
  }
  if (!/^https?:\/\//.test(o.apiUrl)) throw new InputError(`api-url must be an http(s) URL, got "${o.apiUrl}"`);
  return o;
}
var CLI_USAGE = `Usage: node dist/cli.js --path <folder> [options]

Uploads a build to Omnihorn. The API key is read from the OMNIHORN_API_KEY
environment variable (never from a flag, so it stays out of process lists).

  --path <folder>              the folder whose files make up the build (required)
  --version <x.y.z>            base version; omitted -> the latest build's is reused
  --release-notes <text>
  --channel <name>             also assign the build to this existing channel
  --no-create-branch-channel   never create a channel for a new branch
  --no-wait                    do not wait until the build is active
  --api-url <url>              default: $OMNIHORN_API_URL or ${DEFAULT_API_URL}
  --provider <github|gitlab|other>
  --branch <name>  --tag <name>  --commit <sha>  --commit-message <text>
  --help

On GitLab CI (GITLAB_CI=true) the branch, tag, commit, title, user and pipeline
URL are read from the predefined CI_* variables unless given as flags.`;
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "path",
  "version",
  "release-notes",
  "channel",
  "api-url",
  "provider",
  "branch",
  "tag",
  "commit",
  "commit-message"
]);
function parseCliArgs(argv, env) {
  const values = /* @__PURE__ */ new Map();
  let createBranchChannel = true;
  let wait = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--no-create-branch-channel") {
      createBranchChannel = false;
      continue;
    }
    if (arg === "--no-wait") {
      wait = false;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !VALUE_FLAGS.has(match[1])) throw new InputError(`Unknown argument "${arg}". Run with --help.`);
    const value = match[2] ?? argv[++i];
    if (value === void 0) throw new InputError(`--${match[1]} needs a value`);
    values.set(match[1], value);
  }
  const provider = values.get("provider") ?? (env.GITLAB_CI === "true" ? "gitlab" : "other");
  if (provider !== "github" && provider !== "gitlab" && provider !== "other") {
    throw new InputError("--provider must be github, gitlab or other");
  }
  const detected = provider === "gitlab" ? gitlabSource(env) : { provider };
  const flag = (name) => values.has(name) ? values.get(name) : void 0;
  const { source, warnings } = cleanSource({
    ...detected,
    ...flag("tag") !== void 0 ? { tag: flag("tag"), branch: void 0 } : {},
    ...flag("branch") !== void 0 ? { branch: flag("branch") } : {},
    ...flag("commit") !== void 0 ? { commit: flag("commit") } : {},
    ...flag("commit-message") !== void 0 ? { commitMessage: flag("commit-message") } : {}
  });
  const options = checked({
    apiUrl: (values.get("api-url") ?? env.OMNIHORN_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    apiKey: (env.OMNIHORN_API_KEY ?? "").trim(),
    path: values.get("path") ?? "",
    version: values.get("version") || void 0,
    releaseNotes: values.get("release-notes") ?? "",
    channel: values.get("channel") || void 0,
    createBranchChannel,
    wait,
    source
  });
  if (!options.apiKey) {
    throw new InputError(
      "OMNIHORN_API_KEY is not set. Create a key on the app’s CI/CD tab in Omnihorn and give it to this job as the OMNIHORN_API_KEY variable."
    );
  }
  return { kind: "run", options, warnings };
}
function gitlabSource(env) {
  const tag = env.CI_COMMIT_TAG || void 0;
  return {
    provider: "gitlab",
    tag,
    branch: tag ? void 0 : env.CI_COMMIT_BRANCH || env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || void 0,
    commit: env.CI_COMMIT_SHA || void 0,
    commitMessage: env.CI_COMMIT_TITLE || void 0,
    actor: env.GITLAB_USER_LOGIN || void 0,
    runUrl: env.CI_PIPELINE_URL || void 0
  };
}

// src/report.ts
var CHANNEL_NOTES = {
  plan_limit: "No branch channel was created: the plan’s channel limit is reached. Upgrade, delete a channel, or make an existing channel follow this branch.",
  live_installer_cap: "A following channel kept its build: assigning this one would put more installer designs live than the plan allows.",
  channel_not_found: "The channel named in the `channel` input does not exist in this app.",
  name_conflict: "No branch channel was created: its name is already taken.",
  hook_failed: "Channels were not updated because of a server error. Assign the build on the dashboard."
};
var REASONS = {
  already_current: "already on this build",
  newer_build: "a newer build is already there",
  live_installer_cap: "the plan’s live installer limit",
  channel_deleted: "the channel was deleted",
  build_deleted: "the build was deleted before it reached the channel"
};
var FAILURE_HINTS = {
  FILE_RECLAIMED: "A file this build reused from an earlier upload was removed from storage — run the job again to upload it."
};
function failureText(reason) {
  const hint = FAILURE_HINTS[reason.split(":", 1)[0].trim()];
  return hint ? `${reason}. ${hint}` : reason;
}
function statusText(r, joiner) {
  return r.deleted ? `${r.status}${joiner}deleted` : r.status;
}
function channelNoteText(note) {
  if (!note) return null;
  return CHANNEL_NOTES[note] ?? `Channel note: ${note}`;
}
function channelLine(o) {
  const reason = o.reason ? REASONS[o.reason] ?? o.reason : null;
  if (o.action === "created") {
    return reason ? `created channel "${o.name}" (not assigned: ${reason})` : `created channel "${o.name}" and assigned the build`;
  }
  if (o.action === "assigned") return `assigned to channel "${o.name}"`;
  return `channel "${o.name}" unchanged${reason ? ` (${reason})` : ""}`;
}
function exitCodeOf(r) {
  return r.status === "failed" || r.deleted ? 1 : 0;
}
function outputsOf(r) {
  return { "build-id": r.buildId, version: r.version, status: r.status, channels: JSON.stringify(r.channels) };
}
function channelLines(r) {
  if (r.deleted) return ["none (the build was deleted)"];
  if (!r.waited) return ["not waited for (`wait: false`) — see the Builds tab in Omnihorn"];
  if (r.status !== "active") return ["none (the build is not active)"];
  if (!r.channelsSettled) return ["not settled yet — see the Channels tab in Omnihorn"];
  if (r.channels.length === 0) return ["none"];
  return r.channels.map(channelLine);
}
function summaryText(r) {
  const lines = [`Build ${r.version} — ${statusText(r, ", ")}${r.failureReason ? ` (${failureText(r.failureReason)})` : ""}`];
  if (r.source?.tag) lines.push(`Tag: ${r.source.tag}`);
  if (r.source?.branch) lines.push(`Branch: ${r.source.branch}`);
  lines.push(`Files: ${r.fileCount} (${formatBytes(r.totalBytes)}), ${r.alreadyUploadedFiles} already uploaded`);
  lines.push(...channelLines(r).map((l) => `Channels: ${l}`));
  const note = channelNoteText(r.channelNote);
  if (note) lines.push(note);
  return lines.join("\n");
}

// src/upload.ts
var HASH_CONCURRENCY = 4;
var POLL_INTERVAL_MS = 5e3;
var WAIT_TIMEOUT_MS = 15 * 6e4;
var SETTLE_TIMEOUT_MS = 6e4;
var PROGRESS_LOG_INTERVAL_MS = 5e3;
var UploadFailure = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadFailure";
  }
};
function progressLine(s) {
  switch (s.step) {
    case "reading":
      return `Hashing: ${formatBytes(s.readBytes)} of ${formatBytes(s.totalBytes)}`;
    case "checking":
    case "uploading":
      return `Uploading: ${formatBytes(s.alreadyUploadedBytes + s.uploadedBytes)} of ${formatBytes(s.totalBytes)} (${s.alreadyUploadedFiles} of ${s.totalFiles} files already uploaded)`;
    case "creating":
      return "Creating the build…";
    default:
      return null;
  }
}
function uploadApi(client, options) {
  return {
    checkFiles: (request, signal) => client.checkFiles(request, signal),
    put: (url, blob, checksum, onProgress, signal) => client.put(url, blob, checksum, onProgress, signal),
    createBuild: (payload, signal) => client.createBuild(
      {
        ...payload,
        ...options.source ? { source: options.source } : {},
        options: {
          createBranchChannel: options.createBranchChannel,
          ...options.channel ? { channel: options.channel } : {}
        }
      },
      signal
    )
  };
}
async function upload(options, rt) {
  const me = await rt.client.whoami(rt.signal);
  rt.log(`Uploading to "${me.app.name}" with the key "${me.key.name}" (nk_${me.key.prefix}…)`);
  const raw = await rt.walk(options.path);
  const { entries, notes, problems } = normalizeEntries(raw, { stripCommonRoot: false });
  for (const note of notes) rt.log(note);
  if (problems.length > 0) {
    throw new UploadFailure(["The build folder cannot be uploaded:", ...describeProblems(problems)].join("\n"));
  }
  const progress = createProgressStore({ intervalMs: rt.progressIntervalMs ?? PROGRESS_LOG_INTERVAL_MS });
  let lastLine = "";
  const unsubscribe = progress.subscribe(() => {
    const line = progressLine(progress.getSnapshot());
    if (line && line !== lastLine) {
      lastLine = line;
      rt.log(line);
    }
  });
  const deps = {
    api: uploadApi(rt.client, options),
    hash: rt.hash,
    hashConcurrency: HASH_CONCURRENCY,
    sleep: rt.sleep,
    progress,
    describeError: (err, fallback) => err instanceof Error && err.message ? err.message : fallback,
    errorCode: (err) => err instanceof CiApiError ? err.code : void 0
  };
  const input = {
    entries,
    releaseNotes: options.releaseNotes,
    ...options.version ? { baseVersion: options.version } : {}
  };
  let result;
  try {
    result = await runUpload(input, deps, rt.signal);
    if (result.status === "incomplete") {
      rt.log(`${result.failed.length} file(s) failed after 3 retries — trying them once more`);
      result = await runUpload(input, deps, rt.signal, result.resume);
    }
  } catch (err) {
    if (err instanceof UploadError) throw new UploadFailure(err.message);
    throw err;
  } finally {
    progress.flush();
    unsubscribe();
  }
  if (result.status === "incomplete") {
    throw new UploadFailure(
      [
        `${result.failed.length} file(s) could not be uploaded:`,
        ...result.failed.map((f) => `  ${f.path}: ${f.error ?? "unknown error"}`)
      ].join("\n")
    );
  }
  const snapshot = progress.getSnapshot();
  let build = await rt.client.getBuild(result.buildId, rt.signal);
  rt.log(`Build ${build.version} created (${build.id})`);
  if (options.wait) build = await waitForBuild(rt, build);
  return {
    appName: me.app.name,
    buildId: build.id,
    version: build.version,
    status: build.status,
    failureReason: build.failureReason,
    fileCount: snapshot.totalFiles,
    totalBytes: snapshot.totalBytes,
    alreadyUploadedFiles: snapshot.alreadyUploadedFiles,
    ...options.source ? { source: options.source } : {},
    channels: build.channels,
    ...build.channelNote ? { channelNote: build.channelNote } : {},
    waited: options.wait,
    channelsSettled: build.channelsSettled,
    ...build.deletedAt ? { deleted: true } : {}
  };
}
async function waitForBuild(rt, first) {
  const poll = rt.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeout = rt.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = rt.now() + timeout;
  let build = first;
  if (build.status === "processing") rt.log("Waiting for the build to be scanned, verified and signed…");
  while (build.status === "processing" && !build.deletedAt) {
    if (rt.now() >= deadline) {
      throw new UploadFailure(
        `Build ${build.version} is still processing after ${Math.round(timeout / 6e4)} minutes. It may still finish — see the Builds tab in Omnihorn.`
      );
    }
    await rt.sleep(poll, rt.signal);
    build = await rt.client.getBuild(build.id, rt.signal);
  }
  const settleBy = rt.now() + (rt.settleTimeoutMs ?? SETTLE_TIMEOUT_MS);
  while (build.status === "active" && !build.channelsSettled && !build.deletedAt && rt.now() < settleBy) {
    await rt.sleep(Math.min(poll, 2e3), rt.signal);
    build = await rt.client.getBuild(build.id, rt.signal);
  }
  if (build.deletedAt) rt.log(`Build ${build.version} was deleted (${build.deletedAt}) — it will not be served. See the Builds tab in Omnihorn.`);
  return build;
}

// src/cli-main.ts
var messageOf = (err) => err instanceof Error ? err.message : String(err);
async function runCli(argv, env, io = {
  log: (line) => console.log(line),
  error: (line) => console.error(line)
}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, env);
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }
  if (parsed.kind === "help") {
    io.log(CLI_USAGE);
    return 0;
  }
  for (const warning of parsed.warnings) io.error(`warning: ${warning}`);
  const { options } = parsed;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const report = await upload(options, {
      client: createCiClient({ apiUrl: options.apiUrl, apiKey: options.apiKey }),
      walk: (root) => walkDirectory(root),
      hash: hashBlob,
      log: io.log,
      sleep: sleepWithSignal,
      now: () => Date.now(),
      signal: controller.signal
    });
    io.log(summaryText(report));
    for (const [name, value] of Object.entries(outputsOf(report))) io.log(`${name}=${value}`);
    return exitCodeOf(report);
  } catch (err) {
    io.error(messageOf(err));
    return 1;
  }
}

// src/cli.ts
void runCli(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
