/** Reuse the existing pinned client embedder; never reprocess legacy history. */
import { createHash } from 'node:crypto'
import { bridgeEmbed } from './bridge.ts'
import type { MemoryApi, Runtime } from './runtime.ts'
export async function projectAcceptedMemory(api:MemoryApi,runtime:Runtime,record:{id:string;revision:number;content:string}):Promise<boolean>{
  if(runtime.mode!=='client-bridge')return false
  const embedded=await bridgeEmbed(runtime,record.content,'document')
  if(!embedded.ok||!embedded.vector)return false
  await api.post(`/memories/${record.id}/embedding`,{expectedRevision:record.revision,contentHash:createHash('sha256').update(record.content).digest('hex'),modelId:runtime.pin.modelId,dim:runtime.pin.dim,vector:embedded.vector})
  return true
}
export async function processPendingClientEmbeddings(api:MemoryApi,runtime:Runtime):Promise<number>{
  if(runtime.mode!=='client-bridge')return 0
  const pending=await api.get<{memories:Array<{id:string;revision:number;content:string}>}>('/memories/pending-embeddings',{limit:10})
  let completed=0
  for(const record of pending.memories){if(await projectAcceptedMemory(api,runtime,record))completed+=1;else break}
  return completed
}
export function startClientEmbeddingRetries(api:MemoryApi,runtime:Runtime):()=>void{
  if(runtime.mode!=='client-bridge')return()=>{}
  let stopped=false,delay=30000
  let timer:ReturnType<typeof setTimeout>|undefined
  const run=async()=>{
    try{await processPendingClientEmbeddings(api,runtime);delay=30000}catch{delay=Math.min(delay*2,900000)}
    if(!stopped){timer=setTimeout(()=>void run(),delay);timer.unref()}
  }
  timer=setTimeout(()=>void run(),1000);timer.unref()
  return()=>{stopped=true;if(timer)clearTimeout(timer)}
}
