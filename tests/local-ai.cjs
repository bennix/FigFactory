const test=require('node:test'),assert=require('node:assert/strict');
const {buildWorkflow}=require('../src/local-ai.cjs');
const {WeightStore,FILES,selection}=require('../src/local-weights.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
test('local workflow preserves numbered references and uses reference latent',()=>{
 const w=buildWorkflow({prompt:'identity contract',size:'1024x1536',names:{dit:'d',encoder:'e',vae:'v',lora:'turbo.safetensors'},encoder:'te-Q4_K_M',uploaded:['face.png','pose.png','clothing.png','scene.png']});
 assert.deepEqual(w['6'].inputs.latent_image,['4',2]);
 assert.equal(w['2'].class_type,'CLIPLoaderGGUF');
 assert.deepEqual(w['6'].inputs.model,['9',0]);assert.equal(w['6'].inputs.steps,4);assert.equal(w['9'].inputs.strength_model,1);assert.equal(w['4'].inputs.negative_prompt,'');
 for(let i=0;i<4;i++)assert.deepEqual(w['4'].inputs[`images.image_${i+1}`],[String(100+i),0]);
 assert.equal(w['103'].inputs.image,'scene.png');
});
test('Noct-Q V3 Turbo keeps reference images and uses the 6-step sampler without Turbo LoRA',()=>{
 const w=buildWorkflow({prompt:'keep the face',size:'1024x1536',names:{dit:'NoctQ_V3_turbo_int8_convrot.safetensors',encoder:'qwen3vl_8b_int8_convrot.safetensors',vae:'qwen_image_2.1_vae_bf16.safetensors'},encoder:'te-int8-convrot',uploaded:['pose.png','face.png'],profile:'noct'});
 assert.equal(w['1'].class_type,'UNETLoader');
 assert.equal(w['2'].class_type,'CLIPLoader');
 assert.equal(w['6'].inputs.steps,6);assert.equal(w['6'].inputs.cfg,1);
 assert.deepEqual(w['6'].inputs.model,['1',0]);
 assert.deepEqual(w['6'].inputs.latent_image,['4',2]);
 assert.equal(w['4'].inputs.negative_prompt,'');
 assert.deepEqual(w['4'].inputs['images.image_1'],['100',0]);
 assert.deepEqual(w['4'].inputs['images.image_2'],['101',0]);
 assert.equal(w['9'],undefined);
 assert.deepEqual(selection('dit-noct-v3-turbo','te-int8-convrot'),['dit-noct-v3-turbo','te-int8-convrot','vae']);
 assert.throws(()=>selection('dit-noct-v3-turbo','te-Q4_K_M'),/safetensors/);
});
test('Noct-Q V3 model is pinned to the matching public Civitai file metadata',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-noct-civitai-'));
 const metadata={};
 for(const item of FILES.filter(item=>item.repo)){
  metadata[item.repo]??={sha:'a'.repeat(40),siblings:[]};
  metadata[item.repo].siblings.push({rfilename:item.file,lfs:{size:8,sha256:'b'.repeat(64)}});
 }
 fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(metadata));
 const urls=[],store=new WeightStore(root,async url=>{urls.push(url);throw new Error(`unexpected fetch ${url}`);});
 try{
  const catalog=await store.catalog();const model=catalog.find(item=>item.id==='dit-noct-v3-turbo');
  assert.equal(model.size,7256784376);
  assert.equal(model.sha256,'87d7fbf7b2123c26cc7f474a3b77b448e339ee2e3fdd4c8170b93ed8e517ca96');
  assert.equal(model.downloadUrl,'https://civitai.com/api/download/models/3355719?fileId=3243735');
  assert.deepEqual(urls,[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Noct-Q weight download goes directly to its pinned Civitai file and verifies bytes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-noct-download-')),bytes=Buffer.from('12345678'),sha=crypto.createHash('sha256').update(bytes).digest('hex'),metadata={};
 for(const item of FILES.filter(item=>item.repo)){
  metadata[item.repo]??={sha:'a'.repeat(40),siblings:[]};
  metadata[item.repo].siblings.push({rfilename:item.file,lfs:{size:bytes.length,sha256:sha}});
 }
 fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(metadata));
 const noct=FILES.find(item=>item.id==='dit-noct-v3-turbo'),local=noct.local;noct.local={size:bytes.length,sha256:sha};
 const urls=[],store=new WeightStore(root,async(url,options)=>{urls.push([url,options.headers]);return new Response(bytes);});
 try{
  await store.download('dit-noct-v3-turbo','te-int8-convrot',()=>{},true);
  assert.equal(urls[0][0],noct.downloadUrl);assert.deepEqual(urls[0][1],{});
  assert.equal(urls.some(([url])=>url.includes('Noct-Q-Uncensored-Qwen-Image-2.1')),false);
  assert.equal(fs.readFileSync(store.file(noct.id)).toString(),bytes.toString());
  assert.equal(store.verified({...noct,size:bytes.length,sha256:sha}),true);
 }finally{noct.local=local;fs.rmSync(root,{recursive:true,force:true});}
});
test('weight catalog tries the HF mirror before the original site',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-catalog-'));
 const urls=[];
 const body={sha:'a'.repeat(40),siblings:FILES.map(item=>({rfilename:item.file,lfs:{size:8,sha256:'b'.repeat(64)}}))};
 const store=new WeightStore(root,async url=>{urls.push(url);if(url.startsWith('https://hf-mirror.com'))return new Response('nope',{status:502});return new Response(JSON.stringify(body),{status:200});});
 try{const catalog=await store.catalog(true,true);assert.ok(urls[0].startsWith('https://hf-mirror.com/api/models/'));assert.ok(urls.some(url=>url.startsWith('https://huggingface.co/api/models/')));assert.equal(catalog.find(item=>item.id==='dit-noct-v3-turbo').downloaded,false);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('local text generation uses explicit canvas and BF16 loader',()=>{
 const w=buildWorkflow({prompt:'p',size:'1536x1024',names:{lora:'turbo.safetensors'},encoder:'te-bf16',uploaded:[]});
 assert.deepEqual(w['6'].inputs.latent_image,['5',0]);assert.equal(w['2'].class_type,'CLIPLoader');
 assert.throws(()=>selection('missing','te-bf16'));
 assert.deepEqual(selection('dit-Q4_K_M','te-Q4_K_M'),['dit-Q4_K_M','te-Q4_K_M','vision','turbo-lora','vae']);
});
test('weight downloader verifies bytes, resumes ranges and rejects corruption',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-weights-'));
 const bytes=Buffer.from('fixture model bytes'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const metadata={};for(const f of FILES){metadata[f.repo]??={sha:'a'.repeat(40),siblings:[]};metadata[f.repo].siblings.push({rfilename:f.file,lfs:{size:bytes.length,sha256:sha}});}
 fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(metadata));
 let ranges=[];const store=new WeightStore(root,async(url,o)=>{const offset=Number(o.headers.Range?.match(/\d+/)?.[0]||0);ranges.push(offset);return new Response(bytes.subarray(offset),{status:offset?206:200,headers:offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{}});});
 const file=store.file('dit-Q4_K_M');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',bytes.subarray(0,4));fs.writeFileSync(file+'.part.json',JSON.stringify({size:bytes.length,sha256:sha}));
 try{await store.download('dit-Q4_K_M','te-Q4_K_M');assert.equal(ranges[0],4);assert.ok((await store.catalog()).filter(f=>selection('dit-Q4_K_M','te-Q4_K_M').includes(f.id)).every(f=>f.downloaded));
 fs.rmSync(file);store.fetch=async()=>new Response(Buffer.alloc(bytes.length));await assert.rejects(store.download('dit-Q4_K_M','te-Q4_K_M'),/校验失败/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('local HTTP adapter uploads every reference, queues workflow and reads real output bytes',async()=>{
 const {LocalEngine}=require('../src/local-ai.cjs');
 const engine=new LocalEngine('/tmp/unused',{catalog:async()=>selection('dit-Q4_K_M','te-Q4_K_M').map(id=>({id,file:id+'.bin',runnable:true})),verified:()=>true});
 engine.start=async()=>{};engine.port=12345;
 const uploaded=[];let workflow;
 engine.json=async(url,options)=>{
  if(url.endsWith('/object_info'))return Object.fromEntries(['UnetLoaderGGUF','CLIPLoaderGGUF','VAELoader','TextEncodeQwenImage21','KSampler','EmptyLatentImage','VAEDecode','SaveImage','LoraLoaderModelOnly','LoadImage'].map(name=>[name,{input:{required:{unet_name:[['dit-Q4_K_M.bin']],clip_name:[['te-Q4_K_M.bin']],vae_name:[['vae.bin']],lora_name:[['turbo-lora.bin']]}}}]));
  if(url.endsWith('/upload/image')){uploaded.push(Buffer.from(await options.body.get('image').arrayBuffer()));return {name:`ref${uploaded.length}.png`};}
  if(url.endsWith('/prompt')){workflow=JSON.parse(options.body).prompt;return {prompt_id:'job',node_errors:{}};}
  if(url.endsWith('/history/job'))return {job:{status:{status_str:'success'},outputs:{'8':{images:[{filename:'output.png'}]}}}};
  throw new Error('Unexpected endpoint');
 };
 const original=global.fetch;global.fetch=async url=>{assert.ok(url.startsWith('http://127.0.0.1:'));return new Response(Buffer.from('image bytes'));};
 try{
 const result=await engine.generate({prompt:'preserve identity',dit:'dit-Q4_K_M',encoder:'te-Q4_K_M',images:['data:image/png;base64,YQ==','data:image/png;base64,Yg==']});
 assert.deepEqual(uploaded.map(x=>x.toString()),['a','b']);assert.equal(workflow['101'].inputs.image,'ref2.png');assert.equal(result.images[0],'data:image/png;base64,aW1hZ2UgYnl0ZXM=');
 }finally{global.fetch=original;}
});
test('a manually placed file with matching bytes is adopted without downloading it again',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-placed-')),bytes=Buffer.from('placed model bytes'),sha=crypto.createHash('sha256').update(bytes).digest('hex'),metadata={};
 for(const f of FILES){metadata[f.repo]??={sha:'a'.repeat(40),siblings:[]};metadata[f.repo].siblings.push({rfilename:f.file,lfs:{size:bytes.length,sha256:sha}});}fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(metadata));
 const calls=[];const store=new WeightStore(root,async url=>{calls.push(url);return new Response(bytes);});
 const file=store.file('dit-Q4_K_M');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
 try{await store.download('dit-Q4_K_M','te-w4a8');assert.ok(calls.every(url=>!url.includes('qwen-image-2.1-UC-Q4_K_M.gguf')));assert.equal(JSON.parse(fs.readFileSync(file+'.verified.json','utf8')).sha256,sha);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('mirror that ignores Range falls back to original without discarding partial bytes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-mirror-')),bytes=Buffer.from('mirror fixture bytes'),sha=crypto.createHash('sha256').update(bytes).digest('hex'),metadata={};
 for(const f of FILES){metadata[f.repo]??={sha:'a'.repeat(40),siblings:[]};metadata[f.repo].siblings.push({rfilename:f.file,lfs:{size:bytes.length,sha256:sha}});}fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(metadata));
 const calls=[];const store=new WeightStore(root,async(url,o)=>{calls.push([url,o.headers.Range]);if(url.startsWith('https://hf-mirror.com'))return new Response(bytes);const offset=Number(o.headers.Range?.match(/\d+/)?.[0]||0);return new Response(bytes.subarray(offset),{status:offset?206:200,headers:offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{}});});
 const file=store.file('dit-Q4_K_M');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',bytes.subarray(0,5));fs.writeFileSync(file+'.part.json',JSON.stringify({size:bytes.length,sha256:sha}));
 try{await store.download('dit-Q4_K_M','te-Q4_K_M',()=>{},true);assert.equal(calls[0][1],'bytes=5-');assert.ok(calls[1][0].startsWith('https://huggingface.co'));assert.equal(calls[1][1],'bytes=5-');assert.deepEqual(fs.readFileSync(file),bytes);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
