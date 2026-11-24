// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type Hunk = { old: string[]; fresh: string[]; marks: ('ctx' | 'add' | 'del')[]; target: number; noNewline: boolean };
type UnifiedSection = { oldPath: string | null; newPath: string | null; hunks: Hunk[]; create: boolean; remove: boolean };

function fileParts(text: string): { lines: string[]; br: string; final: boolean } {
  const n = text.indexOf('\n');
  const br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
const lead = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0];
function occurrences(hay: string[], needle: string[], tier: number, from = 0, to = hay.length): number[] {
  const norm = (s: string): string => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
  if (needle.length === 0) return [];
  const o = needle.map(norm); const out: number[] = [];
  for (let i = Math.max(0, from); i + needle.length <= Math.min(hay.length, to); i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) if (norm(hay[i + j]!) !== o[j]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(hay: string[], old: string[], strict: boolean, from = 0, to = hay.length): { tier: number; at: number[] } | null {
  for (let t = 0; t <= (strict ? 0 : 2); t++) { const at = occurrences(hay, old, t, from, to); if (at.length) return { tier: t, at }; }
  return null;
}
function materialize(old: string[], fresh: string[], marks: ('ctx'|'add'|'del')[], at: number, tier: number): string[] {
  const out: string[] = []; let oi = 0;
  const p = old[0] === undefined ? '' : lead(old[0]!); const f = old[0] === undefined ? '' : lead(old[0]!);
  for (const m of marks) {
    if (m === 'del') { oi++; continue; }
    const value = fresh.shift()!;
    if (m === 'ctx') { out.push(value); oi++; }
    else if (tier === 2 && value.trim() !== '' && value.startsWith(p)) out.push(f + value.slice(p.length));
    else out.push(value);
  }
  return out;
}
function replaceLines(lines: string[], at: number, old: string[], fresh: string[]): string[] {
  return [...lines.slice(0, at), ...fresh, ...lines.slice(at + old.length)];
}
function mkLineEdit(path: string, old: string[], fresh: string[], strict: boolean, choose: 'unique'|'first', target = 0, endOnly = false, marks?: ('ctx'|'add'|'del')[], noNewline = false): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path); if (text === null) throw new Fail('missing', path);
    const part = fileParts(text);
    const found = findTier(part.lines, old, strict);
    if (!found) throw new Fail('no-match', path);
    let candidates = found.at;
    if (endOnly) candidates = candidates.filter(i => i + old.length === part.lines.length);
    if (candidates.length === 0) throw new Fail('no-match', path);
    if (choose === 'unique' && candidates.length !== 1) throw new Fail('ambiguous', path);
    const at = choose === 'first' ? candidates.reduce((a,b) => Math.abs(a-target) <= Math.abs(b-target) ? a : b) : candidates[0]!;
    let result = fresh;
    if (marks) {
      result = []; let oi = 0, ni = 0; const p = old[0] === undefined ? '' : lead(old[0]!); const f = old[0] === undefined ? '' : lead(part.lines[at]!);
      for (const m of marks) {
        if (m === 'del') { oi++; continue; }
        const v = fresh[ni++]!;
        if (m === 'ctx') { result.push(part.lines[at + oi]!); oi++; }
        else if (found.tier === 2 && v.trim() !== '' && v.startsWith(p)) result.push(f + v.slice(p.length));
        else result.push(v);
      }
    } else if (found.tier === 2 && old.length) {
      const p = lead(old[0]!); const f = lead(part.lines[at]!);
      result = fresh.map(v => v.trim() !== '' && v.startsWith(p) ? f + v.slice(p.length) : v);
    }
    const next = replaceLines(part.lines, at, old, result);
    const touchesEnd = old.length ? at + old.length === part.lines.length : at === part.lines.length;
    const final = part.final;
    tree.now.set(path, next.length ? next.join(part.br) + (final ? part.br : '') : '');
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = []; let cur: UnifiedSection | null = null; let i = 0; let gitHeader = false;
  const unprefix = (p: string | null): string | null => p === null || p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
  const pathHeader = (l: string): string | null => unprefix(l.slice(4).split('\t')[0]!.trim());
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i+1}`);
      cur = { oldPath: unprefix('a/'+m[1]!), newPath: unprefix('b/'+m[2]!), hunks: [], create: false, remove: false }; sections.push(cur); gitHeader = true; i++; continue;
    }
    if (l.startsWith('--- ') && (lines[i+1] ?? '').startsWith('+++ ')) {
      if (cur && gitHeader && cur.hunks.length === 0) {
        cur.oldPath = pathHeader(l); cur.newPath = pathHeader(lines[i+1]!); gitHeader = false; i += 2; continue;
      }
      cur = { oldPath: pathHeader(l), newPath: pathHeader(lines[i+1]!), hunks: [], create: false, remove: false }; sections.push(cur); gitHeader = false; i += 2; continue;
    }
    if (cur && cur.hunks.length === 0 && gitHeader) {
      if (l.startsWith('new file mode ')) cur.create = true;
      if (l.startsWith('deleted file mode ')) cur.remove = true;
      if (l.startsWith('rename from ')) cur.oldPath = unprefix(l.slice(12).trim());
      if (l.startsWith('rename to ')) cur.newPath = unprefix(l.slice(10).trim());
      if (l.startsWith('--- ') && !(lines[i+1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i+2}`);
    }
    if (l.startsWith('--- ') && !(lines[i+1] ?? '').startsWith('+++ ') && cur === null) { i++; continue; }
    if (l.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i+1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i+1}`);
      const old: string[] = [], fresh: string[] = [], marks: ('ctx'|'add'|'del')[] = []; let noNewline = false; const start = i+1; i++;
      const body: string[] = [];
      while (i < lines.length) {
        const x = lines[i]!;
        if (x.startsWith('diff --git ') || (x.startsWith('--- ') && (lines[i+1] ?? '').startsWith('+++ '))) break;
        if (x.startsWith('@@')) break;
        if (x === '' || /^[ +\-\\]/.test(x)) { body.push(x); i++; continue; }
        break;
      }
      while (body.length && body[body.length-1] === '') body.pop();
      for (let b=0;b<body.length;b++) {
        const x=body[b]!;
        if (x.startsWith('\\')) { if (b === body.length-1) noNewline = true; continue; }
        if (x === '') { old.push(''); fresh.push(''); marks.push('ctx'); }
        else if (x[0] === ' ') { old.push(x.slice(1)); fresh.push(x.slice(1)); marks.push('ctx'); }
        else if (x[0] === '-') { old.push(x.slice(1)); marks.push('del'); }
        else if (x[0] === '+') { fresh.push(x.slice(1)); marks.push('add'); }
      }
      cur.hunks.push({ old, fresh, marks, target: Number(m[1]) - 1, noNewline });
      if (i === start) i++;
      continue;
    }
    i++;
  }
  if (!sections.length) throw new Exit2('error: parse 1');
  return sections.map(s => (tree) => {
    const oldp = s.oldPath, newp = s.newPath;
    const create = s.create || oldp === null; const remove = s.remove || newp === null;
    const source = create ? null : oldp; const dest = remove ? null : newp;
    for (const p of [source,dest]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    if (create) {
      if (dest === null) throw new Fail('no-match', String(newp));
      if (tree.get(dest) !== null) throw new Fail('exists', dest);
      let linesOut = s.hunks.flatMap(h => h.fresh);
      let final = true; const last = s.hunks.at(-1); if (last?.noNewline) final = false;
      tree.now.set(dest, linesOut.length ? linesOut.join('\n') + (final ? '\n' : '') : ''); return;
    }
    if (source === null) throw new Fail('missing', String(source));
    const before = tree.get(source); if (before === null) throw new Fail('missing', source);
    if (remove) { tree.now.set(source, null); return; }
    if (dest === null) throw new Fail('missing', source);
    const moving = source !== dest;
    if (moving && tree.get(dest) !== null) throw new Fail('exists', dest);
    let text = before; let d = 0;
    for (const h of s.hunks) {
      const part = fileParts(text); const found = h.old.length ? findTier(part.lines, h.old, strict) : { tier: 0, at: [] as number[] };
      if (!found) throw new Fail('no-match', source);
      let at: number;
      if (!h.old.length) at = Math.max(0, Math.min(h.target + d + 1, part.lines.length));
      else { const target = h.target + d; at = found.at.reduce((a,b)=>Math.abs(a-target)<=Math.abs(b-target)?a:b); }
      const fresh = h.fresh.slice(); let result: string[]; let oi=0, ni=0; const p=h.old[0]===undefined?'':lead(h.old[0]!); const f=h.old[0]===undefined?'':lead(part.lines[at] ?? '');
      result=[];
      for(const mark of h.marks){ if(mark==='del'){oi++;continue;} const v=fresh[ni++]!; if(mark==='ctx'){result.push(part.lines[at+oi]!);oi++;} else if(found.tier===2 && v.trim()!=='' && v.startsWith(p)) result.push(f+v.slice(p.length)); else result.push(v); }
      const next = replaceLines(part.lines, at, h.old, result);
      d += result.length - h.old.length;
      const touches = h.old.length ? at + h.old.length === part.lines.length : at === part.lines.length;
      const final = touches ? !h.noNewline : part.final;
      text = next.length ? next.join(part.br) + (final ? part.br : '') : '';
    }
    if (moving) { tree.now.set(source,null); tree.now.set(dest,text); tree.moves.set(source,dest); }
    else tree.now.set(source,text);
  });
}

function parseSearch(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[]=[]; let previous: string | null=null; let cursor=0; let previousEnd=0;
  while(cursor<lines.length){
    if(lines[cursor]!.trimEnd()!=='<<<<<<< SEARCH'){cursor++;continue;}
    const start=cursor; let sep=-1,end=-1;
    for(let j=cursor+1;j<lines.length;j++){ if(sep<0 && lines[j]!.trimEnd()==='=======') sep=j; else if(sep>=0 && lines[j]!.trimEnd()==='>>>>>>> REPLACE'){end=j;break;} }
    if(sep<0||end<0) throw new Exit2(`error: parse ${start+1}`);
    let path: string|null=null;
    for(let j=start-1;j>=previousEnd;j--){const x=lines[j]!.trim();if(x!==''&&!x.startsWith('```')){path=x;break;}}
    path ??= previous; if(path===null) throw new Exit2(`error: parse ${start+1}`); previous=path; previousEnd=end+1;
    const old=lines.slice(start+1,sep), fresh=lines.slice(sep+1,end);
    if(old.length===0) edits.push((tree)=>{if(!safe(path!))throw new Fail('unsafe',path!);if(tree.get(path!)!==null)throw new Fail('exists',path!);tree.now.set(path!,fresh.length?fresh.join('\n')+'\n':'');});
    else edits.push(mkLineEdit(path,old,fresh,strict,'unique'));
    cursor=end+1;
  }
  if(!edits.length) throw new Exit2('error: parse 1'); return edits;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first=lines.findIndex(x=>!blank(x)); if(first<0||lines[first]!.trim()!=='*** Begin Patch') throw new Exit2(`error: parse ${first<0?1:first+1}`);
  let last=lines.length-1;while(last>=0&&blank(lines[last]!))last--; if(last<0||lines[last]!.trim()!=='*** End Patch')throw new Exit2(`error: parse ${lines.length+1}`);
  const edits: Edit[]=[];let i=first+1;
  while(i<last){ if(blank(lines[i]!)){i++;continue;} const h=lines[i]!; const add=/^\*\*\* Add File: (.*)$/.exec(h),del=/^\*\*\* Delete File: (.*)$/.exec(h),upd=/^\*\*\* Update File: (.*)$/.exec(h);
    if(!add&&!del&&!upd)throw new Exit2(`error: parse ${i+1}`); const path=(add?.[1]??del?.[1]??upd?.[1]??'').trim(); const header=i++; const content:string[]=[];
    while(i<last&&!/^\*\*\* (?:Add File: |Delete File: |Update File: )/.test(lines[i]!)){content.push(lines[i]!);i++;}
    while(content.length&&blank(content[content.length-1]!))content.pop();
    if(add){const vals:string[]=[];for(let j=0;j<content.length;j++){const x=content[j]!;if(x==='' )vals.push('');else if(x.startsWith('+'))vals.push(x.slice(1));else throw new Exit2(`error: parse ${header+2+j}`);} edits.push((tree)=>{if(!safe(path))throw new Fail('unsafe',path);if(tree.get(path)!==null)throw new Fail('exists',path);tree.now.set(path,vals.length?vals.join('\n')+'\n':'');});continue;}
    if(del){if(content.length)throw new Exit2(`error: parse ${header+2}`);edits.push((tree)=>{if(!safe(path))throw new Fail('unsafe',path);if(tree.get(path)===null)throw new Fail('missing',path);tree.now.set(path,null);});continue;}
    let move:string|null=null;let chunks:{old:string[];fresh:string[];marks:('ctx'|'add'|'del')[];anchor:string|null;eof:boolean;line:number}[]=[];let c:{old:string[];fresh:string[];marks:('ctx'|'add'|'del')[];anchor:string|null;eof:boolean;line:number}|null=null;let saw=false;
    const finish=()=>{if(c){chunks.push(c);c=null;}};
    for(let j=0;j<content.length;j++){const x=content[j]!,lin=header+2+j;if(x.startsWith('*** Move to: ')){if(saw||move!==null)throw new Exit2(`error: parse ${lin}`);move=x.slice(13).trim();continue;}
      if(x.startsWith('@@')){finish();saw=true;const anchorText=x.slice(2).replace(/@@.*$/,'').trim();c={old:[],fresh:[],marks:[],anchor:anchorText||null,eof:false,line:lin};continue;}
      if(x==='*** End of File'){if(!c){c={old:[],fresh:[],marks:[],anchor:null,eof:true,line:lin};}else c.eof=true;saw=true;finish();continue;}
      if(!c){c={old:[],fresh:[],marks:[],anchor:null,eof:false,line:lin};saw=true;}
      if(x===''){c.old.push('');c.fresh.push('');c.marks.push('ctx');}
      else if(x[0]===' '){c.old.push(x.slice(1));c.fresh.push(x.slice(1));c.marks.push('ctx');}
      else if(x[0]==='-'){c.old.push(x.slice(1));c.marks.push('del');}
      else if(x[0]==='+'){c.fresh.push(x.slice(1));c.marks.push('add');}
      else throw new Exit2(`error: parse ${lin}`);
    }
    finish(); if(!chunks.length&&!move)throw new Exit2(`error: parse ${header+1}`);
    edits.push((tree)=>{if(!safe(path))throw new Fail('unsafe',path);if(move!==null&&!safe(move))throw new Fail('unsafe',move);const text=tree.get(path);if(text===null)throw new Fail('missing',path);if(move!==null&&tree.get(move)!==null)throw new Fail('exists',move);let part=fileParts(text), cursor=0;
      for(const ch of chunks){if(ch.anchor!==null){const f=findTier(part.lines,[ch.anchor],strict,cursor);if(!f)throw new Fail('no-match',path);cursor=f.at[0]!+1;}
        let found:{tier:number;at:number[]}|null;if(ch.old.length)found=findTier(part.lines,ch.old,strict,cursor);else found={tier:0,at:[Math.min(cursor,part.lines.length)]};
        if(!found)throw new Fail('no-match',path);let ats=found.at;if(ch.eof)ats=ats.filter(a=>a+ch.old.length===part.lines.length);if(!ats.length)throw new Fail('no-match',path);const at=ats[0]!;
        let out:string[]=[];let oi=0,ni=0;const p=ch.old[0]===undefined?'':lead(ch.old[0]!);const f=ch.old[0]===undefined?'':lead(part.lines[at]??'');for(const m of ch.marks){if(m==='del'){oi++;continue;}const v=ch.fresh[ni++]!;if(m==='ctx'){out.push(part.lines[at+oi]!);oi++;}else if(found.tier===2&&v.trim()!==''&&v.startsWith(p))out.push(f+v.slice(p.length));else out.push(v);}
        const next=replaceLines(part.lines,at,ch.old,out);cursor=at+out.length;part={...part,lines:next,final:part.final};
      }
      const result=part.lines.length?part.lines.join(part.br)+(part.final?part.br:''):'';if(move!==null){tree.now.set(path,null);tree.now.set(move,result);tree.moves.set(path,move);}else tree.now.set(path,result);
    });
  }
  if(!edits.length)throw new Exit2(`error: parse ${first+1}`);return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearch(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string; order: number }[] = [];
  const moved = new Set<string>();
  for (const [oldp, newp] of tree.moves) {
    if (tree.original(oldp) !== null && tree.original(newp) === null && tree.get(oldp) === null && tree.get(newp) !== null) {
      rows.push({ key: newp, text: `R ${oldp} -> ${newp}`, order: 0 }); moved.add(oldp); moved.add(newp);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, order: 1 });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, now] of tree.now) {
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...rows.map(r => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
