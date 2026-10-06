const test = require('node:test'), assert = require('node:assert/strict');
const load = () => import('../src/js/local-stages.mjs');
const refs = [
  { kind: 'face', person: 1, url: 'authoritative-face' },
  { kind: 'scene', url: 'scene-reference' },
  { kind: 'clothing', person: 1, url: 'clothing-reference' },
];
test('local stages defer authoritative identity until after clothing and scene', async () => {
  const { buildLocalStages } = await load();
  const steps = buildLocalStages({ text: 'portrait', people: [{ id: 1 }], poseImage: 'pose', references: refs, scene: true, identity: 'keep the mole' });
  assert.deepEqual(steps.map(step => step.kind), ['body', 'clothing', 'scene', 'face']);
  assert.deepEqual(steps.map(step => step.reference), ['pose', 'clothing-reference', 'scene-reference', 'authoritative-face']);
  assert.ok(steps[3].prompt.includes('图片 1') && steps[3].prompt.includes('图片 2') && steps[3].prompt.includes('keep the mole'));
  assert.ok(!steps[0].prompt.includes('唯一权威身份'));
  for (const step of steps.slice(1)) assert.ok(step.prompt.includes('不叠加'));
});
test('missing or disabled references skip edits while body generation remains', async () => {
  const { buildLocalStages } = await load();
  assert.deepEqual(buildLocalStages({ text: 'portrait', people: [], references: refs, face: false, clothing: false }).map(step => step.kind), ['body']);
  assert.equal(buildLocalStages({ text: 'portrait', people: [], scene: true }).length, 1);
});
test('multiple people get separate reference edits and every face follows all other stages', async () => {
  const { buildLocalStages } = await load();
  const steps = buildLocalStages({ text: 'two people', people: [{ id: 1 }, { id: 2 }], references: [...refs, { kind: 'face', person: 2, url: 'face-2' }, { kind: 'clothing', person: 2, url: 'coat-2' }], scene: true });
  assert.deepEqual(steps.map(step => step.kind), ['body', 'clothing', 'clothing', 'scene', 'face', 'face']);
  assert.ok(steps.at(-1).prompt.includes('人偶 2'));
});
test('scene replacement preserves the person without inheriting old background constraints', async () => {
  const { buildLocalStages } = await load();
  const steps = buildLocalStages({ text: 'Keep the plain gray studio background', people: [], references: refs, scene: true, scenePrompt: '泳池与花园，阳光下的池边地面' });
  const scene = steps.find(step => step.kind === 'scene');
  assert.ok(scene.prompt.includes('ENTIRE background') && scene.prompt.includes('泳池与花园'));
  assert.ok(!scene.prompt.includes('唯一构图基础'));
  assert.ok(!scene.prompt.includes('Keep the plain gray studio background'));
  assert.ok(steps.at(-1).prompt.includes('保留工作图的服装、身体动作与背景'));
});
test('body uses isolated text and exact figure count rather than multi-reference final text', async () => {
  const { buildLocalStages } = await load();
  const steps = buildLocalStages({ text: '图片 1 是人脸，图片 2 是服饰，图片 3 是场景，三幅并排', bodyText: '一位穿泳衣的成年人', people: [{ id: 1 }], poseImage: 'pose', references: refs, scene: true });
  assert.ok(steps[0].prompt.includes('Exactly 1 person') && steps[0].prompt.includes('恰好有 1 个人物'));
  assert.ok(!steps[0].prompt.includes('图片 2') && !steps[0].prompt.includes('图片 3') && !steps[0].prompt.includes('三幅并排'));
  assert.ok(steps[0].prompt.includes('一位穿泳衣的成年人'));
  const multi = buildLocalStages({ text: 'group', people: [{ id: 1 }, { id: 2 }], references: refs });
  assert.ok(multi.every(step => step.prompt.includes('Exactly 2 people')));
});
test('body stage turns mannequin pose references into one photorealistic person, not a turnaround sheet', async () => {
  const { buildLocalStages } = await load();
  const [body] = buildLocalStages({ text: '一个穿着蓝色长裙的女人', people: [{ id: 1 }], poseImage: 'mannequin-pose' });
  assert.ok(body.prompt.includes('必须将其转换为一位自然、完整') && body.prompt.includes('真实皮肤质感'));
  assert.ok(body.prompt.includes('不得生成三视图、转面图') && body.prompt.includes('不得输出三视图或多个角度'));
  assert.ok(body.prompt.includes('丢弃人偶的脸、光头、肤色、裸露身体'));
  assert.ok(body.prompt.includes('Exactly 1 person') && body.prompt.includes('禁止重复人物'));
});
