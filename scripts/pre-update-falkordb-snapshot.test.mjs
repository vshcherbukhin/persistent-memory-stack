import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {archiveLegacyFalkorRdb,installationPresent} from './pre-update-snapshot.mjs'
const id='a'.repeat(64),config={containerName:'fixture-falkordb',volumeName:'fixture_falkordb_data',project:'fixture'}
const original={Id:id,Name:'/fixture-falkordb',Image:'sha256:'+'b'.repeat(64),Config:{Labels:{'com.docker.compose.service':'falkordb','com.docker.compose.project':'fixture'}},Mounts:[{Destination:'/data',Type:'volume',Name:'fixture_falkordb_data',RW:true}],State:{Running:true}}
function fixture(fn){
  const root=resolve(tmpdir()),path=mkdtempSync(join(root,'pm-graph-snapshot-'))
  try{return fn(path)}finally{assert.ok(resolve(path).startsWith(root+sep));rmSync(path,{recursive:true,force:true})}
}
function runner(dir='/var/lib/falkordb/data',save='OK',filename='dump.rdb',container=original){
  const calls=[]
  return {calls,run(_command,args){calls.push(args);if(args[0]==='inspect')return{status:0,stdout:JSON.stringify([container])};if(args.at(-1).includes('CONFIG GET dir'))return{status:0,stdout:`dir\n${dir}\ndbfilename\n${filename}\n`};if(args.at(-1).includes(' SAVE'))return{status:0,stdout:save};if(args[0]==='cp'){writeFileSync(args.at(-1),'synthetic atomic RDB');return{status:0,stdout:''}}throw new Error('Unexpected snapshot operation')}}
}
test('captures the actual atomic legacy RDB instead of trusting the empty old volume',()=>fixture(path=>{
  const mock=runner();archiveLegacyFalkorRdb(path,mock.run,config)
  assert.ok(mock.calls[2].at(-1).endsWith(' SAVE'))
  assert.equal(mock.calls[3][1],`${id}:/var/lib/falkordb/data/dump.rdb`)
  assert.equal(readFileSync(join(path,'falkordb-legacy-dump.rdb'),'utf8'),'synthetic atomic RDB')
  assert.equal(JSON.parse(readFileSync(join(path,'falkordb-storage.json'),'utf8')).sourceDirectory,'/var/lib/falkordb/data')
}))
test('does not duplicate a correctly mounted data directory',()=>fixture(path=>{const mock=runner('/data');archiveLegacyFalkorRdb(path,mock.run,config);assert.equal(mock.calls.length,2)}))
test('refuses unknown directories and failed saves before copying graph data',()=>fixture(path=>{
  for(const mock of [runner('/unknown'),runner('/var/lib/falkordb/data','ERR save failed')]){assert.throws(()=>archiveLegacyFalkorRdb(path,mock.run,config));assert.ok(!mock.calls.some(args=>args[0]==='cp'))}
}))

test('captures the configured RDB filename, never a stale default file',()=>fixture(path=>{const mock=runner('/var/lib/falkordb/data','OK','custom.rdb');archiveLegacyFalkorRdb(path,mock.run,config);assert.equal(mock.calls[3][1],`${id}:/var/lib/falkordb/data/custom.rdb`)}))
test('refuses stopped, foreign or uninspectable existing graph containers',()=>fixture(path=>{
  const mocks=[runner(undefined,undefined,undefined,{...original,State:{Running:false}}),runner(undefined,undefined,undefined,{...original,Name:'/other-falkordb'}),{calls:[],run(){return{status:1,stdout:'',stderr:'daemon unavailable'}}}]
  for(const mock of mocks)assert.throws(()=>archiveLegacyFalkorRdb(path,mock.run,config))
}))
test('skips only confirmed absence',()=>fixture(path=>{archiveLegacyFalkorRdb(path,()=>({status:1,stdout:'',stderr:'No such container: fixture-falkordb'}),config)}))

test('configured-only installation is detected before snapshot collection',()=>{
 const calls=[];const present=installationPresent({prefix:'fixture',volumePrefix:'fixture_data'},(_command,args)=>{calls.push(args);return args.at(-1)==='fixture-falkordb'?{status:0,stdout:'[]'}:{status:1,stderr:'No such container'}})
 assert.equal(present,true);assert.ok(calls.every(args=>!args.at(-1).startsWith('persistent-memory')))
 assert.throws(()=>installationPresent({prefix:'fixture',volumePrefix:'fixture_data'},()=>({status:1,stderr:'daemon unreachable'})))
})
