import { Problem, sha } from './contracts.mjs';
import { materialVisibleIn, visibleArtifact } from './materials.mjs';

export function versionScope(room,project) {
  if (!room) return null;
  return project ? sha(JSON.stringify(['project',project,room.original?.storage??null,room.original?.createdAt??null]))
    : sha(JSON.stringify(['conversation',room.id]));
}

const updatedFirst=(a,b)=>b.createdAt.localeCompare(a.createdAt);
const latestFirst=(a,b)=>b.version-a.version||updatedFirst(a,b);

function summarize(record,room,materials) {
  const visible=visibleArtifact(record,id=>{
    const file=materials.get(id);
    return materialVisibleIn(file,room.id) ? file : undefined;
  });
  return {id:record.id,conversation:record.conversation,roomTitle:room.title,kind:record.kind,
    botId:record.botId,botRevision:record.botRevision,version:record.version,createdAt:record.createdAt,
    run:record.run,title:visible?record.result.title:null};
}

export function libraryView(state,records) {
  const rooms=new Map(state.conversations.map(room=>[room.id,room]));
  const materials=new Map(state.materials.map(file=>[file.id,file]));
  const groups=new Map();
  const roomPrefixes=new Map(state.conversations.map(room=>[room.id.slice(0,8),room]));
  // Pick the most recent saved owner's label if a Workbench project was renamed.
  for (const record of [...records].sort(updatedFirst)) {
    const room=rooms.get(record.conversation);
    if(!room)continue;
    const key=versionScope(room,record.project);
    let group=groups.get(key);
    if(!group) {
      const storedTitle=room.projectTitle??room.title;
      const suffix=storedTitle.match(/ · ([a-f0-9]{8})$/);
      const creator=!room.original&&suffix?roomPrefixes.get(suffix[1]):null;
      const creatorTitle=(creator?.projectTitle||creator?.title)?.slice(0,100);
      const generated=creator?.project===record.project&&!creator?.original&&storedTitle===creatorTitle+suffix?.[0];
      group={id:key,kind:record.kind,title:record.project?(generated?creatorTitle:storedTitle):room.title,
        source:record.project?(room.original?'original':'workbench'):'conversation',versions:[]};
      groups.set(key,group);
    }
    group.versions.push(summarize(record,room,materials));
  }
  return [...groups.values()].map(group=>({...group,versions:group.versions.sort(latestFirst)}));
}

export function libraryMaterials(state,records,groupId) {
  const group=libraryView(state,records).find(item=>item.id===groupId);
  if (!group) throw new Problem(404,'当前工作区找不到此成果。','not_found');
  const version=group.versions.find(item=>item.title!==null);
  if (!version) return {version:null,files:[]};
  const record=records.find(item=>item.id===version.id);
  const materials=new Map(state.materials.filter(file=>materialVisibleIn(file,version.conversation)).map(file=>[file.id,file]));
  return {version,files:record.materialIds.map(id=>({id,name:materials.get(id).name}))};
}

export function relatedProjectVersions(state,records,room) {
  if(!room.project)return [];
  const key=versionScope(room,room.project);
  const rooms=new Map(state.conversations.map(item=>[item.id,item]));
  const materials=new Map(state.materials.map(file=>[file.id,file]));
  return records.filter(record=>record.conversation!==room.id&&record.project===room.project&&
    versionScope(rooms.get(record.conversation),record.project)===key)
    .map(record=>summarize(record,rooms.get(record.conversation),materials)).sort(latestFirst);
}

