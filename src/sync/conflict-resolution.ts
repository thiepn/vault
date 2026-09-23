export type MarkdownBlockKind =
  | 'frontmatter' | 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table' | 'thematic' | 'blank';

export interface MarkdownBlock {
  kind:MarkdownBlockKind;
  raw:string;
  label:string;
}

export interface ConflictEdit {
  start:number;
  end:number;
  replacement:MarkdownBlock[];
}

export type ConflictChoice='local'|'remote'|'base'|'both-local-remote'|'both-remote-local';

export interface ConflictPlanSegment {
  id:string;
  kind:'unchanged'|'auto-local'|'auto-remote'|'auto-identical'|'conflict';
  label:string;
  base:string;
  local:string;
  remote:string;
}

export interface MarkdownConflictPlan {
  segments:ConflictPlanSegment[];
  conflictIds:string[];
  autoMergedText:string|null;
  degraded:boolean;
}

const MAX_LCS_BLOCKS=450;

function linesWithEndings(text:string):string[]{
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}
function blank(line:string):boolean{return /^\s*$/u.test(line.replace(/\n$/u,''));}
function fence(line:string):{mark:string;length:number}|null{
  const match=line.match(/^\s*(`{3,}|~{3,})/u);
  return match ? {mark:match[1]![0]!,length:match[1]!.length} : null;
}
function heading(line:string):boolean{return /^s{0,3}#{1,6}s+/u.test(line);}
function listLine(line:string):boolean{return /^s*(?:[-+*]|d+[.)])s+/u.test(line);}
function quoteLine(line:string):boolean{return /^s*>/u.test(line);}
function thematic(line:string):boolean{return /^s{0,3}(?:(?:*s*){3,}|(?:-s*){3,}|(?:_s*){3,})s*$/u.test(line.replace(/
$/u,''));}
function tableSeparator(line:string):boolean{
  const value=line.replace(/
$/u,'').trim();
  return /^|?s*:?-{3,}:?s*(?:|s*:?-{3,}:?s*)+|?$/u.test(value);
}
function tableLine(line:string):boolean{return line.includes('|') && !blank(line);}

function firstContent(raw:string):string{
  const line=raw.split('
').find(value=>value.trim())?.trim() ?? '';
  return line.length>72 ? line.slice(0,69)+'…' : line;
}
function blockLabel(kind:MarkdownBlockKind,raw:string):string{
  const first=firstContent(raw);
  if(kind==='frontmatter') return 'YAML frontmatter';
  if(kind==='code') return first || 'Fenced code';
  if(kind==='table') return first || 'Markdown table';
  if(kind==='list') return first || 'List';
  if(kind==='quote') return first || 'Blockquote';
  if(kind==='heading') return first || 'Heading';
  if(kind==='thematic') return 'Thematic break';
  if(kind==='blank') return 'Spacing';
  return first || 'Paragraph';
}

function consumeTrailingBlanks(lines:string[],index:number):number{
  while(index<lines.length && blank(lines[index]!)) index++;
  return index;
}

export function splitMarkdownBlocks(text:string):MarkdownBlock[]{
  const lines=linesWithEndings(text);
  const result:MarkdownBlock[]=[];
  let i=0;
  while(i<lines.length){
    const start=i;
    let kind:MarkdownBlockKind='paragraph';

    if(i===0 && /^---s*(?:
)?$/u.test(lines[i]!)){
      kind='frontmatter';
      i++;
      while(i<lines.length){
        const value=lines[i]!;
        i++;
        if(/^(?:---|...)s*(?:
)?$/u.test(value)) break;
      }
      i=consumeTrailingBlanks(lines,i);
    }else if(blank(lines[i]!)){
      kind='blank';
      i=consumeTrailingBlanks(lines,i);
    }else{
      const opening=fence(lines[i]!);
      if(opening){
        kind='code';
        i++;
        const escapedMark=opening.mark.replace(/[.*+?^${}()|[]\]/gu,'\$&');
        const closing=new RegExp('^\s*'+escapedMark+'{'+opening.length+',}\s*(?:\n)?$','u');
        while(i<lines.length){
          const value=lines[i]!;
          i++;
          if(closing.test(value)) break;
        }
        i=consumeTrailingBlanks(lines,i);
      }else if(heading(lines[i]!)){
        kind='heading';
        i=consumeTrailingBlanks(lines,i+1);
      }else if(thematic(lines[i]!)){
        kind='thematic';
        i=consumeTrailingBlanks(lines,i+1);
      }else if(listLine(lines[i]!)){
        kind='list';
        i++;
        while(i<lines.length && !blank(lines[i]!)){
          if(heading(lines[i]!) || fence(lines[i]!) || thematic(lines[i]!)) break;
          i++;
        }
        i=consumeTrailingBlanks(lines,i);
      }else if(quoteLine(lines[i]!)){
        kind='quote';
        i++;
        while(i<lines.length && (quoteLine(lines[i]!) || blank(lines[i]!))) i++;
      }else if(i+1<lines.length && tableLine(lines[i]!) && tableSeparator(lines[i+1]!)){
        kind='table';
        i+=2;
        while(i<lines.length && tableLine(lines[i]!)) i++;
        i=consumeTrailingBlanks(lines,i);
      }else{
        kind='paragraph';
        i++;
        while(i<lines.length && !blank(lines[i]!)){
          if(heading(lines[i]!) || fence(lines[i]!) || thematic(lines[i]!) || listLine(lines[i]!) || quoteLine(lines[i]!)) break;
          i++;
        }
        i=consumeTrailingBlanks(lines,i);
      }
    }
    const raw=lines.slice(start,i).join('');
    result.push({kind,raw,label:blockLabel(kind,raw)});
  }
  return result;
}

function fallbackEdit(base:readonly MarkdownBlock[],changed:readonly MarkdownBlock[]):ConflictEdit[]{
  let prefix=0;
  while(prefix<base.length && prefix<changed.length && base[prefix]!.raw===changed[prefix]!.raw) prefix++;
  let suffix=0;
  while(
    suffix<base.length-prefix && suffix<changed.length-prefix
    && base[base.length-1-suffix]!.raw===changed[changed.length-1-suffix]!.raw
  ) suffix++;
  if(prefix===base.length && prefix===changed.length) return [];
  return [{start:prefix,end:base.length-suffix,replacement:changed.slice(prefix,changed.length-suffix)}];
}

export function diffMarkdownBlocks(base:readonly MarkdownBlock[],changed:readonly MarkdownBlock[]):ConflictEdit[]{
  if(base.length>MAX_LCS_BLOCKS || changed.length>MAX_LCS_BLOCKS) return fallbackEdit(base,changed);
  const n=base.length,m=changed.length;
  const dp=Array.from({length:n+1},()=>new Uint16Array(m+1));
  for(let i=n-1;i>=0;i--){
    for(let j=m-1;j>=0;j--){
      dp[i]![j]=base[i]!.raw===changed[j]!.raw
        ? (dp[i+1]![j+1]!+1)
        : Math.max(dp[i+1]![j]!,dp[i]![j+1]!);
    }
  }
  const matches:{base:number;changed:number}[]=[];
  let i=0,j=0;
  while(i<n && j<m){
    if(base[i]!.raw===changed[j]!.raw){matches.push({base:i,changed:j});i++;j++;continue;}
    if(dp[i+1]![j]!>=dp[i]![j+1]!) i++; else j++;
  }
  matches.push({base:n,changed:m});
  const edits:ConflictEdit[]=[];
  let baseCursor=0,changedCursor=0;
  for(const match of matches){
    if(match.base>baseCursor || match.changed>changedCursor){
      edits.push({
        start:baseCursor,
        end:match.base,
        replacement:changed.slice(changedCursor,match.changed),
      });
    }
    baseCursor=match.base+1;
    changedCursor=match.changed+1;
  }
  return edits;
}

function overlaps(a:ConflictEdit,b:ConflictEdit):boolean{
  const ai=a.start===a.end,bi=b.start===b.end;
  if(ai&&bi) return a.start===b.start;
  if(ai) return a.start>=b.start && a.start<=b.end;
  if(bi) return b.start>=a.start && b.start<=a.end;
  return a.start<b.end && b.start<a.end;
}

interface TaggedEdit extends ConflictEdit {side:'local'|'remote';index:number}
interface EditGroup {start:number;end:number;edits:TaggedEdit[]}

function editGroups(local:ConflictEdit[],remote:ConflictEdit[]):EditGroup[]{
  const pending:TaggedEdit[]=[
    ...local.map((edit,index)=>({...edit,side:'local' as const,index})),
    ...remote.map((edit,index)=>({...edit,side:'remote' as const,index})),
  ].sort((a,b)=>a.start-b.start||a.end-b.end||a.side.localeCompare(b.side));
  const groups:EditGroup[]=[];
  for(const edit of pending){
    let target=groups.find(group=>group.edits.some(existing=>overlaps(existing,edit)));
    if(!target){
      target={start:edit.start,end:edit.end,edits:[]};
      groups.push(target);
    }
    target.edits.push(edit);
    target.start=Math.min(target.start,edit.start);
    target.end=Math.max(target.end,edit.end);

    for(let index=groups.length-1;index>=0;index--){
      const other=groups[index]!;
      if(other===target) continue;
      if(other.edits.some(left=>target!.edits.some(right=>overlaps(left,right)))){
        target.edits.push(...other.edits);
        target.start=Math.min(target.start,other.start);
        target.end=Math.max(target.end,other.end);
        groups.splice(index,1);
      }
    }
  }
  return groups.sort((a,b)=>a.start-b.start||a.end-b.end);
}

function variantForGroup(base:readonly MarkdownBlock[],group:EditGroup,side:'local'|'remote'):string{
  const region=base.slice(group.start,group.end).map(block=>block.raw);
  const edits=group.edits
    .filter(edit=>edit.side===side)
    .sort((a,b)=>b.start-a.start||b.end-a.end);
  for(const edit of edits){
    const at=edit.start-group.start;
    region.splice(at,edit.end-edit.start,...edit.replacement.map(block=>block.raw));
  }
  return region.join('');
}

function joinBlocks(blocks:readonly MarkdownBlock[],from:number,to:number):string{
  return blocks.slice(from,to).map(block=>block.raw).join('');
}
function segmentLabel(base:readonly MarkdownBlock[],group:EditGroup):string{
  const source=base.slice(group.start,Math.max(group.end,group.start+1));
  const label=source.find(block=>block.kind!=='blank')?.label;
  if(label) return label;
  const replacement=group.edits.flatMap(edit=>edit.replacement).find(block=>block.kind!=='blank');
  return replacement?.label ?? 'Inserted content';
}

export function buildMarkdownConflictPlan(baseText:string,localText:string,remoteText:string):MarkdownConflictPlan{
  if(localText===remoteText){
    return {
      segments:[{id:'segment-0',kind:'auto-identical',label:'Identical result',base:baseText,local:localText,remote:remoteText}],
      conflictIds:[],autoMergedText:localText,degraded:false,
    };
  }
  if(localText===baseText){
    return {
      segments:[{id:'segment-0',kind:'auto-remote',label:'Remote change',base:baseText,local:localText,remote:remoteText}],
      conflictIds:[],autoMergedText:remoteText,degraded:false,
    };
  }
  if(remoteText===baseText){
    return {
      segments:[{id:'segment-0',kind:'auto-local',label:'Local change',base:baseText,local:localText,remote:remoteText}],
      conflictIds:[],autoMergedText:localText,degraded:false,
    };
  }

  const base=splitMarkdownBlocks(baseText);
  const local=splitMarkdownBlocks(localText);
  const remote=splitMarkdownBlocks(remoteText);
  const degraded=base.length>MAX_LCS_BLOCKS || local.length>MAX_LCS_BLOCKS || remote.length>MAX_LCS_BLOCKS;
  const localEdits=diffMarkdownBlocks(base,local);
  const remoteEdits=diffMarkdownBlocks(base,remote);
  const groups=editGroups(localEdits,remoteEdits);

  const segments:ConflictPlanSegment[]=[];
  const conflicts:string[]=[];
  let cursor=0;
  let sequence=0;

  for(const group of groups){
    if(group.start>cursor){
      const raw=joinBlocks(base,cursor,group.start);
      segments.push({id:`segment-${sequence++}`,kind:'unchanged',label:'Unchanged',base:raw,local:raw,remote:raw});
    }
    const baseRaw=joinBlocks(base,group.start,group.end);
    const localChanges=group.edits.filter(edit=>edit.side==='local');
    const remoteChanges=group.edits.filter(edit=>edit.side==='remote');
    const localRaw=localChanges.length ? variantForGroup(base,group,'local') : baseRaw;
    const remoteRaw=remoteChanges.length ? variantForGroup(base,group,'remote') : baseRaw;
    let kind:ConflictPlanSegment['kind'];
    if(localChanges.length && remoteChanges.length){
      kind=localRaw===remoteRaw ? 'auto-identical' : 'conflict';
    }else kind=localChanges.length ? 'auto-local' : 'auto-remote';
    const id=`segment-${sequence++}`;
    segments.push({id,kind,label:segmentLabel(base,group),base:baseRaw,local:localRaw,remote:remoteRaw});
    if(kind==='conflict') conflicts.push(id);
    cursor=Math.max(cursor,group.end);
  }
  if(cursor<base.length){
    const raw=joinBlocks(base,cursor,base.length);
    segments.push({id:`segment-${sequence++}`,kind:'unchanged',label:'Unchanged',base:raw,local:raw,remote:raw});
  }

  const plan={segments,conflictIds:conflicts,autoMergedText:null as string|null,degraded};
  if(!conflicts.length) plan.autoMergedText=resolveMarkdownConflictPlan(plan,{});
  return plan;
}

function joinBoth(first:string,second:string):string{
  if(!first) return second;
  if(!second) return first;
  if(first.endsWith('
') || second.startsWith('
')) return first+second;
  return first+'
'+second;
}

export function resolveMarkdownConflictPlan(
  plan:MarkdownConflictPlan,
  choices:Readonly<Record<string,ConflictChoice>>,
):string{
  const output:string[]=[];
  for(const segment of plan.segments){
    if(segment.kind==='unchanged') output.push(segment.base);
    else if(segment.kind==='auto-local') output.push(segment.local);
    else if(segment.kind==='auto-remote') output.push(segment.remote);
    else if(segment.kind==='auto-identical') output.push(segment.local);
    else{
      const choice=choices[segment.id];
      if(!choice) throw new Error(`Conflict choice is missing for ${segment.id}.`);
      if(choice==='local') output.push(segment.local);
      else if(choice==='remote') output.push(segment.remote);
      else if(choice==='base') output.push(segment.base);
      else if(choice==='both-local-remote') output.push(joinBoth(segment.local,segment.remote));
      else output.push(joinBoth(segment.remote,segment.local));
    }
  }
  return output.join('');
}
