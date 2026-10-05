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
test('mirror that ignores Range falls back to original without discarding partial bytes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-mirror-')),bytes=Buffer.from('mirror fixture bytes'),sha=crypto.createHash('sha256').update(bytes).digest('hex'),metadata={};
 for(const f of FILES){metadata[f.repo]??={sha:'a'.repeat(40),siblings:[]};metadata[f.repo].siblings.push({rfilename:f.file,lfs:{size:bytes.length,sha256:sha}});}fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify(metadata));
 const calls=[];const store=new WeightStore(root,async(url,o)=>{calls.push([url,o.headers.Range]);if(url.startsWith('https://hf-mirror.com'))return new Response(bytes);const offset=Number(o.headers.Range?.match(/\d+/)?.[0]||0);return new Response(bytes.subarray(offset),{status:offset?206:200,headers:offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{}});});
 const file=store.file('dit-Q4_K_M');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',bytes.subarray(0,5));fs.writeFileSync(file+'.part.json',JSON.stringify({size:bytes.length,sha256:sha}));
 try{await store.download('dit-Q4_K_M','te-Q4_K_M',()=>{},true);assert.equal(calls[0][1],'bytes=5-');assert.ok(calls[1][0].startsWith('https://huggingface.co'));assert.equal(calls[1][1],'bytes=5-');assert.deepEqual(fs.readFileSync(file),bytes);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
