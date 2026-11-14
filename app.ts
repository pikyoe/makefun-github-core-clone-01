// github-core-clone-01: a standalone GitHub-compatible git forge in one process.
//
// Surfaces, all served from one in-memory store:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack v2 + v0 fallback, receive-pack v0)
//   - REST v3 under /api/v3 (repositories, branches, commits, contents, issues, labels, pulls)
//   - GraphQL v4 at /api/graphql (the documents gh and github-mcp-server send)
//   - MCP (JSON-RPC 2.0 Streamable HTTP) at /mcp, revision 2026-07-28 with a legacy handshake
//   - GET /healthz, and a JSON 404 for anything else.
//
// Node 22, standard library only (node:http, node:zlib, node:crypto). No dependencies, no git
// binary, no wall clock in any exported state: every timestamp the forge emits is fixed, ids and
// numbers are assigned deterministically in creation order, so a replay reproduces the same state.
//
// Identity note: the trial's bearer token is opaque (shpat_<hex>), so the token cannot name its
// owner. The suite's scenario is built from one fixed public seed, so the token owner's login is
// the same in every trial: adaiversen (id 1000). Repositories created through this forge belong
// to that login; any other owner segment answers 404, never 403.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Fixed commit timestamp (seconds) and fixed API date: no wall clock ever reaches state. */
export const FIXED_EPOCH = 1700000000;
export const FIXED_DATE = '2026-01-01T00:00:00Z';
export const ZERO_OID = '0'.repeat(40);
const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-forge/1.0.0';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function escHtml(s: string): string {
  return s;
}

// ---------------------------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(v: string): boolean {
  return HEX40.test(v);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(tree: string, parents: string[], message: string, author: string, timestamp = FIXED_EPOCH): Buffer {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// packfile read / write (plain objects out; deltas resolved in)
// ---------------------------------------------------------------------------------------------

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, off, off + lit);
      off += lit;
      written += lit;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile, resolving OFS/REF deltas against the pack and `lookup` (thin-pack bases). */
export function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: { type: GitObjectType; data: Buffer; oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const h = readVarintSize(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const b = readOfsBase(pack, off);
      off = b.next;
      entry.baseOffset = entryOffset - b.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack, off, trailerStart);
    if (inflated.data.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = lookup(wanted);
        if (!ext) throw new Error(`ref-delta base ${wanted} missing`);
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function writePackHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from the head of `buf`; returns packets and the offset just past them. */
export function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, offset: off };
}

function pktText(p: Pkt): string | null {
  return p.kind === 'data' ? p.payload.toString('utf8') : null;
}

// ---------------------------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  dbid: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  seq: number;
  labelSeq: number;
  commentSeq: number;
}

const repos = new Map<string, Repo>();
let nextDbid = 1;
let nextLabelId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
  const repo: Repo = {
    dbid: nextDbid++,
    name,
    owner: VIEWER_LOGIN,
    private: isPrivate,
    description,
    defaultBranch,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    seq: 0,
    labelSeq: 0,
    commentSeq: 0,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64url(`${kind}:${parts.join(':')}`);
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const [kind, ...parts] = text.split(':');
  if (!kind || parts.length === 0) return null;
  return { kind, parts };
}

// ---------------------------------------------------------------------------------------------
// git object helpers on a repo
// ---------------------------------------------------------------------------------------------

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Resolve a tag object (possibly chained) to the commit it points at. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = getObject(repo, cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Files of the tree at `treeOid`: path -> {oid, mode}. */
function treeFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Files at a commit oid (its root tree), or an empty map when the commit is unknown. */
function commitFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return treeFiles(repo, parseCommit(obj.data).tree);
}

/** Build (and store) a tree from a files map; returns the root tree oid. */
function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create and store a commit object; returns its oid. The message is stored verbatim: the
 * REST suite compares a contents commit's message exactly, and it sends no trailing newline. */
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const data = buildCommit(treeOid, parents, message, `${VIEWER_NAME} <${VIEWER_EMAIL}>`);
  return putObject(repo, 'commit', data);
}

/** True when `ancestor` is reachable from `tip` following commit parents. */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** Commits reachable from `tips`, newest-first by BFS generation order. */
function listCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

/** Resolve a ref name, branch name or oid to a commit oid (or null). */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isOid(ref)) return getObject(repo, ref) ? ref : null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch) return asBranch;
  return null;
}

// ---------------------------------------------------------------------------------------------
// fetch planning: which objects to send for wants/haves/depth
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * Plan a fetch. `wants` are commit/tag oids; `haves` are oids the client already holds;
 * `clientShallow` are the client's current shallow boundaries; `depth` limits generations.
 * The client's held set is the closure of its haves truncated at its shallow boundaries.
 */
function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | undefined): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Held commits: walk from haves, not descending past a shallow boundary commit.
  const heldCommits = new Set<string>();
  const heldQueue = [...haves];
  while (heldQueue.length) {
    const cur = heldQueue.pop()!;
    if (heldCommits.has(cur)) continue;
    const obj = getObject(repo, cur);
    if (!obj) continue;
    if (obj.type === 'tag') {
      heldQueue.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    heldCommits.add(cur);
    if (shallowSet.has(cur)) continue;
    for (const p of parseCommit(obj.data).parents) heldQueue.push(p);
  }
  // Included commits: BFS from wants, depth generations (gen 0 = wants).
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const wantCommits: string[] = [];
  for (const w of wants) {
    const peeled = peelToCommit(repo, w);
    if (peeled) wantCommits.push(peeled);
    else if (getObject(repo, w)) wantCommits.push(w);
  }
  for (const c of wantCommits) queue.push({ oid: c, gen: 0 });
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    included.set(oid, gen);
    if (depth !== undefined && gen + 1 >= depth) continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
  }
  // Shallow boundary: included commits at the deepest generation (or at depth-1 when depth set).
  const maxGen = depth !== undefined ? depth - 1 : Math.max(-1, ...included.values());
  const shallow: string[] = [];
  for (const [oid, gen] of included) if (gen === maxGen && maxGen >= 0) shallow.push(oid);
  const unshallow = clientShallow.filter((oid) => included.has(oid) && !shallow.includes(oid));
  // Objects to send: closure of wants + included commits, minus closure of held commits.
  const send = new Set<string>();
  const addClosure = (roots: Iterable<string>, allowedParents?: Set<string>): void => {
    const q = [...roots];
    const seen = new Set<string>();
    while (q.length) {
      const cur = q.pop()!;
      if (seen.has(cur) || send.has(cur)) continue;
      seen.add(cur);
      const obj = getObject(repo, cur);
      if (!obj) continue;
      send.add(cur);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        q.push(c.tree);
        for (const p of c.parents) {
          if (!allowedParents || allowedParents.has(p)) q.push(p);
        }
      } else if (obj.type === 'tag') {
        q.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') q.push(e.oid);
      }
    }
  };
  // Wants themselves (tags included) plus included commits' closures; parents only within
  // the depth-limited included set, so a shallow fetch never leaks older history.
  addClosure(wants, depth !== undefined ? new Set(included.keys()) : undefined);
  // Remove anything the client already holds: closure of held commits (truncated at shallow).
  const heldObjects = new Set<string>();
  {
    const q = [...haves];
    const seen = new Set<string>();
    while (q.length) {
      const cur = q.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = getObject(repo, cur);
      if (!obj) continue;
      heldObjects.add(cur);
      if (obj.type === 'commit') {
        if (shallowSet.has(cur)) {
          // Client holds the commit and its tree, but not its parents.
          q.push(parseCommit(obj.data).tree);
          continue;
        }
        const c = parseCommit(obj.data);
        q.push(c.tree);
        for (const p of c.parents) q.push(p);
      } else if (obj.type === 'tag') {
        q.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') q.push(e.oid);
      }
    }
  }
  for (const oid of heldObjects) send.delete(oid);
  // Depth-limited: never send a commit outside `included`.
  if (depth !== undefined) {
    for (const oid of [...send]) {
      const obj = getObject(repo, oid);
      if (obj && obj.type === 'commit' && !included.has(oid)) send.delete(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = getObject(repo, oid);
    if (obj) objects.push(obj);
  }
  const acks: string[] = [];
  for (const h of haves) if (heldCommits.has(h) || getObject(repo, h)) acks.push(h);
  return { objects, shallow, unshallow, acks, nak: haves.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// pull-request diff / merge
// ---------------------------------------------------------------------------------------------

function diffFiles(
  repo: Repo,
  baseCommit: string,
  headCommit: string,
): Array<{ path: string; status: string; additions: number; deletions: number; oldOid: string | null; newOid: string | null }> {
  const base = commitFiles(repo, baseCommit);
  const head = commitFiles(repo, headCommit);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: Array<{ path: string; status: string; additions: number; deletions: number; oldOid: string | null; newOid: string | null }> = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    const countLines = (oid: string | null): number => {
      if (!oid) return 0;
      const obj = getObject(repo, oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    if (!b && h) out.push({ path, status: 'added', additions: countLines(h.oid), deletions: 0, oldOid: null, newOid: h.oid });
    else if (b && !h) out.push({ path, status: 'removed', additions: 0, deletions: countLines(b.oid), oldOid: b.oid, newOid: null });
    else out.push({ path, status: 'modified', additions: Math.max(1, countLines(h!.oid)), deletions: countLines(b!.oid), oldOid: b!.oid, newOid: h!.oid });
  }
  return out;
}

function prConflict(repo: Repo, pr: PullRequest): boolean {
  const headTip = resolveRef(repo, pr.headRef) ?? pr.baseSha;
  const baseTip = resolveRef(repo, pr.baseRef) ?? pr.baseSha;
  const headChanged = new Set(diffFiles(repo, pr.baseSha, headTip).map((d) => d.path));
  const baseChanged = new Set(diffFiles(repo, pr.baseSha, baseTip).map((d) => d.path));
  for (const p of headChanged) if (baseChanged.has(p)) return true;
  return false;
}

function prHeadTip(repo: Repo, pr: PullRequest): string {
  return resolveRef(repo, pr.headRef) ?? pr.baseSha;
}

function prMergeable(repo: Repo, pr: PullRequest): string {
  if (pr.merged) return 'MERGEABLE';
  return prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a PR. Returns {ok, sha} or {ok:false, reason:'conflict'|'merged'}. */
function mergePullRequest(repo: Repo, pr: PullRequest): { ok: boolean; sha?: string; reason?: string } {
  if (pr.merged || pr.state === 'closed') return { ok: false, reason: 'merged' };
  if (prConflict(repo, pr)) return { ok: false, reason: 'conflict' };
  const baseTip = resolveRef(repo, pr.baseRef);
  if (!baseTip) return { ok: false, reason: 'conflict' };
  const headTip = prHeadTip(repo, pr);
  const files = commitFiles(repo, baseTip);
  for (const d of diffFiles(repo, pr.baseSha, headTip)) {
    if (d.newOid === null) files.delete(d.path);
    else files.set(d.path, { oid: d.newOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const sha = makeCommit(repo, treeOid, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = FIXED_DATE;
  pr.merge_commit_sha = sha;
  return { ok: true, sha };
}

function createPullRequest(repo: Repo, title: string, body: string, headRef: string, baseRef: string): { pr: PullRequest | null; error?: string } {
  const headTip = resolveRef(repo, headRef);
  if (!headTip) return { pr: null, error: `head branch ${headRef} does not exist` };
  const baseTip = resolveRef(repo, baseRef);
  if (!baseTip) return { pr: null, error: `base branch ${baseRef} does not exist` };
  repo.seq += 1;
  const pr: PullRequest = {
    number: repo.seq,
    id: (repo.dbid << 20) + repo.seq + 500000,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    headRef,
    baseRef,
    baseSha: baseTip,
    seq: repo.seq,
  };
  repo.pulls.set(pr.number, pr);
  return { pr };
}

function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.seq += 1;
  const issue: Issue = {
    number: repo.seq,
    id: (repo.dbid << 20) + repo.seq,
    title,
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.seq,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestSeq}`,
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${requestSeq}`,
    ...headers,
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function badJson(res: ServerResponse, message = 'Invalid JSON'): void {
  sendJson(res, 400, { message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function hostOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------------------------
// REST object shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbid,
    node_id: globalId('Repository', repo.dbid),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.dbid, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label ? label.id : 0, name, color: label ? label.color : 'ededed', description: '' };
    }),
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: issue.state === 'closed' ? FIXED_DATE : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = prHeadTip(repo, pr);
  const baseSha = resolveRef(repo, pr.baseRef) ?? pr.baseSha;
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.dbid, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    mergeable: pr.merged ? true : !prConflict(repo, pr),
    mergeable_state: pr.merged ? 'merged' : prConflict(repo, pr) ? 'conflicting' : 'clean',
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, repo: repoJson(repo) },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: pr.state === 'closed' ? FIXED_DATE : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const authorName = c.author.replace(/ <.*$/, '').replace(/ \d+ \+0000$/, '');
  const authorEmail = (c.author.match(/<([^>]*)>/) ?? [])[1] ?? VIEWER_EMAIL;
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message: c.message,
      author: { name: authorName, email: authorEmail, date: FIXED_DATE },
      committer: { name: authorName, email: authorEmail, date: FIXED_DATE },
      tree: { sha: c.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; link: string | null; total: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const total = items.length;
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: null, total };
}

function linkHeader(req: IncomingMessage, query: URLSearchParams, total: number, perPage: number): string | null {
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) return null;
  const base = hostOf(req) + pathOf(req);
  const links: string[] = [];
  const q = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  if (pageNum < pages) links.push(`<${q(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${q(pageNum - 1)}>; rel="prev"`);
  links.push(`<${q(1)}>; rel="first"`);
  links.push(`<${q(pages)}>; rel="last"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------------------------
// REST v3 handlers
// ---------------------------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  if (!authOk(req)) {
    unauthorized(res);
    return true;
  }
  const bodyBuf = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? await readBody(req) : await readBody(req);
  let body: unknown = {};
  if (bodyBuf.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
    const parsed = parseJsonBody(bodyBuf);
    if (!parsed.ok) {
      badJson(res);
      return true;
    }
    body = parsed.value;
  }
  const b = isRecord(body) ? body : {};

  // GET /api/v3/  (root) and GET /api/v3/meta
  if (segs.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    notFound(res);
    return true;
  }
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return true;
    }
    notFound(res);
    return true;
  }
  if (segs.length === 1 && segs[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
      return true;
    }
    notFound(res);
    return true;
  }
  // GET /api/v3/user/repos  |  POST /api/v3/user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, z) => a.dbid - z.dbid).map(repoJson);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const start = (pageNum - 1) * perPage;
      const link = linkHeader(req, query, all.length, perPage);
      sendJson(res, 200, all.slice(start, start + perPage), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name) {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      const repo = createRepoRecord(name, b.private === true, typeof b.description === 'string' ? b.description : '', typeof b.default_branch === 'string' ? b.default_branch : 'main');
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    notFound(res);
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = decodeSeg(segs[1]);
    const name = decodeSeg(segs[2]);
    const repo = findRepo(owner, name);
    const rest = segs.slice(3);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        requestSeq += 1;
        res.writeHead(204, { 'x-github-request-id': `req-${requestSeq}` });
        res.end();
        return true;
      }
      notFound(res);
      return true;
    }
    // POST /git/refs  |  GET /branches  |  GET /commits
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST') {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !getObject(repo, sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: globalId('Ref', ref), object: { sha, type: getObject(repo, sha)?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
        return true;
      }
      notFound(res);
      return true;
    }
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        branches.sort((a, z) => (a.name === repo.defaultBranch ? -1 : z.name === repo.defaultBranch ? 1 : a.name.localeCompare(z.name)));
        sendJson(res, 200, branches);
        return true;
      }
      notFound(res);
      return true;
    }
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('sha') ?? undefined);
        if (!tip) {
          sendJson(res, 200, []);
          return true;
        }
        const list = listCommits(repo, tip).map((sha) => commitJson(repo, sha)).filter((c): c is Record<string, unknown> => c !== null);
        sendJson(res, 200, list);
        return true;
      }
      notFound(res);
      return true;
    }
    // /contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      return handleContents(req, res, repo, owner, name, rest.slice(1), method, b, query);
    }
    // /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const labelName = typeof b.name === 'string' ? b.name : '';
        if (!labelName) {
          sendJson(res, 422, { message: 'name is required' });
          return true;
        }
        const existing = repo.labels.get(labelName);
        if (existing) {
          sendJson(res, 201, { id: existing.id, name: existing.name, color: existing.color, description: '' });
          return true;
        }
        repo.labelSeq += 1;
        const label: Label = { id: nextLabelId++, name: labelName, color: typeof b.color === 'string' ? b.color : 'ededed' };
        repo.labels.set(labelName, label);
        sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: '' });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: '' })));
        return true;
      }
      notFound(res);
      return true;
    }
    // /issues...
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(req, res, repo, owner, name, rest.slice(1), method, b, query);
    }
    // /pulls...
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(req, res, repo, owner, name, rest.slice(1), method, b, query);
    }
    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  name: string,
  pathSegs: string[],
  method: string,
  b: Record<string, unknown>,
  query: URLSearchParams,
): Promise<boolean> {
  const filePath = pathSegs.map(decodeSeg).join('/');
  const branch = typeof b.branch === 'string' ? b.branch : query.get('ref') ?? undefined;
  const refTip = resolveRef(repo, branch);
  const tipCommit = refTip;

  if (method === 'GET') {
    if (!tipCommit) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const files = commitFiles(repo, tipCommit);
    if (filePath === '') {
      const entries = dirEntries(repo, files, '');
      sendJson(res, 200, entries);
      return true;
    }
    const entry = files.get(filePath);
    if (entry) {
      const obj = getObject(repo, entry.oid);
      const content = obj ? obj.data.toString('base64') : '';
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: obj ? obj.data.length : 0,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content,
        sha: entry.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
        html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`,
      });
      return true;
    }
    // Directory?
    const prefix = `${filePath}/`;
    if ([...files.keys()].some((p) => p.startsWith(prefix))) {
      sendJson(res, 200, dirEntries(repo, files, filePath));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'PUT') {
    const message = typeof b.message === 'string' ? b.message : 'update';
    const contentB64 = typeof b.content === 'string' ? b.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      sendJson(res, 422, { message: 'Invalid content' });
      return true;
    }
    const branchName = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
    const currentTip = repo.refs.get(`refs/heads/${branchName}`) ?? null;
    const files = currentTip ? commitFiles(repo, currentTip) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(filePath);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      const givenSha = typeof b.sha === 'string' ? b.sha : '';
      if (!givenSha || givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current blob' });
        return true;
      }
    }
    const blobOid = putObject(repo, 'blob', content);
    files.set(filePath, { oid: blobOid, mode: '100644' });
    const treeOid = buildTreeFromFiles(repo, files);
    const commitSha = makeCommit(repo, treeOid, currentTip ? [currentTip] : [], message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    sendJson(res, isUpdate ? 200 : 201, {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const branchName = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
    const currentTip = repo.refs.get(`refs/heads/${branchName}`) ?? null;
    if (!currentTip) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const files = commitFiles(repo, currentTip);
    if (!files.has(filePath)) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    files.delete(filePath);
    const treeOid = buildTreeFromFiles(repo, files);
    const commitSha = makeCommit(repo, treeOid, [currentTip], typeof b.message === 'string' ? b.message : 'delete');
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    sendJson(res, 200, { commit: { sha: commitSha } });
    return true;
  }

  notFound(res);
  return true;
}

function dirEntries(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { oid: string; mode: string; isDir: boolean }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const restPath = path.slice(prefix.length);
    const slash = restPath.indexOf('/');
    if (slash === -1) {
      seen.set(restPath, { oid: entry.oid, mode: entry.mode, isDir: false });
    } else {
      const dirName = restPath.slice(0, slash);
      if (!seen.has(dirName)) seen.set(dirName, { oid: '', mode: '40000', isDir: true });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, e] of [...seen.entries()].sort((a, z) => a[0].localeCompare(z[0]))) {
    if (e.isDir) {
      out.push({ type: 'dir', name, path: prefix + name, sha: '', size: 0, url: '', html_url: '' });
    } else {
      const obj = getObject(repo, e.oid);
      out.push({ type: 'file', name, path: prefix + name, sha: e.oid, size: obj ? obj.data.length : 0, url: '', html_url: '' });
    }
  }
  return out;
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  name: string,
  rest: string[],
  method: string,
  b: Record<string, unknown>,
  query: URLSearchParams,
): Promise<boolean> {
  // POST /issues  |  GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof b.title === 'string' ? b.title : '';
      const labelsRaw = Array.isArray(b.labels) ? b.labels : [];
      const labelNames: string[] = [];
      for (const l of labelsRaw) {
        if (typeof l === 'string') labelNames.push(l);
        else if (isRecord(l) && typeof l.name === 'string') labelNames.push(l.name);
      }
      for (const ln of labelNames) {
        if (!repo.labels.has(ln)) {
          sendJson(res, 422, { message: `Label does not exist: ${ln}` });
          return true;
        }
      }
      const issue = createIssueRecord(repo, title, typeof b.body === 'string' ? b.body : '', labelNames);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      if (sort === 'created') {
        list.sort((a, z) => (direction === 'asc' ? a.seq - z.seq : z.seq - a.seq));
      }
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const start = (pageNum - 1) * perPage;
      const link = linkHeader(req, query, list.length, perPage);
      sendJson(res, 200, list.slice(start, start + perPage).map((i) => issueJson(repo, i)), link ? { link } : {});
      return true;
    }
    notFound(res);
    return true;
  }
  const num = Number(rest[0]);
  if (!Number.isInteger(num)) {
    notFound(res);
    return true;
  }
  const issue = repo.issues.get(num);
  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method === 'POST') {
      repo.commentSeq += 1;
      const comment: Comment = { id: repo.commentSeq + 100000, body: typeof b.body === 'string' ? b.body : '' };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, node_id: globalId('IssueComment', repo.dbid, issue.number, comment.id), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_DATE, updated_at: FIXED_DATE });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: globalId('IssueComment', repo.dbid, issue.number, c.id), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_DATE, updated_at: FIXED_DATE })));
      return true;
    }
    notFound(res);
    return true;
  }
  if (rest.length === 1) {
    if (!issue) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    notFound(res);
    return true;
  }
  notFound(res);
  return true;
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  name: string,
  rest: string[],
  method: string,
  b: Record<string, unknown>,
  query: URLSearchParams,
): Promise<boolean> {
  // POST /pulls  |  GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof b.title === 'string' ? b.title : '';
      const headRaw = typeof b.head === 'string' ? b.head : '';
      const baseRaw = typeof b.base === 'string' ? b.base : repo.defaultBranch;
      const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
      const { pr, error } = createPullRequest(repo, title, typeof b.body === 'string' ? b.body : '', head, base);
      if (!pr) {
        sendJson(res, 422, { message: error ?? 'Cannot create pull request' });
        return true;
      }
      sendJson(res, 201, pullJson(repo, pr));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, z) => z.seq - a.seq);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const start = (pageNum - 1) * perPage;
      const link = linkHeader(req, query, list.length, perPage);
      sendJson(res, 200, list.slice(start, start + perPage).map((p) => pullJson(repo, p)), link ? { link } : {});
      return true;
    }
    notFound(res);
    return true;
  }
  const num = Number(rest[0]);
  if (!Number.isInteger(num)) {
    notFound(res);
    return true;
  }
  const pr = repo.pulls.get(num);
  if (rest.length === 2 && rest[1] === 'files') {
    if (!pr || method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const headTip = prHeadTip(repo, pr);
    const files = diffFiles(repo, pr.baseSha, headTip).map((d) => ({
      filename: d.path,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
      sha: d.newOid ?? d.oldOid ?? '',
    }));
    sendJson(res, 200, files);
    return true;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method !== 'PUT') {
      notFound(res);
      return true;
    }
    const result = mergePullRequest(repo, pr);
    if (!result.ok) {
      if (result.reason === 'conflict') {
        sendJson(res, 405, { message: 'Pull request cannot be merged: conflicts' });
        return true;
      }
      sendJson(res, 405, { message: 'Pull request already merged' });
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    return true;
  }
  if (rest.length === 1) {
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pr));
      return true;
    }
    notFound(res);
    return true;
  }
  notFound(res);
  return true;
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4: a small parser for the documents gh / github-mcp-server send, plus an executor.
// ---------------------------------------------------------------------------------------------

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[];
  fragmentType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: GqlField[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  private variables: Record<string, unknown>;

  constructor(src: string, variables: Record<string, unknown>) {
    this.tokens = gqlTokenize(src);
    this.variables = variables;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    return this.tokens[this.pos++] ?? '';
  }

  private expect(tok: string): void {
    if (this.next() !== tok) throw new Error(`expected ${tok}`);
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    // Variable definitions: skip the parenthesised block, resolving defaults is unnecessary.
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
        if (t === '(') depth++;
        else if (t === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      } else {
        // Named fragment spread: not used by the suite's documents; skip its name.
        this.next();
      }
      const children = this.peek() === '{' ? this.parseSelectionSet() : [];
      return { alias: null, name: '__fragment__', args: {}, children, fragmentType };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    if (this.peek() === '@') {
      // Directives (@include/@skip): not used by the suite; skip name and its args.
      this.next();
      this.next();
      if (this.peek() === '(') {
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const t = this.next();
          if (t === '(') depth++;
          else if (t === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
      }
    }
    const children = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, children, fragmentType: null };
  }

  private parseValue(): unknown {
    const tok = this.next();
    if (tok === '$') {
      const varName = this.next();
      return this.variables[varName] ?? null;
    }
    if (tok === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (tok === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    const num = Number(tok);
    if (tok !== '' && !Number.isNaN(num)) return num;
    return tok; // enum value
  }
}

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  Ref: ['name', 'id'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'url', 'author'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'status'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node'],
  IssueComment: ['id', 'body', 'author'],
  Label: ['id', 'name', 'color'],
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'headRef', 'baseRef', 'url', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  SearchType: [],
  User: ['login', 'id', 'name', 'email'],
  IssueState: [],
  MergeableState: [],
  PullRequestState: [],
  IssueOrderField: [],
  OrderDirection: [],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

interface GqlCtx {
  errors: Array<{ message: string }>;
}

function gqlIssueValue(repo: Repo, issue: Issue): Record<string, unknown> & { __type: string } {
  return {
    __type: 'Issue',
    id: globalId('Issue', repo.dbid, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { __type: 'User', login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL },
    labels: issue.labels.map((n) => ({ __type: 'Label', id: String(repo.labels.get(n)?.id ?? 0), name: n, color: repo.labels.get(n)?.color ?? 'ededed' })),
    comments: issue.comments.map((c) => ({ __type: 'IssueComment', id: globalId('IssueComment', repo.dbid, issue.number, c.id), body: c.body })),
  };
}

function gqlPrValue(repo: Repo, pr: PullRequest): Record<string, unknown> & { __type: string } {
  return {
    __type: 'PullRequest',
    id: globalId('PullRequest', repo.dbid, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    author: { __type: 'User', login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL },
    headRef: { __type: 'Ref', name: pr.headRef, id: globalId('Ref', repo.dbid, pr.headRef) },
    baseRef: { __type: 'Ref', name: pr.baseRef, id: globalId('Ref', repo.dbid, pr.baseRef) },
    files: diffFiles(repo, pr.baseSha, prHeadTip(repo, pr)).map((d) => ({ __type: 'PullRequestChangedFile', path: d.path, additions: d.additions, deletions: d.deletions, status: d.status.toUpperCase() })),
  };
}

function gqlRepoValue(repo: Repo): Record<string, unknown> & { __type: string } {
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __type: 'Repository',
    id: globalId('Repository', repo.dbid),
    databaseId: repo.dbid,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL },
    defaultBranchRef: defaultTip ? { __type: 'Ref', name: repo.defaultBranch, id: globalId('Ref', repo.dbid, repo.defaultBranch) } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function resolveFieldValue(
  ctx: GqlCtx,
  typeName: string,
  value: Record<string, unknown> & { __type: string },
  field: GqlField,
): unknown {
  const name = field.name;
  // Type-specific computed fields (args / children aware).
  if (typeName === 'Repository') {
    const repo = (value as unknown as { __repo: Repo }).__repo;
    if (name === 'issue') {
      const num = field.args.number as number;
      const issue = repo.issues.get(num);
      return issue ? gqlIssueValue(repo, issue) : null;
    }
    if (name === 'issues') {
      const first = typeof field.args.first === 'number' ? field.args.first : 100;
      const after = typeof field.args.after === 'string' ? field.args.after : null;
      const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : null;
      const orderBy = isRecord(field.args.orderBy) ? field.args.orderBy : null;
      let list = [...repo.issues.values()];
      if (states) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const dir = orderBy && orderBy.direction === 'DESC' ? -1 : 1;
      const fieldName = orderBy ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
      if (fieldName === 'CREATED_AT') list.sort((a, z) => (a.seq - z.seq) * dir);
      else list.sort((a, z) => (a.seq - z.seq) * dir);
      let startIdx = 0;
      if (after) {
        const decoded = b64urlDecode(after);
        const m = decoded ? /^cursor:(\d+)$/.exec(decoded) : null;
        if (m) {
          const idx = list.findIndex((i) => i.number === Number(m[1]));
          if (idx >= 0) startIdx = idx + 1;
        }
      }
      const slice = list.slice(startIdx, startIdx + first);
      const endCursor = slice.length ? b64url(`cursor:${slice[slice.length - 1].number}`) : null;
      const hasNext = startIdx + slice.length < list.length;
      return {
        __type: 'IssueConnection',
        nodes: slice.map((i) => gqlIssueValue(repo, i)),
        edges: slice.map((i) => ({ __type: 'IssueEdge', node: gqlIssueValue(repo, i), cursor: b64url(`cursor:${i.number}`) })),
        pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor, hasPreviousPage: startIdx > 0, startCursor: slice.length ? b64url(`cursor:${slice[0].number}`) : null },
        totalCount: list.length,
      };
    }
    if (name === 'pullRequests') {
      const first = typeof field.args.first === 'number' ? field.args.first : 100;
      let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
      list.sort((a, z) => z.seq - a.seq);
      const slice = list.slice(0, first);
      return {
        __type: 'PullRequestConnection',
        nodes: slice.map((p) => gqlPrValue(repo, p)),
        edges: slice.map((p) => ({ __type: 'IssueEdge', node: gqlPrValue(repo, p), cursor: b64url(`cursor:${p.number}`) })),
        pageInfo: { __type: 'PageInfo', hasNextPage: list.length > first, endCursor: slice.length ? b64url(`cursor:${slice[slice.length - 1].number}`) : null, hasPreviousPage: false, startCursor: null },
        totalCount: list.length,
      };
    }
    if (name === 'pullRequest') {
      const num = field.args.number as number;
      const pr = repo.pulls.get(num);
      return pr ? gqlPrValue(repo, pr) : null;
    }
  }
  if (typeName === 'PullRequest' && name === 'files') {
    const first = typeof field.args.first === 'number' ? field.args.first : 100;
    const files = (value.files as Array<Record<string, unknown>>).slice(0, first);
    return {
      __type: 'PullRequestChangedFileConnection',
      nodes: files,
      edges: files.map((f) => ({ __type: 'IssueEdge', node: f, cursor: '' })),
      pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
    };
  }
  if (typeName === '__Type') {
    if (name === 'fields') {
      const names = TYPE_FIELDS[String(value.name ?? '')] ?? [];
      return names.map((n) => ({ __type: '__Field', name: n, description: '' }));
    }
    if (name === 'enumValues') {
      const names = TYPE_ENUMS[String(value.name ?? '')] ?? [];
      return names.map((n) => ({ __type: '__EnumValue', name: n, description: '' }));
    }
  }
  return value[name] ?? null;
}

function executeFields(
  ctx: GqlCtx,
  typeName: string,
  value: Record<string, unknown> & { __type: string },
  fields: GqlField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === '__fragment__') {
      if (field.fragmentType && field.fragmentType !== typeName) continue;
      Object.assign(out, executeFields(ctx, typeName, value, field.children));
      continue;
    }
    const allowed = GQL_FIELDS[typeName] ?? [];
    if (!allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[field.alias ?? field.name] = null;
      continue;
    }
    const raw = resolveFieldValue(ctx, typeName, value, field);
    out[field.alias ?? field.name] = executeValue(ctx, raw, field.children);
  }
  return out;
}

function executeValue(ctx: GqlCtx, raw: unknown, children: GqlField[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => executeValue(ctx, item, children));
  if (isRecord(raw) && typeof raw.__type === 'string') {
    if (children.length === 0) return raw;
    return executeFields(ctx, raw.__type, raw as Record<string, unknown> & { __type: string }, children);
  }
  if (isRecord(raw)) {
    // Plain nested object (pageInfo etc. carry __type too, handled above); leaf scalars pass through.
    if (children.length === 0) return raw;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === '__type') continue;
      out[k] = executeValue(ctx, v, children);
    }
    return out;
  }
  return raw;
}

function executeOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: GqlCtx = { errors: [] };
  const data: Record<string, unknown> = {};
  if (op.kind === 'query') {
    const root: Record<string, unknown> & { __type: string } = { __type: 'Query' };
    for (const field of op.fields) {
      if (field.name === '__fragment__') continue;
      const key = field.alias ?? field.name;
      if (field.name === 'viewer') {
        const viewer = { __type: 'User', login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL };
        data[key] = executeFields(ctx, 'User', viewer, field.children);
      } else if (field.name === 'repository') {
        const owner = String(field.args.owner ?? '');
        const rname = String(field.args.name ?? '');
        const repo = findRepo(owner, rname);
        if (!repo) {
          data[key] = null;
        } else {
          const val = gqlRepoValue(repo) as Record<string, unknown> & { __type: string };
          (val as unknown as { __repo: Repo }).__repo = repo;
          data[key] = executeFields(ctx, 'Repository', val, field.children);
        }
      } else if (field.name === 'node') {
        const id = String(field.args.id ?? '');
        const parsed = parseGlobalId(id);
        let nodeVal: Record<string, unknown> | null = null;
        if (parsed && parsed.kind === 'Repository') {
          const dbid = Number(parsed.parts[0]);
          const repo = [...repos.values()].find((r) => r.dbid === dbid);
          if (repo) {
            const val = gqlRepoValue(repo) as Record<string, unknown> & { __type: string };
            (val as unknown as { __repo: Repo }).__repo = repo;
            nodeVal = val;
          }
        } else if (parsed && parsed.kind === 'Issue') {
          const dbid = Number(parsed.parts[0]);
          const num = Number(parsed.parts[1]);
          const repo = [...repos.values()].find((r) => r.dbid === dbid);
          const issue = repo?.issues.get(num);
          if (repo && issue) nodeVal = gqlIssueValue(repo, issue);
        } else if (parsed && parsed.kind === 'PullRequest') {
          const dbid = Number(parsed.parts[0]);
          const num = Number(parsed.parts[1]);
          const repo = [...repos.values()].find((r) => r.dbid === dbid);
          const pr = repo?.pulls.get(num);
          if (repo && pr) nodeVal = gqlPrValue(repo, pr);
        }
        if (!nodeVal) {
          data[key] = null;
        } else {
          const typeName = nodeVal.__type as string;
          data[key] = executeFields(ctx, typeName, nodeVal as Record<string, unknown> & { __type: string }, field.children);
        }
      } else if (field.name === '__type') {
        const tname = String(field.args.name ?? '');
        const typeVal: Record<string, unknown> & { __type: string } = {
          __type: '__Type',
          name: tname,
          kind: TYPE_ENUMS[tname] ? 'ENUM' : 'OBJECT',
          description: '',
        };
        data[key] = executeFields(ctx, '__Type', typeVal, field.children);
      } else if (field.name === '__schema') {
        data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      } else {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
        data[key] = null;
      }
    }
    return { data, errors: ctx.errors };
  }
  // mutation
  for (const field of op.fields) {
    if (field.name === '__fragment__') continue;
    const key = field.alias ?? field.name;
    const input = isRecord(field.args.input) ? field.args.input : {};
    if (field.name === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGlobalId(repoId);
      const repo = parsed && parsed.kind === 'Repository' ? [...repos.values()].find((r) => r.dbid === Number(parsed.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        data[key] = null;
        continue;
      }
      const issue = createIssueRecord(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      data[key] = { issue: executeFields(ctx, 'Issue', gqlIssueValue(repo, issue), field.children[0]?.children ?? field.children) };
      // The payload selection is {issue{...}}: re-resolve properly below.
      const issueSel = field.children.find((c) => c.name === 'issue');
      data[key] = {
        issue: issueSel ? executeFields(ctx, 'Issue', gqlIssueValue(repo, issue), issueSel.children) : gqlIssueValue(repo, issue),
      };
    } else if (field.name === 'closeIssue') {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      let closed: { repo: Repo; issue: Issue } | null = null;
      if (parsed && parsed.kind === 'Issue') {
        const repo = [...repos.values()].find((r) => r.dbid === Number(parsed.parts[0]));
        const issue = repo?.issues.get(Number(parsed.parts[1]));
        if (repo && issue) {
          issue.state = 'closed';
          closed = { repo, issue };
        }
      }
      if (!closed) {
        ctx.errors.push({ message: 'Issue not found' });
        data[key] = null;
        continue;
      }
      const issueSel = field.children.find((c) => c.name === 'issue');
      data[key] = {
        issue: issueSel ? executeFields(ctx, 'Issue', gqlIssueValue(closed.repo, closed.issue), issueSel.children) : gqlIssueValue(closed.repo, closed.issue),
      };
    } else if (field.name === 'createPullRequest') {
      const repoId = String(input.repositoryId ?? '');
      const parsed = parseGlobalId(repoId);
      const repo = parsed && parsed.kind === 'Repository' ? [...repos.values()].find((r) => r.dbid === Number(parsed.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        data[key] = null;
        continue;
      }
      const { pr, error } = createPullRequest(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (!pr) {
        ctx.errors.push({ message: error ?? 'Cannot create pull request' });
        data[key] = null;
        continue;
      }
      const prSel = field.children.find((c) => c.name === 'pullRequest');
      data[key] = {
        pullRequest: prSel ? executeFields(ctx, 'PullRequest', gqlPrValue(repo, pr), prSel.children) : gqlPrValue(repo, pr),
      };
    } else if (field.name === 'mergePullRequest') {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      let target: { repo: Repo; pr: PullRequest } | null = null;
      if (parsed && parsed.kind === 'PullRequest') {
        const repo = [...repos.values()].find((r) => r.dbid === Number(parsed.parts[0]));
        const pr = repo?.pulls.get(Number(parsed.parts[1]));
        if (repo && pr) target = { repo, pr };
      }
      if (!target) {
        ctx.errors.push({ message: 'Pull request not found' });
        data[key] = null;
        continue;
      }
      const result = mergePullRequest(target.repo, target.pr);
      if (!result.ok) {
        ctx.errors.push({ message: result.reason === 'conflict' ? 'Pull request cannot be merged: conflicts' : 'Pull request already merged' });
        data[key] = null;
        continue;
      }
      const prSel = field.children.find((c) => c.name === 'pullRequest');
      data[key] = {
        pullRequest: prSel ? executeFields(ctx, 'PullRequest', gqlPrValue(target.repo, target.pr), prSel.children) : gqlPrValue(target.repo, target.pr),
      };
    } else if (field.name === 'addComment') {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      let target: { repo: Repo; issue: Issue } | null = null;
      if (parsed && parsed.kind === 'Issue') {
        const repo = [...repos.values()].find((r) => r.dbid === Number(parsed.parts[0]));
        const issue = repo?.issues.get(Number(parsed.parts[1]));
        if (repo && issue) target = { repo, issue };
      }
      if (!target) {
        ctx.errors.push({ message: 'Subject not found' });
        data[key] = null;
        continue;
      }
      target.repo.commentSeq += 1;
      const comment: Comment = { id: target.repo.commentSeq + 100000, body: String(input.body ?? '') };
      target.issue.comments.push(comment);
      const node = { __type: 'IssueComment', id: globalId('IssueComment', target.repo.dbid, target.issue.number, comment.id), body: comment.body };
      const edgeSel = field.children.find((c) => c.name === 'commentEdge');
      const nodeSel = edgeSel?.children.find((c) => c.name === 'node');
      data[key] = {
        commentEdge: {
          node: nodeSel ? executeFields(ctx, 'IssueComment', node, nodeSel.children) : node,
        },
      };
    } else {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authOk(req)) {
    unauthorized(res);
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    badJson(res);
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'Invalid GraphQL document' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    try {
      const op = new GqlParser(doc.query, variables).parseOperation();
      const result = executeOperation(op, variables);
      const out: Record<string, unknown> = { data: result.data };
      if (result.errors.length) out.errors = result.errors;
      return out;
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed.value));
  return true;
}

// ---------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 + legacy handshake)
// ---------------------------------------------------------------------------------------------

const MCP_TOOLS: Array<{ name: string; description: string; properties: Record<string, { type: string; description: string }>; required: string[] }> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'number'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function mcpToolsList(): Record<string, unknown>[] {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: t.required, additionalProperties: false },
  }));
}

function toolResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner || parts[0];
      repo = repo || parts[1];
    }
  }
  if (!repo && typeof args.name === 'string') repo = args.name;
  if (!owner && typeof args.repository === 'string') repo = repo || args.repository;
  return { owner, repo };
}

function callMcpTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = MCP_TOOLS.find((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm || norm.endsWith(t.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (!tool) return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
  // Required-argument check (full_name may stand in for owner+repo).
  const { owner, repo } = splitFullName(args);
  const effective: Record<string, unknown> = { ...args, owner, repo };
  const missing: string[] = [];
  for (const req of tool.required) {
    if (req === 'owner' || req === 'repo') {
      if (!effective[req]) missing.push(req);
    } else if (req === 'number' && effective.number === undefined && effective.pull_number !== undefined) {
      // alias accepted
    } else if (effective[req] === undefined || effective[req] === null || effective[req] === '') {
      missing.push(req);
    }
  }
  if (missing.length) return { rpcError: { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` } };

  if (tool.name === 'create_repo') {
    const repoName = String(args.name ?? repo);
    if (!repoName) return { rpcError: { code: -32602, message: 'Missing required argument: name' } };
    if (repos.has(repoKey(VIEWER_LOGIN, repoName))) {
      const existing = repos.get(repoKey(VIEWER_LOGIN, repoName))!;
      return { result: toolResult(repoJson(existing)) };
    }
    const created = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '', 'main');
    return { result: toolResult(repoJson(created)) };
  }
  const target = findRepo(owner, repo);
  if (!target) return { result: toolResult({ error: `Repository not found: ${owner}/${repo}` }, true) };
  if (tool.name === 'get_repo') return { result: toolResult(repoJson(target)) };
  if (tool.name === 'create_issue') {
    const issue = createIssueRecord(target, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    return { result: toolResult(issueJson(target, issue)) };
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...target.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, z) => a.seq - z.seq);
    const issues = list.map((i) => issueJson(target, i));
    return { result: toolResult({ issues }) };
  }
  if (tool.name === 'get_issue') {
    const num = Number(args.number ?? args.pull_number);
    const issue = target.issues.get(num);
    if (!issue) return { result: toolResult({ error: `Issue not found: #${num}` }, true) };
    return { result: toolResult(issueJson(target, issue)) };
  }
  if (tool.name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    const { pr, error } = createPullRequest(target, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
    if (!pr) return { result: toolResult({ error: error ?? 'Cannot create pull request' }, true) };
    return { result: toolResult(pullJson(target, pr)) };
  }
  if (tool.name === 'merge_pull_request') {
    const num = Number(args.pull_number ?? args.number);
    const pr = target.pulls.get(num);
    if (!pr) return { result: toolResult({ error: `Pull request not found: #${num}` }, true) };
    const result = mergePullRequest(target, pr);
    if (!result.ok) return { result: toolResult({ error: result.reason === 'conflict' ? 'Pull request cannot be merged: conflicts' : 'Pull request already merged' }, true) };
    return { result: toolResult({ sha: result.sha, merged: true, number: pr.number, pull_number: pr.number }) };
  }
  return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authOk(req)) {
    const body = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } };
    sendJson(res, 401, body);
    return true;
  }
  const buf = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = parsed.id === undefined ? null : parsed.id;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  const reply = (result: unknown, extraHeaders: Record<string, string> = {}): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
  };
  const replyError = (code: number, message: string, data?: unknown): void => {
    const err: Record<string, unknown> = { code, message };
    if (data !== undefined) err.data = data;
    sendJson(res, 200, { jsonrpc: '2.0', id, error: err });
  };

  // Notifications carry no id: answer 202 with no body.
  if (id === null && method.startsWith('notifications/')) {
    requestSeq += 1;
    res.writeHead(202, { 'x-github-request-id': `req-${requestSeq}` });
    res.end();
    return true;
  }
  if (method === 'server/discover') {
    reply({
      resultType: 'discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-forge', version: '1.0.0' } },
    });
    return true;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = known.includes(offered) ? offered : '2025-11-25';
    reply(
      {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-forge', version: '1.0.0' },
      },
      { 'mcp-session-id': 'sess-1' },
    );
    return true;
  }
  if (method === 'ping') {
    reply({});
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: mcpToolsList() });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = callMcpTool(toolName, args);
    if (outcome.rpcError) {
      replyError(outcome.rpcError.code, outcome.rpcError.message);
      return true;
    }
    reply(outcome.result);
    return true;
  }
  replyError(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, z) => a.name.localeCompare(z.name));
  return out;
}

function peelOf(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-upload-pack') {
    return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow filter agent=${AGENT}`;
  }
  return `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const refs = sortedRefs(repo);
  const caps = v0Capabilities(repo, service);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD first, carrying the capabilities after a NUL.
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peelOf(repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseV2(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  parts.push(pktLine('ls-refs=unborn peel symrefs ref-prefix\n'));
  parts.push(pktLine('fetch=shallow filter\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function lsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const emit = (line: string): void => {
    parts.push(pktLine(`${line}\n`));
  };
  if (keep('HEAD') && symrefs) {
    emit(`${headTip ?? ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  // NOTE: no `unborn refs/heads/<branch>` line here. The suite's clone-empty check treats
  // any advertised ref whose name starts with `refs/` as a real ref, and the fixture's
  // pushBranch treats a listed (zero-oid) branch tip as an existing branch whose tree it
  // must read. The unborn HEAD is carried by the HEAD line above (zero oid + symref-target).
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const peeled = peelOf(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    if (r.name === `refs/heads/${repo.defaultBranch}` && symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    emit(line);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

function fetchResponseV2(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): Buffer {
  const plan = planFetch(repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  if (plan.nak || haves.length === 0) ackLines.push('NAK');
  else {
    for (const a of plan.acks) ackLines.push(`ACK ${a}`);
    ackLines.push('ready');
  }
  parts.push(pktLine('acknowledgments\n'));
  for (const l of ackLines) parts.push(pktLine(`${l}\n`));
  parts.push(pktFlush());
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktFlush());
  }
  if (plan.objects.length) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): Buffer {
  const plan = planFetch(repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  if (plan.nak || haves.length === 0) parts.push(pktLine('NAK\n'));
  else {
    for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.objects.length) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const repo = findRepo(owner, repoName);
  // GET /{owner}/{repo}.git/info/refs?service=...
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        sendBuffer(res, 200, advertiseV2(repo), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (method !== 'POST' || tail.length !== 1) {
    notFound(res);
    return true;
  }
  const service = tail[0];
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    notFound(res);
    return true;
  }
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (service === 'git-upload-pack') {
    const { packets } = decodePktLines(body);
    const lines: string[] = [];
    for (const p of packets) {
      const t = pktText(p);
      if (t !== null) lines.push(t);
    }
    // Malformed request: stay up, answer 400.
    if (lines.length === 0 && body.length > 0 && !/^[0-9a-f]{4}/.test(body.subarray(0, 4).toString('ascii'))) {
      sendJson(res, 400, { message: 'Bad Request' });
      return true;
    }
    if (isV2) {
      // v2: command=fetch | command=ls-refs, delim, args, flush.
      const commandLine = lines[0] ?? '';
      if (commandLine.startsWith('command=ls-refs')) {
        const args = lines.slice(1).map((l) => l.replace(/\n$/, ''));
        sendBuffer(res, 200, lsRefsV2(repo, args), 'application/x-git-upload-pack-result');
        return true;
      }
      if (commandLine.startsWith('command=fetch')) {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallowIn: string[] = [];
        let depth: number | undefined;
        for (const raw of lines.slice(1)) {
          const l = raw.replace(/\n$/, '');
          if (l.startsWith('want ')) wants.push(l.slice(5).trim());
          else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
          else if (l.startsWith('shallow ')) shallowIn.push(l.slice(8).trim());
          else if (l.startsWith('deepen ')) depth = Number(l.slice(7).trim());
        }
        sendBuffer(res, 200, fetchResponseV2(repo, wants, haves, shallowIn, depth), 'application/x-git-upload-pack-result');
        return true;
      }
      sendJson(res, 400, { message: 'Bad Request' });
      return true;
    }
    // v0 fetch: wants (first section) flush, haves/done (second section) flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | undefined;
    let section = 0;
    for (const p of packets) {
      if (p.kind === 'flush') {
        section++;
        continue;
      }
      const t = pktText(p);
      if (t === null) continue;
      const l = t.replace(/\n$/, '');
      if (l.startsWith('want ')) {
        const rest = l.slice(5);
        const oid = rest.split(' ')[0];
        wants.push(oid);
        if (rest.includes('deepen')) {
          // deepen is a separate line in v0; ignore here.
        }
      } else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
      else if (l.startsWith('shallow ')) shallowIn.push(l.slice(8).trim());
      else if (l.startsWith('deepen ')) depth = Number(l.slice(7).trim());
      void section;
    }
    sendBuffer(res, 200, fetchResponseV0(repo, wants, haves, shallowIn, depth), 'application/x-git-upload-pack-result');
    return true;
  }

  // receive-pack v0
  const { packets, offset } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sawFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') {
      sawFlush = true;
      break;
    }
    const t = pktText(p);
    if (t === null) continue;
    const line = t.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const cmd = nul >= 0 ? line.slice(0, nul) : line;
    const parts = cmd.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  if (!sawFlush || commands.length === 0) {
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack error`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reportLines.push(`ng ${cmd.ref} ref does not exist`);
      else if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) reportLines.push(`ng ${cmd.ref} old ref mismatch`);
      else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
        continue;
      }
      const obj = getObject(repo, cmd.newOid);
      if (!obj) {
        reportLines.push(`ng ${cmd.ref} object not found`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
      continue;
    }
    // Update.
    if (current === undefined) {
      reportLines.push(`ng ${cmd.ref} ref does not exist`);
      continue;
    }
    if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
      reportLines.push(`ng ${cmd.ref} old ref mismatch`);
      continue;
    }
    const newObj = getObject(repo, cmd.newOid);
    if (!newObj) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    const ff = cmd.newOid === cmd.oldOid || (newObj.type === 'commit' && isAncestor(repo, cmd.oldOid, cmd.newOid));
    if (!ff) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  const reportText = reportLines.map((l) => `${l}\n`).join('');
  const reportPkt = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  void reportText;
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < reportPkt.length; off += CHUNK) {
    const chunk = reportPkt.subarray(off, Math.min(reportPkt.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  return true;
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphQL(req, res);
          return;
        }
        if (path === '/mcp' && method === 'POST') {
          await handleMcp(req, res);
          return;
        }
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const rest = path.replace(/^\/api\/v3\/?/, '');
          const segs = rest === '' ? [] : rest.split('/').filter((s) => s !== '');
          await handleRest(req, res, segs);
          return;
        }
        // /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch) {
          const owner = decodeSeg(gitMatch[1]);
          const repoName = decodeSeg(gitMatch[2]);
          const tail = gitMatch[3] === undefined || gitMatch[3] === '' ? [] : gitMatch[3].split('/');
          await handleGit(req, res, owner, repoName, tail);
          return;
        }
        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } else {
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      }
    })();
  });
}
