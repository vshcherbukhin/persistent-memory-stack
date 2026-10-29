import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { parseStorageArguments, prepareFalkorStorage, storageConfiguration } from './prepare-falkordb-storage.mjs'

const oldId = 'a'.repeat(64), replacementId = 'b'.repeat(64), oldImage = `sha256:${'c'.repeat(64)}`, helperImage = `sha256:${'d'.repeat(64)}`
const envPath = resolve('fixture-install/.env.persistent-memory')
const hash = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' })

function fixture({ dataDir = '/var/lib/falkordb/data', absent = false, nonempty = false, copyFails = false,
  stopStaysRunning = false, exitCode = 0, targetRaces = false, volumeOverrides = {}, containerOverrides = {},
  artifact = null, pristineArtifact = artifact, extraEntries = false } = {}) {
  const files = new Map([[envPath, 'PM_CONTAINER_PREFIX=owned-pm\nPM_VOLUME_PREFIX=owned_pm\nCOMPOSE_PROJECT_NAME=owned-project\nFALKORDB_PASSWORD=host-secret-must-never-leave-env\n']])
  const dirs = new Set([dirname(envPath)]), calls = [], mutations = [], order = []
  const original = { Id: oldId, Image: oldImage, Name: '/owned-pm-falkordb', State: { Running: true, ExitCode: 0 },
    Config: { Labels: { 'com.docker.compose.service': 'falkordb', 'com.docker.compose.project': 'owned-project' } },
    Mounts: [{ Type: 'volume', Name: 'owned_pm_falkordb_data', Destination: '/data', RW: true }], ...containerOverrides }
  const state = { original, absent, nonempty: nonempty || Boolean(artifact), copied: false, artifact: artifact ? clone(artifact) : null }
  const sourceContents = { 'dump.rdb':'synthetic Redis RDB bytes',
    'appendonlydir/appendonly.aof.1.base.rdb':'synthetic AOF base bytes',
    'appendonlydir/appendonly.aof.manifest':'file appendonly.aof.1.base.rdb seq 1 type b\n' }
  const referenceManifest = Object.entries(sourceContents).map(([path,bytes])=>`${hash(bytes)}  ./${path}`).join('\n')
    +'\n\n__PM_FILE_METADATA__\n41c0 1000 1000 .\n41c0 1000 1000 ./appendonlydir\n'
    +Object.keys(sourceContents).map(path=>`8180 1000 1000 ./${path}`).join('\n')+'\n'
  const io = {
    async readFile(path) { if (!files.has(path)) throw missing(); return files.get(path) },
    async mkdir(path, options = {}) { mutations.push(['mkdir',path,options]); if (dirs.has(path) && !options.recursive) throw Object.assign(new Error('exists'),{code:'EEXIST'}); dirs.add(path) },
    async realpath(path) { if (!dirs.has(path) && !files.has(path)) throw missing(); return path },
    async writeFile(path, value, options = {}) { mutations.push(['write',path,options]); order.push(`write:${path.split(/[\\/]/).at(-1)}`); if(options.flag==='wx' && files.has(path)) throw new Error('exclusive write conflict'); files.set(path,value) },
    async appendFile(path,value,options) { mutations.push(['append',path,options]); files.set(path,(files.get(path)??'')+value) },
    async chmod(path,mode) { mutations.push(['chmod',path,mode]) },
    async hashFile(path) { if(!files.has(path))throw missing(); return hash(files.get(path)) },
    async stat(path) { if(!files.has(path))throw missing(); return {size:Buffer.byteLength(files.get(path))} },
  }
  const ok = stdout => ({ status:0,stdout:stdout??'',stderr:'' })
  const docker = (args,options={}) => {
    calls.push([...args]); order.push(args[0])
    if(args[0]==='inspect') {
      if(state.absent || ![oldId,'owned-pm-falkordb'].includes(args.at(-1))) return {status:1,stdout:'',stderr:'Error: No such object'}
      return ok(JSON.stringify([state.original]))
    }
    if(args[0]==='exec') return ok(`dir\n${dataDir}\n`)
    if(args[0]==='volume') return ok(JSON.stringify([{Name:'owned_pm_falkordb_data',Driver:'local',Labels:{'com.docker.compose.project':'owned-project'},...volumeOverrides}]))
    if(args[0]==='image') return ok(JSON.stringify([{Id:helperImage}]))
    if(args[0]==='kill') { if(!stopStaysRunning){state.original.State.Running=false;state.original.State.ExitCode=exitCode} return ok() }
    if(args[0]==='start') { state.original.State.Running=true; return ok() }
    if(args[0]==='cp') { files.set(options.stdoutPath,'synthetic-complete-rdb-and-aof-archive'); return ok() }
    if(args[0]==='run') {
      const script=args.at(-1)
      if(script.endsWith("stat -c '%f %u %g' /target/data") || script.endsWith("stat -c '%f %u %g' /data/data")) {
        const candidate=args.includes('--entrypoint=sh') ? pristineArtifact : state.artifact
        if(!candidate || candidate.type!=='link' || extraEntries)return {status:42,stdout:'',stderr:''}
        return ok(`${candidate.target}\n${candidate.mode} ${candidate.uid} ${candidate.gid}\n`)
      }
      if(script==='tar -tf /backup/data.tar')return ok('./\n./dump.rdb\n./appendonlydir/\n./appendonlydir/appendonly.aof.1.base.rdb\n./appendonlydir/appendonly.aof.manifest\n')
      if(script.includes('tar -xpf')&&script.includes('-C /scratch'))return ok(referenceManifest)
      if(script.includes('tar -xpf')&&script.includes('-C /target')) {
        if(targetRaces){state.nonempty=true;return {status:42,stdout:'',stderr:''}}
        state.copied=true;state.nonempty=true
        if(copyFails)return {status:1,stdout:'',stderr:'private diagnostic host-secret-must-never-leave-env'}
        return ok(referenceManifest)
      }
      return state.nonempty ? {status:42,stdout:'',stderr:''} : ok()
    }
    throw new Error(`Unexpected Docker operation ${args[0]}`)
  }
  const options={envPath,docker,io,now:()=>new Date('2026-10-27T12:00:00Z'),nonce:()=> 'fixture',sleep:async()=>{},stopPolls:3}
  return {options,files,dirs,calls,mutations,order,state,io,docker}
}
const failsWith = code => error => { assert.equal(error.code,code); assert.doesNotMatch(error.message,/host-secret/); return true }
const writes = value => value.calls.filter(args=>['kill','start','cp','run'].includes(args[0]))

test('default check queries the container environment and makes no writes', async () => {
  const f=fixture();const result=await prepareFalkorStorage(f.options)
  assert.equal(result.status,'migration_required');assert.equal(result.containerId,oldId)
  assert.deepEqual(writes(f),[]);assert.deepEqual(f.mutations,[])
  const command=f.calls.find(args=>args[0]==='exec')
  assert.deepEqual(command.slice(0,4),['exec',oldId,'sh','-eu'])
  assert.match(command.at(-1),/REDISCLI_AUTH="\$FALKORDB_PASSWORD" redis-cli --raw CONFIG GET dir/)
  assert.doesNotMatch(JSON.stringify(f.calls),/host-secret|--pass|"-a"/)
})

test('absent container and already-mounted storage are repeatable no-ops', async () => {
  for(const init of [{absent:true},{dataDir:'/data'},{dataDir:'/data/'}]) {
    const f=fixture(init)
    for(let i=0;i<2;i++)assert.equal((await prepareFalkorStorage({...f.options,prepare:true})).status,'noop')
    assert.deepEqual(writes(f),[]);assert.deepEqual(f.mutations,[])
  }
})

test('namespace values are literal, validated and unique', () => {
  const config=storageConfiguration('PM_CONTAINER_PREFIX="task-pm"\nPM_VOLUME_PREFIX=task_pm\n',envPath)
  assert.equal(config.containerName,'task-pm-falkordb');assert.equal(config.volumeName,'task_pm_falkordb_data')
  for(const text of ['PM_CONTAINER_PREFIX=$(evil)','PM_VOLUME_PREFIX=../../other','COMPOSE_PROJECT_NAME=bad/name','PM_CONTAINER_PREFIX=x\nPM_CONTAINER_PREFIX=y']) {
    assert.throws(()=>storageConfiguration(text,envPath),failsWith('invalid_environment'))
  }
})

test('wrong container name, service, project and named mount refuse before mutation', async () => {
  const cases=[
    {Name:'/some-other-falkordb'},
    {Config:{Labels:{'com.docker.compose.service':'api','com.docker.compose.project':'owned-project'}}},
    {Config:{Labels:{'com.docker.compose.service':'falkordb','com.docker.compose.project':'foreign'}}},
    {Mounts:[{Type:'bind',Name:'owned_pm_falkordb_data',Destination:'/data',RW:true}]},
    {Mounts:[{Type:'volume',Name:'foreign_data',Destination:'/data',RW:true}]},
    {Mounts:[{Type:'volume',Name:'owned_pm_falkordb_data',Destination:'/data',RW:false}]},
  ]
  for(const containerOverrides of cases) {
    const f=fixture({containerOverrides})
    await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),error=>/^(container_ownership|storage_mount)_conflict$/.test(error.code))
    assert.deepEqual(writes(f),[]);assert.deepEqual(f.mutations,[])
  }
})

test('unknown and separately mounted legacy source paths refuse automatic migration', async () => {
  const unknown=fixture({dataDir:'/other-directory'})
  await assert.rejects(prepareFalkorStorage({...unknown.options,prepare:true}),failsWith('unrecognized_data_directory'))
  assert.deepEqual(writes(unknown),[])
  const mounted=fixture();mounted.state.original.Mounts.push({Type:'volume',Name:'other',Destination:'/var/lib/falkordb',RW:true})
  await assert.rejects(prepareFalkorStorage({...mounted.options,prepare:true}),failsWith('legacy_source_mount_conflict'))
  assert.deepEqual(writes(mounted),[])
})

test('stopped originals and nonempty target volumes remain untouched', async () => {
  const stopped=fixture();stopped.state.original.State.Running=false
  await assert.rejects(prepareFalkorStorage({...stopped.options,prepare:true}),failsWith('original_not_running'))
  assert.deepEqual(writes(stopped),[])
  const f=fixture({nonempty:true})
  await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('target_not_empty'))
  assert.equal(f.state.original.State.Running,true);assert.equal(f.state.nonempty,true)
  assert.ok(!f.calls.some(args=>['kill','cp','start'].includes(args[0])));assert.deepEqual(f.mutations,[])
})

test('foreign or nonlocal volumes refuse preparation', async () => {
  for(const volumeOverrides of [{Name:'foreign'},{Driver:'remote'},{Labels:{'com.docker.compose.project':'foreign'}}]) {
    const f=fixture({volumeOverrides})
    await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('storage_volume_conflict'))
    assert.deepEqual(writes(f),[]);assert.deepEqual(f.mutations,[])
  }
})

test('successful preparation cleanly stops exact ID, preserves full archive and leaves it stopped', async () => {
  const f=fixture();const result=await prepareFalkorStorage({...f.options,prepare:true})
  assert.equal(result.status,'prepared');assert.equal(result.originalStopped,true);assert.equal(f.state.original.State.Running,false)
  assert.ok(f.order.indexOf('write:receipt.json')<f.order.indexOf('kill'))
  assert.ok(f.order.indexOf('kill')<f.order.indexOf('cp'))
  assert.deepEqual(f.calls.find(args=>args[0]==='kill'),['kill','--signal=SIGTERM',oldId])
  assert.deepEqual(f.calls.find(args=>args[0]==='cp'),['cp',`${oldId}:/var/lib/falkordb/data/.`,'-'])
  assert.ok(!f.calls.some(args=>args[0]==='start'))
  const receipt=JSON.parse(f.files.get(result.receiptPath)), folder=dirname(result.receiptPath)
  assert.equal(receipt.containerId,oldId);assert.equal(receipt.imageId,oldImage);assert.equal(receipt.volumeName,'owned_pm_falkordb_data')
  const backup=JSON.parse(f.files.get(resolve(folder,'backup-manifest.json')))
  assert.equal(backup.archiveSha256,hash(f.files.get(receipt.archivePath)))
  assert.ok(backup.entries.some(path=>path.endsWith('appendonly.aof.manifest')))
  const copied=JSON.parse(f.files.get(resolve(folder,'copy-manifest.json')))
  assert.equal(copied.files.length,3);assert.equal(copied.archiveSha256,backup.archiveSha256)
  for(const command of f.calls.filter(args=>args[0]==='run')) {
    assert.ok(command.includes('--network=none'));assert.ok(command.includes('--read-only'));assert.ok(command.includes('--pull=never'))
    assert.ok(!command.some(arg=>arg.includes('docker.sock')))
  }
  assert.equal(backup.files[0].sha256,hash('synthetic Redis RDB bytes'))
  assert.equal(backup.metadata.length,5)
  const source=f.calls.find(args=>args.at(-1).includes('-C /scratch'))
  assert.ok(source.includes('--tmpfs'));assert.ok(source.some(arg=>/^\/scratch:rw,size=\d+,mode=0700$/.test(arg)))
  assert.ok(!source.some(arg=>arg.includes('target=/target')))
  const copy=f.calls.find(args=>args.at(-1).includes('-C /target'))
  assert.ok(copy.some(arg=>arg.endsWith('target=/backup/data.tar,readonly')))
  assert.ok(copy.includes('type=volume,source=owned_pm_falkordb_data,target=/target'))
  assert.match(copy.at(-1),/^test -z .*exit 42; tar -xpf/)
  assert.ok(copy.includes('--cap-add=CHOWN'));assert.ok(copy.includes('--cap-add=FOWNER'))
  assert.ok(f.mutations.filter(op=>op[0]==='write').every(op=>op[2].flag==='wx'&&op[2].mode===0o600))
})

test('copy failure resumes exact old ID and preserves partial target and all backup artifacts', async () => {
  const f=fixture({copyFails:true});let failure
  await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),error=>{failure=error;return failsWith('volume_copy_failed')(error)})
  assert.equal(failure.recovery,'resumed');assert.equal(f.state.original.State.Running,true)
  assert.equal(f.state.nonempty,true);assert.equal(f.state.copied,true)
  assert.ok(f.files.has(failure.receiptPath));assert.ok([...f.files.keys()].some(path=>path.endsWith('data.tar')))
  assert.deepEqual(f.calls.filter(args=>args[0]==='start'),[['start',oldId]])
  assert.ok(!f.calls.some(args=>['rm','rmi','prune'].includes(args[0])||(args[0]==='volume'&&args[1]!=='inspect')))
  const before=f.calls.length
  await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('target_not_empty'))
  assert.ok(!f.calls.slice(before).some(args=>['kill','cp','start'].includes(args[0])))
})

test('target changed at extraction is not overwritten and original is resumed', async () => {
  const f=fixture({targetRaces:true})
  await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('target_not_empty'))
  assert.equal(f.state.copied,false);assert.equal(f.state.nonempty,true);assert.equal(f.state.original.State.Running,true)
})

const imageArtifact={type:'link',target:'/var/lib/falkordb/data',mode:'a1ff',uid:'0',gid:'0'}
test('sole exact original-image copy-up symlink is preserved without overwriting it', async () => {
  const f=fixture({artifact:imageArtifact});const result=await prepareFalkorStorage({...f.options,prepare:true})
  assert.equal(result.status,'prepared');assert.deepEqual(f.state.artifact,imageArtifact)
  const receipt=JSON.parse(f.files.get(result.receiptPath))
  assert.deepEqual(receipt.preservedImageArtifact,{path:'data',target:imageArtifact.target,mode:'a1ff',uid:'0',gid:'0',imageId:oldImage})
  const pristine=f.calls.find(args=>args.includes('--entrypoint=sh'))
  assert.ok(pristine.includes(oldImage));assert.ok(!pristine.includes('--mount'));assert.ok(!pristine.includes('--env-file'))
  const copy=f.calls.find(args=>args.at(-1).includes('-C /target'))
  assert.match(copy.at(-1),/readlink \/target\/data/)
  assert.equal(copy.at(-1).split('stat -c').length,4) // pre-copy link, post-copy link, full source metadata
  const manifest=JSON.parse(f.files.get(resolve(dirname(result.receiptPath),'copy-manifest.json')))
  assert.deepEqual(manifest.preservedImageArtifact,receipt.preservedImageArtifact)
})

test('wrong symlink target, real data file and additional target entry all refuse', async () => {
  for(const init of [{artifact:{...imageArtifact,target:'/other'}},{artifact:{...imageArtifact,type:'file'}},
    {artifact:imageArtifact,extraEntries:true}]) {
    const f=fixture(init)
    await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('target_not_empty'))
    assert.ok(!f.calls.some(args=>['kill','cp','start'].includes(args[0])));assert.deepEqual(f.mutations,[])
  }
})

test('symlink metadata must match the exact pristine original image', async () => {
  for(const artifact of [{...imageArtifact,uid:'1'},{...imageArtifact,gid:'1'},{...imageArtifact,mode:'a1c0'}]) {
    const f=fixture({artifact,pristineArtifact:imageArtifact})
    await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('target_not_empty'))
    assert.ok(!f.calls.some(args=>['kill','cp','start'].includes(args[0])))
  }
})

test('archive cannot overwrite data symlink or write through its prefix', async () => {
  for(const reserved of ['./data','./data/','./data/appendonly.aof']) {
    const f=fixture({artifact:imageArtifact});const docker=(args,options)=>{
      const result=f.docker(args,options)
      if(args.at(-1)==='tar -tf /backup/data.tar')result.stdout+=`${reserved}\n`
      return result
    }
    await assert.rejects(prepareFalkorStorage({...f.options,docker,prepare:true}),failsWith('backup_artifact_conflict'))
    assert.equal(f.state.copied,false);assert.equal(f.state.original.State.Running,true);assert.deepEqual(f.state.artifact,imageArtifact)
  }
})

test('stop timeout never sends SIGKILL or copies data', async () => {
  const f=fixture({stopStaysRunning:true})
  await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('original_stop_timeout'))
  assert.equal(f.state.original.State.Running,true)
  assert.ok(!f.calls.some(args=>args[0]==='cp'||args.includes('SIGKILL')))
})

test('unclean exit refuses copy and restarts original for recovery', async () => {
  const f=fixture({exitCode:137})
  await assert.rejects(prepareFalkorStorage({...f.options,prepare:true}),failsWith('original_unclean_stop'))
  assert.ok(!f.calls.some(args=>args[0]==='cp'));assert.equal(f.state.original.State.Running,true)
})

test('later updater failure can explicitly resume only the saved original ID', async () => {
  const f=fixture();const prepared=await prepareFalkorStorage({...f.options,prepare:true});f.calls.length=0
  const result=await prepareFalkorStorage({...f.options,resumePath:prepared.receiptPath})
  assert.equal(result.status,'resumed');assert.deepEqual(f.calls.filter(args=>args[0]==='start'),[['start',oldId]])
  assert.equal((await prepareFalkorStorage({...f.options,resumePath:prepared.receiptPath})).reason,'original_running')
})

test('absent or replaced original on resume is a safe no-op with no name fallback', async () => {
  for(const replacement of ['absent','new-id','renamed']) {
    const f=fixture();const prepared=await prepareFalkorStorage({...f.options,prepare:true});f.calls.length=0
    if(replacement==='absent')f.state.absent=true
    if(replacement==='new-id')f.state.original.Id=replacementId
    if(replacement==='renamed')f.state.original.Name='/old-renamed-container'
    const result=await prepareFalkorStorage({...f.options,resumePath:prepared.receiptPath})
    assert.equal(result.status,'noop');assert.ok(!f.calls.some(args=>args[0]==='start'))
    assert.ok(f.calls.every(args=>args[0]==='inspect'&&args.at(-1)===oldId))
  }
})

test('foreign receipt and changed service ownership cannot restart anything', async () => {
  const f=fixture();const prepared=await prepareFalkorStorage({...f.options,prepare:true});f.calls.length=0
  const receipt=JSON.parse(f.files.get(prepared.receiptPath));receipt.volumeName='foreign';f.files.set(prepared.receiptPath,JSON.stringify(receipt))
  await assert.rejects(prepareFalkorStorage({...f.options,resumePath:prepared.receiptPath}),failsWith('recovery_receipt_invalid'))
  assert.deepEqual(f.calls,[])
  receipt.volumeName='owned_pm_falkordb_data';f.files.set(prepared.receiptPath,JSON.stringify(receipt))
  f.state.original.Config.Labels['com.docker.compose.service']='api'
  await assert.rejects(prepareFalkorStorage({...f.options,resumePath:prepared.receiptPath}),failsWith('container_ownership_conflict'))
  assert.ok(!f.calls.some(args=>args[0]==='start'))
})

test('unsafe backup archive paths refuse before extraction and recover original', async () => {
  const f=fixture();const docker=(args,options)=>args.at(-1)==='tar -tf /backup/data.tar'
    ? {status:0,stdout:'../../outside\n',stderr:''}:f.docker(args,options)
  await assert.rejects(prepareFalkorStorage({...f.options,docker,prepare:true}),failsWith('backup_archive_invalid'))
  assert.equal(f.state.copied,false);assert.equal(f.state.original.State.Running,true)
})

test('an incomplete copied hash inventory cannot certify a successful migration', async () => {
  const f=fixture();const docker=(args,options)=>{
    const result=f.docker(args,options)
    if(args.at(-1).includes('-C /target'))result.stdout=`${hash('synthetic Redis RDB bytes')}  ./dump.rdb\n`
    return result
  }
  await assert.rejects(prepareFalkorStorage({...f.options,docker,prepare:true}),failsWith('copy_verification_failed'))
  assert.equal(f.state.original.State.Running,true);assert.equal(f.state.nonempty,true)
})

test('wrong target bytes with identical paths and counts fail trusted archive comparison', async () => {
  const f=fixture();const docker=(args,options)=>{
    const result=f.docker(args,options)
    if(args.at(-1).includes('-C /target'))result.stdout=result.stdout.replace(hash('synthetic Redis RDB bytes'),hash('corrupted target bytes'))
    return result
  }
  await assert.rejects(prepareFalkorStorage({...f.options,docker,prepare:true}),failsWith('copy_verification_failed'))
  assert.equal(f.state.original.State.Running,true);assert.equal(f.state.nonempty,true)
  assert.ok(![...f.files.keys()].some(path=>path.endsWith('copy-manifest.json')))
})

test('wrong target modes or UID/GID fail even when all bytes match', async () => {
  for(const replacement of ['8180 999 1000 ./dump.rdb','81a4 1000 1000 ./dump.rdb','8180 1000 999 ./dump.rdb']) {
    const f=fixture();const docker=(args,options)=>{
      const result=f.docker(args,options)
      if(args.at(-1).includes('-C /target'))result.stdout=result.stdout.replace('8180 1000 1000 ./dump.rdb',replacement)
      return result
    }
    await assert.rejects(prepareFalkorStorage({...f.options,docker,prepare:true}),failsWith('copy_verification_failed'))
    assert.equal(f.state.original.State.Running,true)
  }
})

test('readiness check blocks legacy recreation while absent and mounted storage pass without writes', async () => {
  const legacy=fixture()
  await assert.rejects(prepareFalkorStorage({...legacy.options,requireReady:true}),error=>{
    assert.equal(error.code,'legacy_graph_update_required');assert.match(error.message,/npm run update-persistent-memory/);return true
  })
  assert.deepEqual(writes(legacy),[]);assert.deepEqual(legacy.mutations,[])
  for(const init of [{absent:true},{dataDir:'/data'}]){
    const f=fixture(init);assert.equal((await prepareFalkorStorage({...f.options,requireReady:true})).status,'noop')
    assert.deepEqual(writes(f),[]);assert.deepEqual(f.mutations,[])
  }
})

test('CLI rejects missing/ambiguous options and never implies preparation', () => {
  assert.deepEqual(parseStorageArguments([]),{})
  assert.deepEqual(parseStorageArguments(['--require-ready']),{requireReady:true})
  assert.deepEqual(parseStorageArguments(['--resume','receipt.json','--env-file','fixture.env']),{resumePath:'receipt.json',envPath:'fixture.env'})
  for(const args of [['--resume'],['--env-file','--prepare'],['--prepare','--prepare'],['--require-ready','--require-ready'],['--unknown']])assert.throws(()=>parseStorageArguments(args),failsWith('invalid_arguments'))
})
